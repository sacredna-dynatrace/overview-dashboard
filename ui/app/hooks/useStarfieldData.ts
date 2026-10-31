import { useEffect, useMemo, useRef, useState } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { serviceTagCondition } from "../components/SharedFilters";

/**
 * One request as a point on the Starfield: when it finished and how long it took.
 *
 * This is the one page that reads raw spans. A response-time scatter cannot be drawn from metrics -
 * it needs every request's own duration - so it is a deliberate exception to the topology's
 * metrics-plus-Smartscape rule, and is bounded by a short window and a record cap instead.
 */
export type StarPoint = {
  /** End of the request, epoch ms. */
  end: number;
  ms: number;
  failed: boolean;
  serviceId: string;
  service: string;
  endpoint: string;
  traceId: string;
  spanId: string;
  /**
   * How many real requests this record stands for. Adaptive traffic management samples busy
   * services at the agent, and aggregation folds calls together: on bby34718 half of 19,741 root
   * spans in ten minutes were sampled, up to 512 requests each, for about 265,000 requests in all.
   */
  multiplicity: number;
};

/**
 * The newest records win when the cap is hit, so a long window loses its oldest minutes rather than
 * a random slice. 25,000 covers ten minutes on bby34718 (19,730 records, about 4 s per query).
 */
export const STARFIELD_CAP = 25000;
const QUERY_LIMITS = { maxResultRecords: STARFIELD_CAP, maxResultBytes: 50_000_000 } as const;

/**
 * Live updates re-read this much of the recent past each time, not just what is new since the last
 * one: spans reach Grail late (the newest root span on bby34718 was about 20 s old), and a slow
 * request's span lands well after shorter ones that ended at the same moment.
 */
const LIVE_OVERLAP_MS = 120_000;
/** The right-hand edge where spans are still arriving, shaded while live. */
export const SETTLING_MS = 20_000;

/**
 * Tags filter inside the query, not on the points: filtered afterwards, the cap would already have
 * cut the window to the newest records of every service.
 *
 * Root spans are the requests a caller saw: one per service entry, not the internal hops below it.
 * The multiplicity formula is the platform's own extrapolation (sampling.threshold is a 56-bit
 * rejection threshold), verified on bby34718.
 */
const pointsQuery = (from: string, to: string, tags: string[]) => `fetch spans, from: "${from}", to: "${to}"
| filter request.is_root_span == true
${tags.length > 0 ? `| filter ${serviceTagCondition("dt.entity.service", tags)}\n` : ""}| fieldsAdd multiplicity = coalesce(1 / ((power(2, 56) - coalesce(sampling.threshold, 0)) * power(2, -56)), 1) * coalesce(aggregation.count, 1)
| sort end_time desc
| fields end_time, ms = duration / 1ms, failed = request.is_failed, service_id = dt.entity.service, service = dt.service.name, endpoint = endpoint.name, trace.id, span.id, multiplicity
| limit ${STARFIELD_CAP}`;

type DqlRecord = Record<string, unknown>;
const str = (record: DqlRecord, field: string) => (typeof record[field] === "string" ? record[field] : "");
const num = (record: DqlRecord, field: string) => {
  const value = Number(record[field]);
  return Number.isFinite(value) ? value : 0;
};
const iso = (epoch: number) => new Date(epoch).toISOString();
/** A record read twice by overlapping live queries is the same span: trace and span id identify it. */
const pointId = (point: StarPoint) => `${point.traceId}/${point.spanId}`;

const toPoints = (records: unknown[] | undefined): StarPoint[] => ((records ?? []) as DqlRecord[]).flatMap((record) => {
  const end = Date.parse(str(record, "end_time"));
  if (!Number.isFinite(end)) return [];
  return [{
    end,
    ms: num(record, "ms"),
    failed: record.failed === true,
    serviceId: str(record, "service_id"),
    service: str(record, "service") || str(record, "service_id"),
    endpoint: str(record, "endpoint"),
    traceId: str(record, "trace.id"),
    spanId: str(record, "span.id"),
    multiplicity: Math.max(1, num(record, "multiplicity")),
  }];
});

