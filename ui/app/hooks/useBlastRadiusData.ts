import { useMemo } from "react";
import type { Timeframe } from "@dynatrace/strato-components/core";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { resolveTimeframe, type ResolvedTimeframe } from "./useTopologyData";

type DqlRecord = Record<string, unknown>;

export type BlastQueryKey = "problems" | "services" | "frontends" | "workloads";

/**
 * How a problem's origin reads, from what Davis recorded (verified on isb54165, 30 days):
 * - `root`: Davis named a root cause (660 of 1,624).
 * - `self`: no root cause and a single affected entity (955 - 99% of the rest). Nothing spread to
 *   it from elsewhere; the problem is that entity's own, so it is drawn as the origin.
 * - `events`: no root cause and several affected entities (about 9). Davis grouped concurrent
 *   events - usually one process failing on several hosts - without linking them causally, so they
 *   are drawn as events around the problem, not as an impact chain.
 */
export type ProblemOrigin = "root" | "self" | "events";

/** One Davis problem, collapsed from its state-change records. */
export type BlastProblem = {
  displayId: string;
  /** What the Problems app opens a problem by (`…V2`), unlike the `P-…` display id. */
  eventId: string;
  title: string;
  category: string;
  active: boolean;
  start: string;
  end: string;
  /** Davis root-cause entity, when the analysis found one (about 40% of problems on the reference tenant). */
  rootId: string | null;
  rootName: string | null;
  /** Entities Davis confirmed as affected, with the names Davis recorded for them. */
  affected: { id: string; name: string }[];
  /**
   * Null when Davis did not estimate it - not the same as zero. Comes from RUM Classic, which the
   * Smartscape FRONTEND nodes and `dt.frontend.*` metrics do not show, so it can be set on a tenant
   * where the topology has no RUM column.
   */
  users: number | null;
  origin: ProblemOrigin;
  /** The entity the rings grow from: the root cause, or the single affected entity of a self problem. */
  originId: string | null;
  originName: string | null;
  /** Distinct hosts Davis attached to the problem, for describing concurrent events. */
  hostCount: number;
};

export type ServiceInfo = { id: string; name: string; type: string; calledBy: string[]; hosts: string[]; pgis: string[] };
export type FrontendCall = { appId: string; appName: string; serviceId: string };

const QUERY_LIMITS = { maxResultRecords: 25000, maxResultBytes: 50_000_000 } as const;
/** A result sitting on its cap was cut off - the same silent-truncation rule as the topology map. */
const PROBLEM_LIMIT = 500;
const SERVICE_LIMIT = 25000;
const FRONTEND_LIMIT = 5000;
const WORKLOAD_LIMIT = 25000;
export const BLAST_CAPS: Record<BlastQueryKey, number> = { problems: PROBLEM_LIMIT, services: SERVICE_LIMIT, frontends: FRONTEND_LIMIT, workloads: WORKLOAD_LIMIT };

const timeWindow = (timeframe: ResolvedTimeframe) => `from: "${timeframe.from}", to: "${timeframe.to}"`;

/**
 * Davis writes one record per state change, so every field is taken from the problem's latest
 * record and the problem is keyed by `display_id`, with duplicates dropped - the same rule the
 * Problems tile uses. Ordered so the problems worth looking at come first: open ones, then the ones
 * that reached the most users and entities.
 */
const problemsQuery = (timeframe: ResolvedTimeframe) => `fetch dt.davis.problems, ${timeWindow(timeframe)}
| filter dt.davis.is_duplicate == false
| summarize {
    event_id = takeLast(event.id), title = takeLast(event.name), category = takeLast(event.category), status = takeLast(event.status),
    start = min(event.start), end = max(event.end),
    root = takeLast(root_cause_entity_id), root_name = takeLast(root_cause_entity_name),
    affected = takeLast(affected_entity_ids), affected_names = takeLast(affected_entity_names),
    users = takeLast(dt.davis.affected_users_count), hosts = takeLast(dt.entity.host)
  }, by: { display_id }
| fieldsAdd host_count = arraySize(arrayDistinct(hosts))
| fieldsAdd n_affected = arraySize(affected), active = status == "ACTIVE"
// Nulls sort first in a descending sort, which put problems without a user estimate on top.
| fieldsAdd users_rank = coalesce(users, 0)
| sort active desc, users_rank desc, n_affected desc, start desc
| limit ${PROBLEM_LIMIT}`;

