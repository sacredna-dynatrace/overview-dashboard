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
   * A read at 1 in N (see `READ_RATIOS`) multiplies it by N.
   */
  multiplicity: number;
  /**
   * The page's own read ratio, kept apart from the agent's sampling: traces the agent dropped were
   * never recorded, but traces this page skipped are stored and can be opened elsewhere.
   */
  readRatio: number;
};

/**
 * The record cap per query. The newest records win when it is hit, so a window that overflows it
 * loses its oldest minutes - which is why a busy window is read at a ratio instead (see below).
 */
export const STARFIELD_CAP = 25000;
const QUERY_LIMITS = { maxResultRecords: STARFIELD_CAP, maxResultBytes: 50_000_000 } as const;

/**
 * Read sampling. A window with more root spans than the cap left its oldest minutes empty (a busy
 * tenant filled 25,000 records in under four minutes). Grail's `samplingRatio` reads 1 trace in N,
 * whole traces only, spread evenly over the window: on bby34718 1 in 10 gave 1,978 records over
 * the full ten minutes, extrapolated to within 11% of the full read, at a sixth of the scan.
 *
 * The ratio comes from a probe read at 1 in 100 (12 MB, 0.04 s for ten minutes on bby34718): the
 * smallest ratio whose expected records fit within 90% of the cap.
 */
const PROBE_RATIO = 100;
const READ_RATIOS = [1, 10, 100, 1000] as const;
const RATIO_BUDGET = STARFIELD_CAP * 0.9;
const chooseRatio = (estimatedRecords: number) => READ_RATIOS.find((ratio) => estimatedRecords / ratio <= RATIO_BUDGET) ?? 1000;

/**
 * Live updates re-read this much of the recent past each time, not just what is new since the last
 * one: spans reach Grail late (the newest root span on bby34718 was about 20 s old), and a slow
 * request's span lands well after shorter ones that ended at the same moment.
 */
const LIVE_OVERLAP_MS = 120_000;
/** The right-hand edge where spans are still arriving, shaded while live. */
export const SETTLING_MS = 20_000;

const tagFilter = (tags: string[]) => (tags.length > 0 ? `| filter ${serviceTagCondition("dt.entity.service", tags)}\n` : "");

/**
 * Tags filter inside the query, not on the points: filtered afterwards, the cap would already have
 * cut the window to the newest records of every service.
 *
 * Root spans are the requests a caller saw: one per service entry, not the internal hops below it.
 * The multiplicity formula is the platform's own extrapolation (sampling.threshold is a 56-bit
 * rejection threshold) times the read ratio, verified on bby34718.
 *
 * `tail` reads only what a sampled read must not thin out: requests at or above the slow floor,
 * and every failed request. The filter does not shrink the scan - that is the whole window either
 * way (562 MB on bby34718) - so failures ride along at no extra cost.
 */
type Tail = { atLeastMs: number | null };
const tailCondition = ({ atLeastMs }: Tail) => (atLeastMs === null ? "request.is_failed == true"
  : `duration >= ${Math.round(atLeastMs)}ms or request.is_failed == true`);
const pointsQuery = (from: string, to: string, tags: string[], ratio: number, tail: Tail | null) => `fetch spans, from: "${from}", to: "${to}"${ratio > 1 ? `, samplingRatio: ${ratio}` : ""}
| filter request.is_root_span == true
${tagFilter(tags)}${tail === null ? "" : `| filter ${tailCondition(tail)}\n`}| fieldsAdd multiplicity = coalesce(1 / ((power(2, 56) - coalesce(sampling.threshold, 0)) * power(2, -56)), 1) * coalesce(aggregation.count, 1) * coalesce(dt.system.sampling_ratio, 1)
| sort end_time desc
| fields end_time, ms = duration / 1ms, failed = request.is_failed, service_id = dt.entity.service, service = dt.service.name, endpoint = endpoint.name, trace.id, span.id, multiplicity, read_ratio = coalesce(dt.system.sampling_ratio, 1)
| limit ${STARFIELD_CAP}`;

/** How many root spans the window holds, and where its slowest 1% starts - read at 1 in 100. */
const probeQuery = (from: string, to: string, tags: string[]) => `fetch spans, from: "${from}", to: "${to}", samplingRatio: ${PROBE_RATIO}
| filter request.is_root_span == true
${tagFilter(tags)}| summarize n = count(), p99 = percentile(duration, 99)
| fieldsAdd p99_ms = p99 / 1ms`;

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
    readRatio: Math.max(1, num(record, "read_ratio")),
  }];
});

const mergeById = (...lists: StarPoint[][]) => {
  const byId = new Map<string, StarPoint>();
  for (const list of lists) for (const point of list) byId.set(pointId(point), point);
  return [...byId.values()];
};

type LivePoints = { key: string; sampled: StarPoint[]; slow: StarPoint[] };