/**
 * `rangeFrom`/`rangeTo` are the resolved window, epoch ms: a refresh resolves a relative
 * timeframe again, so it is a new full query rather than a cached one.
 *
 * With `liveMs` set and a window that `followsNow`, the window slides: every interval a short query re-reads the last two minutes
 * and its spans are merged in by id, while points older than the window drop off the left. The
 * full window is read only once, on load or refresh. `paused` holds the field still, for a reader
 * looking at a selection.
 *
 * Every update is a billed scan (about 0.1 GiB on bby34718), so updates also stop while the browser
 * tab is hidden. Coming back reads from the last update onwards, so the hidden minutes leave no gap.
 */
export const useStarfieldData = (rangeFrom: number, rangeTo: number, followsNow: boolean, tags: string[], liveMs: number | null, paused: boolean) => {
  const refreshedAt = rangeTo;
  const windowMs = Math.max(1, rangeTo - rangeFrom);
  const base = useDql({ query: pointsQuery(iso(rangeFrom), iso(rangeTo), tags), ...QUERY_LIMITS });

  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // `since` is where an update starts reading: normally two minutes back, but after a pause or a
  // hidden tab, the last update - capped at the window, which is all the field shows.
  const [tick, setTick] = useState({ at: 0, since: 0 });
  const liveTick = tick.at;
  // Read through refs: a refresh must not fire an extra update on top of its own full read.
  const boundsRef = useRef({ refreshedAt, windowMs });
  boundsRef.current = { refreshedAt, windowMs };
  useEffect(() => {
    if (liveMs === null || !followsNow || paused || hidden) return undefined;
    const advance = () => setTick((previous) => {
      const now = Date.now();
      const { refreshedAt: fullReadAt, windowMs: span } = boundsRef.current;
      const last = Math.max(previous.at, fullReadAt);
      return { at: now, since: Math.max(now - span, Math.min(now - LIVE_OVERLAP_MS, last)) };
    });
    // Starting or resuming catches up at once rather than one interval later.
    advance();
    const timer = window.setInterval(advance, liveMs);
    return () => window.clearInterval(timer);
  }, [liveMs, followsNow, paused, hidden]);

  // Live points belong to one full read; a refresh or a new window or filter starts them over.
  const baseKey = `${rangeFrom}|${rangeTo}|${tags.join("\u0000")}`;
  // A past window never slides, whatever an earlier live session left in `tick`.
  const sliding = followsNow && liveTick > refreshedAt;
  const latest = useDql({ query: pointsQuery(iso(tick.since), iso(liveTick), tags), ...QUERY_LIMITS }, { enabled: sliding });
  const [live, setLive] = useState<{ key: string; points: StarPoint[] }>({ key: "", points: [] });
  useEffect(() => {
    if (!latest.data) return;
    const fresh = toPoints(latest.data.records);
    setLive((previous) => {
      const byId = new Map((previous.key === baseKey ? previous.points : []).map((point) => [pointId(point), point]));
      for (const point of fresh) byId.set(pointId(point), point);
      const floor = liveTick - windowMs;
      return { key: baseKey, points: [...byId.values()].filter((point) => point.end >= floor) };
    });
    // Only a new answer merges; the key and window it is read against are the ones current with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest.data]);

  const to = sliding ? liveTick : refreshedAt;
  const from = to - windowMs;
  const basePoints = useMemo(() => toPoints(base.data?.records), [base.data]);
  const points = useMemo<StarPoint[]>(() => {
    const extra = live.key === baseKey ? live.points : [];
    const inWindow = (point: StarPoint) => point.end >= from && point.end <= to;
    if (extra.length === 0) return basePoints.filter(inWindow);
    const byId = new Map(basePoints.map((point) => [pointId(point), point]));
    for (const point of extra) byId.set(pointId(point), point);
    return [...byId.values()].filter(inWindow);
  }, [baseKey, basePoints, from, to, live]);

  const failure = base.error ?? latest.error;
  return {
    points,
    from,
    to,
    isLoading: base.isLoading,
    isUpdating: sliding && latest.isLoading,
    error: failure ? (failure.message || "Query failed") : null,
    truncated: basePoints.length >= STARFIELD_CAP,
  };
};
