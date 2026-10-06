import { useEffect, useState } from "react";
import { analyzersClient } from "@dynatrace-sdk/client-davis-analyzers";
import type { TopologyNode } from "../components/TopologyGraph";

/**
 * Davis forecast for the selected node's headline metric.
 *
 * This is the one genuinely predictive thing on the page: the analyzer takes a DQL timeseries
 * expression, simulates forward and returns a point estimate with a confidence band. It reads the
 * same metrics the map already uses, so it needs no span or log access - only
 * `davis:analyzers:execute` on top of the metric scopes the app already has.
 *
 * History and horizon are fixed rather than following the page timeframe. Forecasting from
 * "Last 30 minutes" has nothing to learn from, and a horizon that grew with the selected range
 * would silently degrade the forecast's quality the further out the user looked.
 */
const HISTORY = "now()-24h";
const INTERVAL_MINUTES = 10;
const HORIZON_STEPS = 18;
export const FORECAST_HORIZON_HOURS = (INTERVAL_MINUTES * HORIZON_STEPS) / 60;

export type NodeForecast = {
  /** Value at the end of the horizon, and the band around it. */
  predicted: number;
  lower: number;
  upper: number;
  /** Direction across the horizon, taken from the same array so the two ends are comparable. */
  trend: number;
  unit: string;
};

/**
 * The metric each column is measured by, and the dimension that selects one entity out of it.
 * These mirror the inventory queries in `useTopologyData`, so a forecast is always of the number
 * the node already shows rather than of some other metric that happens to exist.
 */
const forecastMetric = (node: TopologyNode): { expression: string; unit: string; perMinute?: boolean } | null => {
  const entity = node.entityId ?? node.id.replace(/^(rum|service|paas|infrastructure)-/, "");
  const series = (metric: string, aggregate: string, dimension: string) =>
    `timeseries value = ${aggregate}(${metric}), by: { ${dimension} }, filter: ${dimension} == "${entity}", from: ${HISTORY}, interval: ${INTERVAL_MINUTES}m`;
  if (node.kind === "infrastructure") return { expression: series("dt.host.cpu.usage", "avg", "dt.entity.host"), unit: "% CPU" };
  // A summed count is per interval bucket, not per minute. Labelling the raw number "req/min"
  // would repeat the unit mix-up the services column already had.
  if (node.kind === "service") return { expression: series("dt.service.request.count", "sum", "dt.entity.service"), unit: "req/min", perMinute: true };
  // A workload node stands for many pods; its members are listed in the panel instead.
  if (node.members) return null;
  // Pods are keyed by name, not by entity id - the container metrics carry no pod entity dimension.
  if (node.kind === "paas") return { expression: `timeseries value = avg(dt.kubernetes.container.cpu_usage), by: { k8s.pod.name }, filter: k8s.pod.name == "${node.name}", from: ${HISTORY}, interval: ${INTERVAL_MINUTES}m`, unit: "mCPU" };
  return null;
};

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.flatMap((item) => (typeof item === "number" && Number.isFinite(item) ? [item] : [])) : [];

const field = (record: unknown, key: string): unknown =>
  record !== null && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined;

// `Array.isArray` on an `unknown` widens the elements to `any`, which the strict rules reject.
const firstOf = (value: unknown): unknown => (Array.isArray(value) && value.length > 0 ? (value[0] as unknown) : undefined);

/**
 * The analyzer answers synchronously when the work is small, and hands back a request token when it
 * is not. Both paths end in the same output array, so the token case just keeps asking.
 */
/** Only the parts of the analyzer response this hook reads; the rest of the payload is ignored. */
type AnalyzerRun = { requestToken?: string; result: { executionStatus: string; output: unknown } };

const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 8;

export const useNodeForecast = (node: TopologyNode | null): { forecast: NodeForecast | null; isLoading: boolean; error: string | null } => {
  const [state, setState] = useState<{ forecast: NodeForecast | null; isLoading: boolean; error: string | null }>({ forecast: null, isLoading: false, error: null });

  useEffect(() => {
    const metric = node ? forecastMetric(node) : null;
    if (!node || !metric) { setState({ forecast: null, isLoading: false, error: null }); return; }
    let cancelled = false;
    setState({ forecast: null, isLoading: true, error: null });

    const analyzerName = "dt.statistics.GenericForecastAnalyzer";
    const body = { timeSeriesData: { expression: metric.expression }, forecastHorizon: HORIZON_STEPS };

    const read = (outputs: unknown): NodeForecast | null => {
      const first = firstOf(outputs);
      if (field(first, "analysisStatus") !== "OK" || field(first, "forecastQualityAssessment") !== "VALID") return null;
      const records = field(field(first, "timeSeriesDataWithPredictions"), "records");
      const record = firstOf(records);
      const point = numbers(field(record, "dt.davis.forecast:point"));
      const lower = numbers(field(record, "dt.davis.forecast:lower"));
      const upper = numbers(field(record, "dt.davis.forecast:upper"));
      if (point.length === 0) return null;
      const scale = (value: number) => (metric.perMinute ? value / INTERVAL_MINUTES : value);
      const last = point[point.length - 1];
      return {
        predicted: scale(last),
        lower: scale(lower[lower.length - 1] ?? last),
        upper: scale(upper[upper.length - 1] ?? last),
        trend: scale(last - point[0]),
        unit: metric.unit,
      };
    };

    const execute = (): Promise<AnalyzerRun> => analyzersClient.executeAnalyzer({ analyzerName, body, timeoutSeconds: 30 });
    const poll = (requestToken: string): Promise<AnalyzerRun> => analyzersClient.pollAnalyzerExecution({ analyzerName, requestToken, timeoutSeconds: 30 });

    const run = async () => {
      let result = await execute();
      for (let attempt = 0; attempt < POLL_ATTEMPTS && result.result.executionStatus === "RUNNING" && result.requestToken; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelled) return;
        result = await poll(result.requestToken);
      }
      if (cancelled) return;
      setState({ forecast: read(result.result.output), isLoading: false, error: null });
    };

    // A forecast is an extra, not the page: a failure here must not touch the rest of the panel.
    run().catch((cause: unknown) => {
      if (cancelled) return;
      setState({ forecast: null, isLoading: false, error: cause instanceof Error ? cause.message : "Forecast unavailable" });
    });
    return () => { cancelled = true; };
  }, [node]);

  return state;
};