/**
 * `rangeFrom`/`rangeTo` are the resolved window, epoch ms: a refresh resolves a relative
 * timeframe again, so it is a new full query rather than a cached one.
 *
 * A busy window is read at a ratio, and then its slowest 1% (from the probe) and its failures are
 * read again in full: outliers and errors are what this page is for, and at 1 in 10 nine in ten of
 * them would be missing. The field draws sampled points only for fast successful requests.
 *
 * With `liveMs` set and a window that `followsNow`, the window slides: every interval a short query
 * re-reads the last two minutes at the same ratio and floor, merged in by id, while points older
 * than the window drop off the left. The full window is read only once, on load or refresh.
 * `paused` holds the field still, for a reader looking at a selection.
 *
 * Every update is a billed scan (about 0.1 GiB on bby34718), so updates also stop while the browser
 * tab is hidden. Coming back reads from the last update onwards, so the hidden minutes leave no gap.
 */
export const useStarfieldData = (rangeFrom: number, rangeTo: number, followsNow: boolean, tags: string[], liveMs: number | null, paused: boolean) => {
  const refreshedAt = rangeTo;
  const windowMs = Math.max(1, rangeTo - rangeFrom);

  const probe = useDql({ query: probeQuery(iso(rangeFrom), iso(rangeTo), tags) });
  const probeRecord = probe.data?.records?.[0] as DqlRecord | undefined;
  const plan = useMemo(() => {
    if (!probe.data) return null;
    const ratio = chooseRatio(num(probeRecord ?? {}, "n") * PROBE_RATIO);
    const p99 = num(probeRecord ?? {}, "p99_ms");
    // At 1 in 1 nothing is missing, so there is no tail to read again.
    return { ratio, tail: ratio > 1 ? { atLeastMs: p99 > 0 ? p99 : null } : null };
  }, [probe.data, probeRecord]);
  const ratio = plan?.ratio ?? 1;
  const tail = plan?.tail ?? null;
  const slowFloorMs = tail?.atLeastMs ?? null;

  const base = useDql({ query: pointsQuery(iso(rangeFrom), iso(rangeTo), tags, ratio, null), ...QUERY_LIMITS }, { enabled: plan !== null });
  const baseSlow = useDql({ query: pointsQuery(iso(rangeFrom), iso(rangeTo), tags, 1, tail), ...QUERY_LIMITS }, { enabled: tail !== null });

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
  const sliding = followsNow && plan !== null && liveTick > refreshedAt;
  const latest = useDql({ query: pointsQuery(iso(tick.since), iso(liveTick), tags, ratio, null), ...QUERY_LIMITS }, { enabled: sliding });
  const latestSlow = useDql({ query: pointsQuery(iso(tick.since), iso(liveTick), tags, 1, tail), ...QUERY_LIMITS }, { enabled: sliding && tail !== null });
  const [live, setLive] = useState<LivePoints>({ key: "", sampled: [], slow: [] });
  const mergeLive = (part: "sampled" | "slow", records: unknown[] | undefined) => {
    const fresh = toPoints(records);
    setLive((previous) => {
      const current = previous.key === baseKey ? previous : { key: baseKey, sampled: [], slow: [] };
      const floor = liveTick - windowMs;
      return { ...current, [part]: mergeById(current[part], fresh).filter((point) => point.end >= floor) };
    });
  };
  // Only a new answer merges; the key and window it is read against are the ones current with it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (latest.data) mergeLive("sampled", latest.data.records); }, [latest.data]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (latestSlow.data) mergeLive("slow", latestSlow.data.records); }, [latestSlow.data]);

  const to = sliding ? liveTick : refreshedAt;
  const from = to - windowMs;
  const basePoints = useMemo(() => toPoints(base.data?.records), [base.data]);
  const baseSlowPoints = useMemo(() => toPoints(baseSlow.data?.records), [baseSlow.data]);
  const points = useMemo<StarPoint[]>(() => {
    const current = live.key === baseKey ? live : { sampled: [], slow: [] };
    const inWindow = (point: StarPoint) => point.end >= from && point.end <= to;
    const sampled = mergeById(basePoints, current.sampled);
    if (tail === null) return sampled.filter(inWindow);
    // Fast successful requests come from the sampled read, which stands in for the rest; slow and
    // failed ones come from the tail read, where every one of them is.
    const inTail = (point: StarPoint) => point.failed || (tail.atLeastMs !== null && point.ms >= tail.atLeastMs);
    return mergeById(sampled.filter((point) => !inTail(point)), baseSlowPoints, current.slow).filter(inWindow);
  }, [baseKey, basePoints, baseSlowPoints, from, to, live, tail]);

  const failure = probe.error ?? base.error ?? baseSlow.error ?? latest.error ?? latestSlow.error;
  return {
    points,
    from,
    to,
    /** 1 when every trace was read; N when 1 in N was. */
    ratio,
    /** Where the slowest 1% starts, read in full when the window is sampled; null otherwise. */
    slowFloorMs,
    isLoading: probe.isLoading || base.isLoading || baseSlow.isLoading,
    isUpdating: sliding && (latest.isLoading || latestSlow.isLoading),
    error: failure ? (failure.message || "Query failed") : null,
    truncated: basePoints.length >= STARFIELD_CAP || baseSlowPoints.length >= STARFIELD_CAP,
  };
};