/**
 * Who calls whom, from the classic entity model.
 *
 * Smartscape has no SERVICE-to-SERVICE \`calls\` edge (see the notes), so \`called_by\` is the only
 * call graph there is. It covers OneAgent services only - an OTLP-only service has no callers here
 * and the rings stop at it. The platform caps very long relationship lists (it warns, it does not
 * fail), so a service with hundreds of callers shows a subset.
 */
const servicesQuery = (timeframe: ResolvedTimeframe) => `fetch dt.entity.service, ${timeWindow(timeframe)}
| fields id, name = entity.name, service_type = serviceType, called_by = called_by[dt.entity.service], hosts = runs_on[dt.entity.host], pgis = runs_on[dt.entity.process_group_instance]
| limit ${SERVICE_LIMIT}`;

/**
 * Classic workload ids to Smartscape ones, for links into the Kubernetes app. Problems name a
 * workload `CLOUD_APPLICATION-…`; the app opens `K8S_DEPLOYMENT-…` (or another kind), and the hex
 * parts differ, so only `id_classic` connects them.
 */
const workloadsQuery = (timeframe: ResolvedTimeframe) => `smartscapeNodes K8S_DEPLOYMENT, K8S_STATEFULSET, K8S_DAEMONSET, K8S_CRONJOB, K8S_JOB, ${timeWindow(timeframe)}
| filter isNotNull(id_classic)
| fields id = toString(id), classic = toString(id_classic)
| limit ${WORKLOAD_LIMIT}`;

/** RUM applications calling services: the outermost ring, where the end users are. */
const frontendsQuery = (timeframe: ResolvedTimeframe) => `smartscapeEdges calls, ${timeWindow(timeframe)}
| filter source_type == "FRONTEND" and target_type == "SERVICE"
| fields app = toString(source_id), svc = toString(target_id)
| lookup [
    smartscapeNodes FRONTEND, ${timeWindow(timeframe)}
    | fields app = toString(id), app_name = name
  ], sourceField: app, lookupField: app, fields: { app_name }
| limit ${FRONTEND_LIMIT}`;

const records = (data: { records?: unknown[] } | undefined): DqlRecord[] =>
  data && Array.isArray(data.records) ? data.records.filter((record): record is DqlRecord => Boolean(record && typeof record === "object")) : [];
