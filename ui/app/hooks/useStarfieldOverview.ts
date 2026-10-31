import { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";

/** One overview bucket: service metrics, so every request counts, sampled or not. */
export type OverviewBucket = { start: number; end: number; requests: number; avgMs: number | null; p95Ms: number | null };

const iso = (epoch: number) => new Date(epoch).toISOString();

/**
 * The trend behind a timeframe too long for the field: requests and response time over the whole
 * range, from which the reader picks the fifteen minutes to draw.
 *
 * Metrics, not spans: on bby34718 seven days of this scanned 0 bytes in 0.26 s, where the same
 * range of spans is hundreds of GiB. Limited to the services in the field - unfiltered, the
 * metric also counts outgoing calls that are services in name only ("Requests to unmonitored
 * hosts": 14.5 million in ten minutes against 17.4 million in all), and the trend would describe
 * a different population from the stars.
 */
const overviewQuery = (from: number, to: number, serviceIds: string[]) => `timeseries {
  requests = sum(dt.service.request.count),
  avg = avg(dt.service.request.response_time),
  p95 = percentile(dt.service.request.response_time, 95)
}, filter: in(dt.entity.service, array(${serviceIds.map((id) => JSON.stringify(id)).join(", ")})), from: "${iso(from)}", to: "${iso(to)}", bins: 240`;

const series = (record: Record<string, unknown>, key: string) => (Array.isArray(record[key]) ? record[key] as unknown[] : []);
const microsToMs = (value: unknown) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value) / 1000);

export const useStarfieldOverview = (from: number, to: number, serviceIds: string[], enabled: boolean) => {
  const result = useDql({ query: overviewQuery(from, to, serviceIds) }, { enabled: enabled && serviceIds.length > 0 });
  const buckets = useMemo<OverviewBucket[]>(() => {
    const record = result.data?.records?.[0] as Record<string, unknown> | undefined;
    if (!record) return [];
    const frame = record.timeframe as { start?: string } | undefined;
    const start = Date.parse(frame?.start ?? "");
    // The interval comes back in nanoseconds.
    const interval = Number(record.interval) / 1_000_000;
    if (!Number.isFinite(start) || !(interval > 0)) return [];
    const avg = series(record, "avg");
    const p95 = series(record, "p95");
    return series(record, "requests").map((count, index) => ({
      start: start + index * interval,
      end: start + (index + 1) * interval,
      requests: Number(count ?? 0) || 0,
      avgMs: microsToMs(avg[index]),
      p95Ms: microsToMs(p95[index]),
    }));
  }, [result.data]);
  return { buckets, isLoading: enabled && result.isLoading, error: result.error ? (result.error.message || "Query failed") : null };
};

/**
 * Days of spans the tenant keeps (default_spans: 10 on bby34718). Read from the bucket table,
 * which scans nothing; probing for the oldest span instead is a scan of every stored day.
 */
export const useSpanRetentionDays = () => {
  const result = useDql({
    query: `fetch dt.system.buckets
| filter dt.system.table == "spans"
| summarize days = max(toLong(retention_days))`,
    filterSegments: [],
  });
  const days = Number((result.data?.records?.[0] as Record<string, unknown> | undefined)?.days);
  return Number.isFinite(days) && days > 0 ? days : null;
};