const text = (record: DqlRecord, field: string): string => {
  const value = record[field];
  return typeof value === "string" ? value : "";
};
const strings = (record: DqlRecord, field: string): string[] => {
  const value = record[field];
  return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : "")).filter(Boolean) : [];
};
const optionalNumber = (record: DqlRecord, field: string): number | null => {
  const value = record[field];
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const useBlastRadiusData = (timeframe: Timeframe, refreshedAt: number) => {
  const resolved = useMemo(() => resolveTimeframe(timeframe, refreshedAt), [timeframe, refreshedAt]);
  const queries = useMemo<Record<BlastQueryKey, string>>(() => ({
    problems: problemsQuery(resolved),
    services: servicesQuery(resolved),
    frontends: frontendsQuery(resolved),
    workloads: workloadsQuery(resolved),
  }), [resolved]);
  const problems = useDql({ query: queries.problems, ...QUERY_LIMITS });
  const services = useDql({ query: queries.services, ...QUERY_LIMITS });
  const frontends = useDql({ query: queries.frontends, ...QUERY_LIMITS });
  const workloads = useDql({ query: queries.workloads, ...QUERY_LIMITS });

  const problemList = useMemo<BlastProblem[]>(() => records(problems.data).flatMap((record) => {
    const displayId = text(record, "display_id");
    if (!displayId) return [];
    const ids = strings(record, "affected");
    const names = strings(record, "affected_names");
    const affected = ids.map((id, index) => ({ id, name: names[index] || id }));
    const rootId = text(record, "root") || null;
    const rootName = text(record, "root_name") || null;
    const origin: ProblemOrigin = rootId ? "root" : affected.length === 1 ? "self" : "events";
    return [{
      displayId,
      eventId: text(record, "event_id"),
      title: text(record, "title") || displayId,
      category: text(record, "category") || "OTHER",
      active: record.active === true || record.active === "true",
      start: text(record, "start"),
      end: text(record, "end"),
      rootId,
      rootName,
      // Davis records names alongside ids; fall back to the id where it did not.
      affected,
      users: optionalNumber(record, "users"),
      origin,
      originId: origin === "root" ? rootId : origin === "self" ? affected[0].id : null,
      originName: origin === "root" ? rootName : origin === "self" ? affected[0].name : null,
      hostCount: optionalNumber(record, "host_count") ?? 0,
    }];
  }), [problems.data]);

  const serviceMap = useMemo(() => new Map<string, ServiceInfo>(records(services.data).flatMap((record) => {
    const id = text(record, "id");
    return id ? [[id, { id, name: text(record, "name") || id, type: text(record, "service_type"), calledBy: strings(record, "called_by"), hosts: strings(record, "hosts"), pgis: strings(record, "pgis") }] as const] : [];
  })), [services.data]);

  const frontendCalls = useMemo<FrontendCall[]>(() => records(frontends.data).flatMap((record) => {
    const appId = text(record, "app");
    const serviceId = text(record, "svc");
    return appId && serviceId ? [{ appId, appName: text(record, "app_name") || appId, serviceId }] : [];
  }), [frontends.data]);

  /** Classic `CLOUD_APPLICATION-…` to Smartscape workload id. */
  const workloadIds = useMemo(() => new Map<string, string>(records(workloads.data).flatMap((record) => {
    const classic = text(record, "classic");
    const id = text(record, "id");
    return classic && id ? [[classic, id] as const] : [];
  })), [workloads.data]);

  const counts: Record<BlastQueryKey, number> = { problems: records(problems.data).length, services: records(services.data).length, frontends: records(frontends.data).length, workloads: records(workloads.data).length };
  return {
    queries,
    resolved,
    problems: problemList,
    services: serviceMap,
    frontendCalls,
    workloadIds,
    isLoading: problems.isLoading || services.isLoading || frontends.isLoading,
    // Per query, as on the topology page: one failure does not blank the others.
    errors: ([["Problems", problems.error], ["Service call graph", services.error], ["RUM-to-service", frontends.error], ["Workload ids", workloads.error]] as const)
      .flatMap(([label, error]) => (error ? [{ label, message: error.message }] : [])),
    truncated: (Object.keys(counts) as BlastQueryKey[]).filter((key) => counts[key] > 0 && counts[key] >= BLAST_CAPS[key]),
    refetch: async () => { await Promise.all([problems.refetch(), services.refetch(), frontends.refetch(), workloads.refetch()]); },
  };
};

/** Davis display ids look like `P-2610782`; anything else is not interpolated into DQL. */
const DISPLAY_ID = /^P-\d+$/;

/**
 * Davis's own write-up of one problem - root cause, baselines, what else changed - fetched only when
 * a problem is selected. Kept out of the list query: at a few hundred problems the descriptions
 * would dominate the payload for text nobody reads until they open one.
 */
export const useProblemDescription = (displayId: string | null, timeframe: ResolvedTimeframe) => {
  const valid = displayId !== null && DISPLAY_ID.test(displayId);
  const query = valid ? `fetch dt.davis.problems, ${timeWindow(timeframe)}
| filter display_id == "${displayId}" and dt.davis.is_duplicate == false
| sort timestamp desc
| limit 1
| fields description = event.description, impact = dt.davis.impact_level` : "data record(description = \"\")";
  const result = useDql({ query, ...QUERY_LIMITS }, { enabled: valid });
  const record = records(result.data)[0];
  return {
    description: valid && record ? text(record, "description") : "",
    impact: valid && record ? strings(record, "impact") : [],
    isLoading: valid && result.isLoading,
    error: valid ? result.error?.message ?? null : null,
  };
};
