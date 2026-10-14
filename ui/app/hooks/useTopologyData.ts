import { useEffect, useMemo, useState } from "react";
import type { Timeframe } from "@dynatrace/strato-components/core";
import { parseTimeAsTimeValue } from "@dynatrace-sdk/units";
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { TopologyEdge, TopologyNode, TopologySort } from "../components/TopologyGraph";

type DqlRecord = Record<string, unknown>;
type TopologyData = { nodes: TopologyNode[]; edges: TopologyEdge[] };
export type TopologyQueryKey = "rum" | "service" | "infrastructure" | "problems" | "serviceProcess" | "pods" | "podInventory" | "podHost" | "podHealth" | "rumService" | "serviceHealth" | "hostHealth" | "rumHealth" | "rumErrors" | "affectedEntities" | "serviceWorkload" | "entryServices" | "serviceProcessTraffic";
export type TopologyQueries = Record<TopologyQueryKey, string>;
/** A query that came back with exactly this many records was almost certainly cut off. */
export type TopologyTruncation = { key: TopologyQueryKey; count: number; cap: number };

/**
 * The query service caps results at 1000 records by default, which would silently truncate the
 * summary tiles long before the entity count becomes a rendering problem. Raised well past the
 * ~10k entities per column this dashboard is expected to handle.
 */
const QUERY_LIMITS = { maxResultRecords: 25000, maxResultBytes: 50_000_000 } as const;

/**
 * The timeframe selector emits its own expression dialect (`@d`, `-1d@d`, `now()-30m`), which DQL
 * does not accept as-is - `from: @d` is not a valid time expression. Every bound is therefore
 * resolved to an absolute ISO timestamp against `relativeTo`, the instant of the last refresh.
 * That also makes the timeframe length exact, so the request rates no longer depend on
 * re-parsing the expression with a hand-written regex.
 */
export type ResolvedTimeframe = { from: string; to: string; seconds: number };

/** Latency and failure figures for one service over the selected timeframe. */
export type ServiceHealth = { p50Micros: number; p95Micros: number; requests: number; failures: number; failureRate: number };

/** Headline figures for one RUM application over the selected timeframe. */
export type RumHealth = { users: number; sessions: number; requests: number; durationMillis: number; jsErrors: number; httpErrors: number; otherErrors: number };

/** Pod utilization. Requests and limits are null when the pod declares none. CPU is millicores. */
export type PodHealth = { cpuUsageMcore: number; cpuRequestsMcore: number | null; cpuLimitsMcore: number | null; memoryUsageBytes: number; memoryRequestsBytes: number | null; memoryLimitsBytes: number | null; containersDesired: number; containersRunning: number };

/** Resource usage for one host over the selected timeframe. Network figures are bytes per second. */
export type HostHealth = { cpuPercent: number; memoryPercent: number; diskUsedPercent: number; networkInPerSecond: number; networkOutPerSecond: number };

const resolveBound = (value: Timeframe["from"], relativeTo: number): string =>
  value.type === "iso8601" ? value.absoluteDate : parseTimeAsTimeValue(value.value, relativeTo)?.absoluteDate ?? value.absoluteDate;

export const resolveTimeframe = (timeframe: Timeframe, relativeTo: number): ResolvedTimeframe => {
  const from = resolveBound(timeframe.from, relativeTo);
  const to = resolveBound(timeframe.to, relativeTo);
  return { from, to, seconds: Math.max(1, (Date.parse(to) - Date.parse(from)) / 1000) };
};

const timeWindow = (timeframe: ResolvedTimeframe) => `from: "${timeframe.from}", to: "${timeframe.to}"`;

/**
 * Every query splits by entity. Without a `by:` clause the whole environment collapses into a
 * single record, which is why the summary tiles reported 1 no matter how many entities existed.
 *
 * Each one collapses its series to a scalar with `arraySum`/`arrayAvg` and then projects with
 * `fields`, so the ~120-bucket array never crosses the wire. At 10k entities that is the
 * difference between a couple of megabytes and well over a hundred; the totals are unchanged
 * because the collapse still happens server-side over the full-resolution series.
 */
/**
 * How a query orders its rows before the cap cuts them off.
 *
 * Ordering is normally irrelevant: the inventory queries return every entity, so the map sorts the
 * complete set in the browser and re-running them with a different `sort` would hand back the same
 * records in a different order. It only starts to matter once a query hits its record cap, because
 * then the rows that survive are decided here rather than in the UI. `null` means "nothing was
 * truncated, keep the default ordering" - which is what keeps the sort control instant.
 *
 * Only "value" and "name" can be expressed in these queries. "Problems first" and "Most relationships"
 * rank by data that lives in other queries (open alerts, edges), so they keep the default order and
 * the truncation banner tells the user their ranking may be incomplete.
 */
type QueryOrder = TopologySort | null;
const nodeOrder = (order: QueryOrder) => order === "name" ? "entity_name asc" : "metric_total desc";
const podOrder = (order: QueryOrder) => order === "value" ? "containers desc, pod asc" : "pod asc";

const rumQuery = (timeframe: ResolvedTimeframe, order: QueryOrder) => `timeseries rum_requests = sum(dt.frontend.request.count, default: 0), by: { dt.rum.application.entity }, ${timeWindow(timeframe)}
| fieldsAdd metric_total = arraySum(rum_requests)
| filter metric_total > 0
| fields entity_id = dt.rum.application.entity, entity_name = entityName(dt.rum.application.entity, type: "dt.entity.application"), metric_total
| sort ${nodeOrder(order)}`;

const serviceQuery = (timeframe: ResolvedTimeframe, order: QueryOrder) => `timeseries service_requests = sum(dt.service.request.count, default: 0), by: { dt.entity.service }, ${timeWindow(timeframe)}
| fieldsAdd metric_total = arraySum(service_requests)
| filter metric_total > 0
| fields entity_id = dt.entity.service, entity_name = entityName(dt.entity.service, type: "dt.entity.service"), metric_total
| sort ${nodeOrder(order)}`;

/**
 * Host inventory, keyed on CPU usage.
 *
 * This used to read `dt.host.net.nic.link_util_rx/tx`, which only 2 of this environment's 8 hosts
 * publish - NIC link utilization needs a known link speed, and virtualized or cloud NICs generally
 * do not report one. Every monitored host reports CPU usage, so this matches the host list in the
 * Infrastructure app. The `> 0` filter the other queries use is deliberately absent: an idle host
 * is still a monitored host, and dropping it would reintroduce the same undercount.
 */
const infrastructureQuery = (timeframe: ResolvedTimeframe, order: QueryOrder) => `timeseries host_cpu = avg(dt.host.cpu.usage), by: { dt.entity.host }, ${timeWindow(timeframe)}
| fieldsAdd metric_total = arrayAvg(host_cpu)
| filter isNotNull(metric_total)
| fields entity_id = dt.entity.host, entity_name = entityName(dt.entity.host, type: "dt.entity.host"), metric_total
| sort ${nodeOrder(order)}`;

/**
 * Per-service latency and failure rate for the details panel.
 *
 * `scalar: true` aggregates over the whole window instead of per time bucket. That matters for
 * percentiles: averaging ~120 bucket-level p50s is not the window's p50, and on a low-traffic
 * service where most buckets are empty it is wildly off. Verified against the Services explorer -
 * the scalar form reproduces its p50 column exactly (732 µs, 2.07 ms, 26.68 ms), the averaged
 * form did not.
 *
 * `dt.service.request.response_time` is in microseconds.
 */
const serviceHealthQuery = (timeframe: ResolvedTimeframe) => `timeseries {
    p50 = percentile(dt.service.request.response_time, 50, scalar: true),
    p95 = percentile(dt.service.request.response_time, 95, scalar: true),
    requests = sum(dt.service.request.count, default: 0, scalar: true),
    failures = sum(dt.service.request.failure_count, default: 0, scalar: true)
  }, by: { dt.entity.service }, ${timeWindow(timeframe)}
| fieldsAdd failure_rate = if(requests > 0, (failures * 100.0) / requests, else: 0.0)
| fields entity_id = dt.entity.service, p50, p95, requests, failures, failure_rate`;

/**
 * Per-host resource usage for the details panel. All five metrics are reported by every monitored
 * host, unlike the NIC link-utilization metric this dashboard used to rely on.
 *
 * Disk is taken as `max` across the host's disks - the fullest volume is what matters - while CPU
 * and memory are host-level averages. `dt.host.disk.util_time` is deliberately not included: it
 * reads above 100% on multi-disk hosts here, which would be more confusing than useful.
 * The network metrics are byte counts over the window; the UI divides them into a rate.
 */
const hostHealthQuery = (timeframe: ResolvedTimeframe) => `timeseries {
    cpu = avg(dt.host.cpu.usage, scalar: true),
    memory = avg(dt.host.memory.usage, scalar: true),
    disk_used = max(dt.host.disk.used.percent, scalar: true),
    net_rx = sum(dt.host.net.nic.bytes_rx, default: 0, scalar: true),
    net_tx = sum(dt.host.net.nic.bytes_tx, default: 0, scalar: true)
  }, by: { dt.entity.host }, ${timeWindow(timeframe)}
| fields entity_id = dt.entity.host, cpu, memory, disk_used, net_rx, net_tx`;

/**
 * Per-RUM-application figures for the details panel.
 *
 * `dt.frontend.request.duration` is in milliseconds. The user and session metrics are estimated
 * distinct counts, so they need `countDistinct` rather than a sum.
 */
const rumHealthQuery = (timeframe: ResolvedTimeframe) => `timeseries {
    users = countDistinct(dt.frontend.user.active.estimated_count, scalar: true),
    sessions = countDistinct(dt.frontend.session.active.estimated_count, scalar: true),
    requests = sum(dt.frontend.request.count, default: 0, scalar: true),
    duration = avg(dt.frontend.request.duration, scalar: true)
  }, by: { dt.rum.application.entity }, ${timeWindow(timeframe)}
| filter isNotNull(dt.rum.application.entity)
| fields entity_id = dt.rum.application.entity, users, sessions, requests, duration`;

/**
 * Frontend errors split by type.
 *
 * This scanned `user.events` because the reference environment records no frontend errors, which
 * left the `dt.frontend.error.count` dimensions unconfirmed. A tenant with real error traffic
 * showed `error.type` carrying `exception`, `request` and `csp`, so the metric does the job and
 * the raw event scan is gone.
 *
 * `csp` is why there is a third bucket: anything that is neither a JavaScript exception nor a
 * failed request still counts as an error, and silently dropping it would understate the total.
 */
const rumErrorsQuery = (timeframe: ResolvedTimeframe) => `timeseries e = sum(dt.frontend.error.count, default: 0, scalar: true), by: { dt.rum.application.entity, error.type }, ${timeWindow(timeframe)}
| filter isNotNull(dt.rum.application.entity)
| summarize {
    js_errors = sum(if(error.type == "exception", e, else: 0)),
    http_errors = sum(if(error.type == "request", e, else: 0)),
    other_errors = sum(if(not in(error.type, "exception", "request"), e, else: 0))
  }, by: { entity_id = dt.rum.application.entity }`;

/**
 * Which entities have an open problem, so each summary tile can report its impacted subset and the
 * map can colour a node red.
 *
 * This read `dt.davis.events` and was wrong. That table holds raw Davis events - "Process
 * unavailable", "Monitoring not available" - which carry `event.kind == "DAVIS_EVENT"` and a null
 * `display_id`. Problems live in `dt.davis.problems`. On a 208-host tenant the difference showed up
 * as 2 impacted hosts against the Infrastructure app's 1: three `Process unavailable` events on one
 * node group rolled up to their host and were counted as if the host had a problem.
 *
 * Counting problems instead also makes the tiles agree with each other - every red number is now
 * explained by the problems the Problems tile reports, because both read the same table with the
 * same de-duplication.
 *
 * Two entity references are unioned, both needed to match what the Infrastructure app shows:
 *
 * - `affected_entity_ids` is the entity the problem is raised against.
 * - `dt.entity.host` is the host that entity runs on, which is why a host shows an alert badge for
 *   something raised against a process or OS service on it. Going by affected ids alone missed
 *   kjw-lab-win on the reference tenant, whose two open problems name custom devices and reach the
 *   host only through this field.
 *
 * On `dt.davis.problems` **`dt.entity.host` is already an array**. Wrapping it again with
 * `array(...)` nested it, so `expand` yielded `["HOST-..."]` rather than `HOST-...`, which matched
 * no node and was dropped without an error - the rollup contributed nothing and kjw-lab-win went
 * missing. It has to be concatenated directly.
 *
 * Davis writes one record per state change, so `countDistinct(display_id)` collapses a problem's
 * lifecycle to one. `ACTIVE` is what an alert badge means: a problem that opened and closed inside
 * the window is history, not a current impact.
 */
const affectedEntitiesQuery = (timeframe: ResolvedTimeframe) => `fetch dt.davis.problems, ${timeWindow(timeframe)}
| filter event.status == "ACTIVE" and dt.davis.is_duplicate == false
| fieldsAdd ids = arrayConcat(coalesce(affected_entity_ids, array()), coalesce(dt.entity.host, array()))
| expand ids
| filter isNotNull(ids)
| summarize alerts = countDistinct(display_id, precision: 9), by: { entity_id = toString(ids) }
| sort alerts desc
| limit 25000`;

/** Bounds the two span queries that feed the map's edges. */
const EDGE_LIMIT = 5000;

/**
 * The ceiling each query can return, so a result sitting exactly on it can be reported as
 * truncated. The edge queries cap themselves with `| limit`; everything else runs into the
 * service-side `maxResultRecords`.
 *
 * `EDGE_LIMIT` was 500 and a 546-service tenant sat on it, which truncated the "Most relationships"
 * ranking - degree was being counted from a fraction of the relationships. Edge rows carry a
 * handful of short fields, so 5000 of them is a few hundred KB against a 50 MB ceiling.
 */
const QUERY_CAPS: Record<TopologyQueryKey, number> = {
  rumService: EDGE_LIMIT, pods: EDGE_LIMIT, podHost: EDGE_LIMIT, serviceProcess: EDGE_LIMIT, serviceProcessTraffic: EDGE_LIMIT,
  rum: QUERY_LIMITS.maxResultRecords, service: QUERY_LIMITS.maxResultRecords,
  infrastructure: QUERY_LIMITS.maxResultRecords, problems: QUERY_LIMITS.maxResultRecords,
  podInventory: QUERY_LIMITS.maxResultRecords, podHealth: QUERY_LIMITS.maxResultRecords,
  serviceHealth: QUERY_LIMITS.maxResultRecords, hostHealth: QUERY_LIMITS.maxResultRecords,
  rumHealth: QUERY_LIMITS.maxResultRecords, rumErrors: QUERY_LIMITS.maxResultRecords,
  affectedEntities: QUERY_LIMITS.maxResultRecords,
  serviceWorkload: EDGE_LIMIT, entryServices: QUERY_LIMITS.maxResultRecords,
};

/**
 * Frontend-to-service edges, from the Smartscape graph.
 *
 * Read through `smartscapeEdges`/`smartscapeNodes` rather than the `dt.entity.*` tables. Those
 * tables hold the older entity model, which only contains workloads OneAgent instrumented - an
 * OTLP-only service is absent from them entirely, which is why this used to draw nothing for such
 * services no matter which relationship it asked for.
 *
 * Two details that cost real debugging time:
 *  - These commands default to a narrow window, so the timeframe has to be passed explicitly or
 *    short-lived entities simply are not there.
 *  - `source_id`/`target_id` are entity-id typed. String functions against them fail silently and
 *    return nothing rather than erroring, hence `toString` before any comparison.
 *
 * Names are not resolvable with `entityName` for this model, so they come from node lookups.
 * Smartscape carries no call volume, so these edges are topology only.
 */
const rumServiceQuery = (timeframe: ResolvedTimeframe) => `smartscapeEdges calls, ${timeWindow(timeframe)}
| filter source_type == "FRONTEND" and target_type == "SERVICE"
| fields app = toString(source_id), svc = toString(target_id)
| lookup [
    smartscapeNodes FRONTEND, ${timeWindow(timeframe)}
    | fields app = toString(id), app_name = name, app_classic = toString(id_classic)
  ], sourceField: app, lookupField: app, fields: { app_name, app_classic }
| lookup [
    smartscapeNodes SERVICE, ${timeWindow(timeframe)}
    | fields svc = toString(id), svc_name = name
  ], sourceField: svc, lookupField: svc, fields: { svc_name }
| sort app_name asc, svc_name asc
| limit ${EDGE_LIMIT}`;

/**
 * The Kubernetes layer between services and hosts: which pods serve each service, and what each
 * pod is made of.
 *
 * Walked through Smartscape rather than read off spans, so the cost does not scale with traffic:
 * service - process group instance - container - pod. The container hop is what carries the
 * payload, since `belongs_to` on a container group instance names the pod, cluster, namespace and
 * host all at once.
 *
 * The span version was a full scan of every server span in the window. It also reported a request
 * rate per pod, which this cannot - Smartscape has no volume - so the service-to-pod edge is now
 * placement only. What it gains is pods that are monitored but quiet, which spans never showed.
 *
 * Container counts still come from the Kubernetes metrics via `lookup`, a left outer join: a pod
 * whose cluster publishes no Kubernetes metrics keeps its row with a null count. Counting
 * `k8s.container.name` on spans would undercount, since only containers that emitted a span appear.
 */
/**
 * Every monitored pod, the way `infrastructureQuery` returns every monitored host.
 *
 * The pods column used to be built from the service-to-pod edges, so it only ever held pods that
 * sat in a traced request path - one pod, while the Kubernetes app listed 111. Columns are
 * inventories and edges are relationships; a pod with no traced traffic is still a pod, exactly as
 * an idle host is still a host.
 *
 * `k8s.object` on these nodes is a large JSON blob, so the projection is explicit.
 */
const podInventoryQuery = (timeframe: ResolvedTimeframe, order: QueryOrder) => `smartscapeNodes K8S_POD, ${timeWindow(timeframe)}
| fields pod_id = toString(id), pod = name, cluster = k8s.cluster.name, namespace = k8s.namespace.name, node = k8s.node.name, workload = k8s.workload.name
| filter isNotNull(pod)
| lookup [
    timeseries c = avg(dt.kubernetes.container.cpu_usage, scalar: true), by: { k8s.pod.name, k8s.container.name }, ${timeWindow(timeframe)}
    | summarize containers = countDistinct(k8s.container.name), by: { pod = k8s.pod.name }
  ], sourceField: pod, lookupField: pod, fields: { containers }
| sort ${podOrder(order)}
| limit 25000`;

const podsQuery = (timeframe: ResolvedTimeframe) => `smartscapeEdges runs_on, ${timeWindow(timeframe)}
| filter source_type == "SERVICE" and target_type == "K8S_POD"
| fields service_id = toString(source_id), pod_id = toString(target_id)
| lookup [
    smartscapeNodes SERVICE, ${timeWindow(timeframe)}
    | fields service_id = toString(id), service_name = name
  ], sourceField: service_id, lookupField: service_id, fields: { service_name }
| lookup [
    smartscapeNodes K8S_POD, ${timeWindow(timeframe)}
    | fields pod_id = toString(id), pod = name, cluster = k8s.cluster.name, namespace = k8s.namespace.name, node = k8s.node.name, workload = k8s.workload.name
  ], sourceField: pod_id, lookupField: pod_id, fields: { pod, cluster, namespace, node, workload }
| filter isNotNull(pod)
| lookup [
    timeseries c = avg(dt.kubernetes.container.cpu_usage, scalar: true), by: { k8s.pod.name, k8s.container.name }, ${timeWindow(timeframe)}
    | summarize containers = countDistinct(k8s.container.name), by: { pod = k8s.pod.name }
  ], sourceField: pod, lookupField: pod, fields: { containers }
| sort service_name asc, pod asc
| limit ${EDGE_LIMIT}`;

/**
 * Which host carries each pod.
 *
 * There is no direct pod-to-host edge, so this goes through the container: a container
 * `is_part_of` a pod and `runs_on` a host. Pods also have a `runs_on` edge to K8S_NODE, but a
 * Kubernetes node is a separate entity from the monitored HOST that the infrastructure column is
 * built from, so the container route is the one that lands on the right entity.
 *
 * A pod on an unmonitored node has no such edge and simply stops at the pod, which is honest -
 * there is no host entity to point at.
 */
const podHostQuery = (timeframe: ResolvedTimeframe) => `smartscapeEdges is_part_of, ${timeWindow(timeframe)}
| filter source_type == "CONTAINER" and target_type == "K8S_POD"
| fields container_id = toString(source_id), pod_id = toString(target_id)
| join [
    smartscapeEdges runs_on, ${timeWindow(timeframe)}
    | filter source_type == "CONTAINER" and target_type == "HOST"
    | fields container_id = toString(source_id), host_id = toString(target_id)
  ], on: { container_id }, fields: { host_id }
| filter isNotNull(host_id)
| summarize containers = count(), by: { pod_id, host_id }
| lookup [
    smartscapeNodes K8S_POD, ${timeWindow(timeframe)}
    | fields pod_id = toString(id), pod = name
  ], sourceField: pod_id, lookupField: pod_id, fields: { pod }
| filter isNotNull(pod)
| sort containers desc, pod asc
| limit ${EDGE_LIMIT}`;

/**
 * Pod utilization for the details panel - the summary the Kubernetes app shows on a pod.
 *
 * Only usage and desired-container count are guaranteed, so requests and limits are attached with
 * `lookup` instead of sitting in the same `timeseries` block. A multi-metric `timeseries` block
 * intersects: a pod that declares no CPU limit would drop out of the result entirely rather than
 * come back with a null limit. `nonempty: true` does not help - it is accepted but the row still
 * disappears. Each optional metric therefore gets its own left outer lookup.
 *
 * No `default: 0` anywhere: it fills gap buckets with zeros, and `arrayAvg` then averages those in,
 * which turned a 30 mcore request into 29.75 and a desired count of 1 into 0.99. Letting `arrayAvg`
 * skip nulls returns the configured values exactly.
 *
 * Usage is summed across the pod's containers per bucket, then averaged over time - CPU is in
 * millicores, memory in bytes.
 */
const podUtilizationLookup = (alias: string, metric: string, timeframe: ResolvedTimeframe) => `| lookup [
    timeseries v = sum(${metric}), by: { k8s.pod.name }, ${timeWindow(timeframe)}
    | fields pod = k8s.pod.name, ${alias} = arrayAvg(v)
  ], sourceField: pod, lookupField: pod, fields: { ${alias} }`;

const podHealthQuery = (timeframe: ResolvedTimeframe) => `timeseries {
    cpu_usage = sum(dt.kubernetes.container.cpu_usage),
    memory_usage = sum(dt.kubernetes.container.memory_working_set),
    desired = avg(dt.kubernetes.pod.containers_desired)
  }, by: { k8s.pod.name }, ${timeWindow(timeframe)}
| fields pod = k8s.pod.name,
    cpu_usage_mcore = arrayAvg(cpu_usage),
    memory_usage_bytes = arrayAvg(memory_usage),
    containers_desired = arrayAvg(desired)
${podUtilizationLookup("cpu_requests_mcore", "dt.kubernetes.container.requests_cpu", timeframe)}
${podUtilizationLookup("cpu_limits_mcore", "dt.kubernetes.container.limits_cpu", timeframe)}
${podUtilizationLookup("memory_requests_bytes", "dt.kubernetes.container.requests_memory", timeframe)}
${podUtilizationLookup("memory_limits_bytes", "dt.kubernetes.container.limits_memory", timeframe)}`;

/**
 * Which process each service runs in, and which host carries that process - the placement for
 * services outside Kubernetes.
 *
 * Read from Smartscape: `SERVICE runs_on PROCESS` and `PROCESS runs_on HOST` (both verified on the
 * reference tenant). This replaced a query that tied services to hosts through
 * `dt.process.network.bytes_*`; it only produced an edge where that metric was non-zero, so on a
 * tenant whose hosts did not report it a VM-hosted service had no host at all.
 *
 * The PROCESS node carries its process group, which is what the map groups by, and `id_classic`
 * (`PROCESS_GROUP_INSTANCE-…`), which is what problems name. Smartscape HOST ids equal the classic
 * ones, so hosts join the infrastructure column directly.
 *
 * Smartscape alone misses services: an embedded database service (`[embedded]`, a
 * `DATABASE_SERVICE` inside the Spring Boot process) had no Smartscape edge of any kind, while the
 * classic model still had its `runs_on` process. So the classic `runs_on` is read too, mapped to
 * Smartscape PROCESS ids through `id_classic`, and appended to the Smartscape edges. Dropping the
 * old network-bytes query without this lost that service's only connection.
 *
 * Each process is also followed to its pod (`PROCESS runs_on CONTAINER`, `CONTAINER is_part_of
 * K8S_POD`), so a service running inside a pod is placed on that pod's workload rather than on a
 * process group that would draw the same process a second time.
 *
 * Ordered by the service's request count before the cap, so a truncated result loses the quiet
 * services rather than whichever sort last alphabetically.
 */
const serviceProcessQuery = (timeframe: ResolvedTimeframe) => `fetch dt.entity.service, ${timeWindow(timeframe)}
| fields service_id = id, pgi = runs_on[dt.entity.process_group_instance]
| expand pgi
| filter isNotNull(pgi)
| fields service_id = toString(service_id), process_classic = toString(pgi)
| lookup [
    smartscapeNodes PROCESS, ${timeWindow(timeframe)}
    | fields process_classic = id_classic, process_id = toString(id)
  ], sourceField: process_classic, lookupField: process_classic, fields: { process_id }
| fields service_id, process_id
| append [
    smartscapeEdges runs_on, ${timeWindow(timeframe)}
    | filter source_type == "SERVICE" and target_type == "PROCESS"
    | fields service_id = toString(source_id), process_id = toString(target_id)
  ]
| filter isNotNull(process_id)
| dedup { service_id, process_id }
| lookup [
    smartscapeNodes SERVICE, ${timeWindow(timeframe)}
    | fields service_id = toString(id), service_name = name
  ], sourceField: service_id, lookupField: service_id, fields: { service_name }
| lookup [
    smartscapeNodes PROCESS, ${timeWindow(timeframe)}
    | fields process_id = toString(id), process = name, process_classic = id_classic, pg_id = dt.process_group.id, pg_name = dt.process_group.detected_name, host_name = host.name
  ], sourceField: process_id, lookupField: process_id, fields: { process, process_classic, pg_id, pg_name, host_name }
| filter isNotNull(pg_id)
| lookup [
    smartscapeEdges runs_on, ${timeWindow(timeframe)}
    | filter source_type == "PROCESS" and target_type == "HOST"
    | fields process_id = toString(source_id), host_id = toString(target_id)
  ], sourceField: process_id, lookupField: process_id, fields: { host_id }
| lookup [
    smartscapeEdges runs_on, ${timeWindow(timeframe)}
    | filter source_type == "PROCESS" and target_type == "CONTAINER"
    | fields process_id = toString(source_id), container_id = toString(target_id)
  ], sourceField: process_id, lookupField: process_id, fields: { container_id }
| lookup [
    smartscapeEdges is_part_of, ${timeWindow(timeframe)}
    | filter source_type == "CONTAINER" and target_type == "K8S_POD"
    | fields container_id = toString(source_id), pod_id = toString(target_id)
  ], sourceField: container_id, lookupField: container_id, fields: { pod_id }
| lookup [
    smartscapeNodes K8S_POD, ${timeWindow(timeframe)}
    | fields pod_id = toString(id), pod = name
  ], sourceField: pod_id, lookupField: pod_id, fields: { pod }
| lookup [
    timeseries r = sum(dt.service.request.count, default: 0, scalar: true), by: { dt.entity.service }, ${timeWindow(timeframe)}
    | fields service_id = toString(dt.entity.service), r
  ], sourceField: service_id, lookupField: service_id, fields: { r }
| sort r desc
| limit ${EDGE_LIMIT}`;

/**
 * Requests per service per process group, for the bands into process-group nodes.
 *
 * `dt.service.request.count` carries `dt.process_group.id` (verified). Requests are not filtered by
 * Kubernetes dimensions here. That filter used to keep workload traffic off the process-group bands,
 * but a tenant with OneAgent in containers and no Kubernetes integration has
 * `dt.entity.cloud_application` on every request and no pod on the map - so its requests were
 * dropped from both bands. The map now attaches these rates only to service -> process-group edges
 * it actually drew, and a service placed on a workload never gets one, which keeps a request from
 * being counted twice. Split by `failed` for the same reason as `serviceWorkloadQuery`.
 */
const serviceProcessTrafficQuery = (timeframe: ResolvedTimeframe) => `timeseries requests = sum(dt.service.request.count, default: 0, scalar: true), by: { dt.entity.service, dt.process_group.id, failed }, ${timeWindow(timeframe)}
| filter isNotNull(dt.process_group.id) and requests > 0
| fields service_id = dt.entity.service, pg_id = dt.process_group.id, failed, requests
| sort requests desc
| limit ${EDGE_LIMIT}`;

/**
 * Davis writes one record per problem state change, so a plain `count()` reports lifecycle events
 * rather than problems. This follows the counting pattern used by the Dynatrace problem dashboards:
 * collapse the lifecycle records to one row per `display_id`, drop Davis duplicates, then count.
 *
 * The reference queries run total and active separately and carry a dozen `takeFirst` fields for
 * their table columns. Only `status` and `dt.davis.is_duplicate` affect the two counts, so they are
 * folded into a single query - that halves the work and keeps the two numbers consistent with each
 * other, which two independently timed queries would not guarantee.
 */
const problemsQuery = (timeframe: ResolvedTimeframe) => `fetch dt.davis.problems, ${timeWindow(timeframe)}
| summarize { status = takeFirst(event.status), is_duplicate = takeFirst(dt.davis.is_duplicate) }, by: { display_id }
| filter is_duplicate == false
| summarize { total = count(), active = countIf(status == "ACTIVE") }`;

/**
 * Requests per service per Kubernetes workload - the one hop on the map with a measured volume.
 *
 * Smartscape knows a service runs in a workload but not how much traffic goes there. The service
 * request metric does: it is derived from spans at ingest and carries `k8s.workload.name` with its
 * cluster and namespace, so this is a metric read, not the span scan the notes warn about. Services
 * outside Kubernetes have no workload dimension and drop out here, which is correct - they have no
 * workload edge to weight.
 *
 * Split by the metric's own `failed` dimension as well, so each edge carries its own failure count
 * rather than borrowing the service-wide rate. Splitting rather than a second filtered metric in the
 * same block: a multi-metric `timeseries` intersects, and an edge with no failures would drop out.
 *
 * Not every tenant puts `k8s.workload.name` and `k8s.cluster.name` on this metric. One had only
 * `k8s.namespace.name` plus the classic `dt.entity.cloud_application` (the Deployment) and
 * `dt.entity.kubernetes_cluster`, so every request was filtered out and a service that plainly ran
 * in a workload got a relationship line instead of a band. The classic entities' names are the
 * fallback; on the reference tenant they equal the `k8s.*` values exactly.
 */
const serviceWorkloadQuery = (timeframe: ResolvedTimeframe) => `timeseries requests = sum(dt.service.request.count, default: 0, scalar: true), by: { dt.entity.service, k8s.cluster.name, k8s.namespace.name, k8s.workload.name, dt.entity.cloud_application, dt.entity.kubernetes_cluster, failed }, ${timeWindow(timeframe)}
| fieldsAdd workload = coalesce(k8s.workload.name, entityName(dt.entity.cloud_application, type: "dt.entity.cloud_application"))
| fieldsAdd cluster = coalesce(k8s.cluster.name, entityName(dt.entity.kubernetes_cluster, type: "dt.entity.kubernetes_cluster"))
| filter isNotNull(workload) and requests > 0
| fields service_id = dt.entity.service, cluster, namespace = k8s.namespace.name, workload, failed, requests
| sort requests desc
| limit ${EDGE_LIMIT}`;

/**
 * How many other services call each service, to tell entry points from internal services.
 *
 * Smartscape has no SERVICE-to-SERVICE `calls` edge on the reference tenant (only PROCESS and HOST
 * ones), so this is the one place that still reads the classic entity model. That model only holds
 * OneAgent services, so an OTLP-only service is simply absent. Absent services are still offered to
 * the external-callers node as candidates, marked as such, because otherwise an OTLP-only tenant
 * would never get a front end at all.
 */
const entryServicesQuery = (timeframe: ResolvedTimeframe) => `fetch dt.entity.service, ${timeWindow(timeframe)}
| fields service_id = id, callers = coalesce(arraySize(called_by[dt.entity.service]), 0)
| limit 25000`;

const numeric = (record: DqlRecord, field: string): number => {
  const item = record[field];
  if (typeof item === "number") return item;
  if (Array.isArray(item)) return item.reduce<number>((sum, value: unknown) => sum + (typeof value === "number" ? value : Number(value ?? 0)), 0);
  if (item && typeof item === "object") {
    const objectValue = item as Record<string, unknown>;
    return Number(objectValue.value ?? objectValue.total ?? 0);
  }
  return Number(item ?? 0);
};
const text = (record: DqlRecord, field: string): string => {
  const item = record[field];
  return typeof item === "string" && item.length > 0 ? item : "";
};
const records = (data: { records?: unknown[] } | undefined): DqlRecord[] => {
  if (!data || !Array.isArray(data.records)) return [];
  return data.records.filter((record): record is DqlRecord => Boolean(record && typeof record === "object"));
};
/** A pod's cluster and namespace as shown under its name - also the scope its workload name is unique in. */
const podScope = (cluster: string, namespace: string) => [cluster, namespace].filter(Boolean).join(" · ") || "Kubernetes pod";
const workloadNodeId = (scope: string, workload: string) => `workload-${scope}/${workload}`;
/** Node ids carry a column prefix; the alert map is keyed on the bare Dynatrace entity id. */
const entityIdOf = (nodeId: string) => nodeId.replace(/^(rum|service|paas|infrastructure)-/, "");

const addNode = (nodes: Map<string, TopologyNode>, node: TopologyNode) => {
  const existing = nodes.get(node.id);
  if (existing) existing.value += node.value;
  else nodes.set(node.id, node);
};
/**
 * Endpoints discovered in traces that the metric queries did not report - a host serving traced
 * traffic but publishing no network-utilization metric, for instance. Without this the edge would
 * reference a node that does not exist and silently disappear. Never overwrites a metric-derived
 * node, so the tiles keep the values already reconciled against the Dynatrace UI.
 */
const ensureNode = (nodes: Map<string, TopologyNode>, node: TopologyNode) => {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
};

/**
 * The map's view of the topology: pods folded into the workload that owns them.
 *
 * A Deployment with twelve replicas is one thing to the person reading the map, and drawing it as
 * twelve boxes both filled the ten pod slots with a single service's replicas and fanned its edge
 * out twelve ways. Grouping by `k8s.workload.name` within cluster and namespace keeps the same
 * relationships and turns the fan into one edge labelled with how many pods carry it.
 *
 * Only the map is grouped. The tiles still count pods, and pod utilization stays keyed per pod so
 * the details panel can list a workload's members with their own figures. A pod with no workload
 * (a bare pod, or a cluster that does not report one) stays a pod node of its own.
 */
const groupPodsByWorkload = ({ nodes, edges }: TopologyData): TopologyData => {
  const groupOf = new Map<string, string>();
  const groups = new Map<string, TopologyNode>();
  const mapped: TopologyNode[] = [];
  for (const node of nodes) {
    if (node.kind !== "paas" || !node.workload) { mapped.push(node); continue; }
    // The node's subtitle is already "cluster · namespace", the scope a workload name is unique in.
    const id = workloadNodeId(node.subtitle, node.workload);
    groupOf.set(node.id, id);
    const group = groups.get(id);
    if (group) {
      group.members?.push(node.id);
      group.value += 1;
      group.problems = (group.problems ?? 0) + (node.problems ?? 0);
    } else {
      const created: TopologyNode = { id, name: node.workload, kind: "paas", subtitle: node.subtitle, value: 1, unit: "pods", problems: node.problems ?? 0, workload: node.workload, namespace: node.namespace, members: [node.id] };
      groups.set(id, created);
      mapped.push(created);
    }
  }
  // Edges are folded the same way and deduplicated; the label says how many pods each one stands for.
  const folded = new Map<string, TopologyEdge & { pods: Set<string> }>();
  for (const edge of edges) {
    const source = groupOf.get(edge.source) ?? edge.source;
    const target = groupOf.get(edge.target) ?? edge.target;
    const pod = groupOf.has(edge.source) ? edge.source : groupOf.has(edge.target) ? edge.target : null;
    if (!pod) { folded.set(edge.id, { ...edge, pods: new Set() }); continue; }
    const id = `${edge.kind}:${source}->${target}`;
    const existing = folded.get(id);
    if (existing) existing.pods.add(pod);
    else folded.set(id, { ...edge, id, source, target, pods: new Set([pod]) });
  }
  return {
    nodes: mapped,
    edges: [...folded.values()].map(({ pods, ...edge }) => pods.size > 0 ? { ...edge, label: `${pods.size} pod${pods.size === 1 ? "" : "s"}` } : edge),
  };
};

/**
 * Puts the measured service-to-workload and service-to-process-group request rates onto the map's edges.
 *
 * The rate replaces the zero on the Smartscape edge, or adds the edge when Smartscape missed it but
 * the metric shows traffic. Only edges carrying `req/min` are drawn as Sankey bands, so these are
 * the bands that come from data rather than from a relationship alone.
 */
const addMeasuredTraffic = ({ nodes, edges }: TopologyData, flows: { serviceId: string; targetId: string; perMinute: number; failed: boolean }[]): TopologyData => {
  const known = new Set(nodes.map((node) => node.id));
  const byId = new Map(edges.map((edge) => [edge.id, edge] as const));
  for (const { serviceId, targetId, perMinute, failed } of flows) {
    if (!known.has(serviceId) || !known.has(targetId)) continue;
    const id = `hosting:${serviceId}->${targetId}`;
    const existing = byId.get(id);
    // The failed and successful rows of one edge arrive separately and are summed here.
    const failures = failed ? perMinute : 0;
    byId.set(id, existing
      ? { ...existing, value: (existing.unit === "req/min" ? existing.value : 0) + perMinute, unit: "req/min", failures: (existing.failures ?? 0) + failures }
      : { id, source: serviceId, target: targetId, value: perMinute, unit: "req/min", kind: "hosting", failures });
  }
  return { nodes, edges: [...byId.values()] };
};

/**
 * Process-group nodes for services that run outside Kubernetes.
 *
 * The third column is "where the service runs": a Kubernetes workload when there is one, otherwise
 * the process group. A service that already reaches a workload (by Smartscape or by measured
 * traffic) is skipped - Kubernetes services also have `SERVICE runs_on PROCESS`, and drawing both
 * would place the same service twice. Process groups exist only on the map, so the pod tile is
 * unaffected.
 */
const addProcessGroups = ({ nodes, edges }: TopologyData, placements: DqlRecord[], onWorkload: Set<string>, problemsByEntity: Map<string, number>): TopologyData => {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const placed = new Set([...onWorkload, ...edges.filter((edge) => edge.source.startsWith("service-") && byId.get(edge.target)?.kind === "paas").map((edge) => edge.source)]);
  const existing = new Set(edges.map((edge) => edge.id));
  const workloadOf = new Map(nodes.flatMap((node) => (node.members ?? []).map((member) => [member, node.id] as const)));
  const added = new Map<string, TopologyNode>();
  const edgeProcesses = new Map<string, { edge: TopologyEdge; processes: Set<string>; noun: string }>();
  const link = (source: string, target: string, member: string, noun: string) => {
    const id = `hosting:${source}->${target}`;
    if (existing.has(id)) return;
    const entry = edgeProcesses.get(id) ?? { edge: { id, source, target, value: 0, unit: "", kind: "hosting" }, processes: new Set<string>(), noun };
    entry.processes.add(member);
    edgeProcesses.set(id, entry);
  };
  const ensureService = (serviceId: string, record: DqlRecord) => {
    if (byId.has(serviceId)) return;
    const service: TopologyNode = { id: serviceId, name: text(record, "service_name") || serviceId, kind: "service", subtitle: "Service", value: 0, unit: "req/min" };
    byId.set(serviceId, service);
    added.set(serviceId, service);
  };
  for (const record of placements) {
    const serviceId = `service-${text(record, "service_id")}`;
    const pgId = text(record, "pg_id");
    const processId = text(record, "process_id");
    if (!processId) continue;
    // Inside a pod the map already draws: the workload is where this service runs.
    const pod = text(record, "pod");
    const podNode = pod ? `paas-${pod}` : "";
    const onPod = podNode ? workloadOf.get(podNode) ?? (byId.has(podNode) ? podNode : undefined) : undefined;
    if (onPod) {
      ensureService(serviceId, record);
      link(serviceId, onPod, podNode, "pod");
      continue;
    }
    if (!pgId || placed.has(serviceId)) continue;
    ensureService(serviceId, record);
    const id = `process-group-${pgId}`;
    const classic = text(record, "process_classic");
    let group = byId.get(id);
    if (!group) {
      group = { id, name: text(record, "pg_name") || pgId, kind: "paas", subtitle: "Process group", value: 0, unit: "processes", entityId: pgId, processes: [], problems: problemsByEntity.get(pgId) ?? 0 };
      byId.set(id, group);
      added.set(id, group);
    }
    if (!group.processes?.some((process) => process.id === processId)) {
      const problems = problemsByEntity.get(classic) ?? 0;
      group.processes?.push({ id: processId, classicId: classic, name: text(record, "process") || processId, host: text(record, "host_name"), problems });
      group.value += 1;
      group.problems = (group.problems ?? 0) + problems;
    }
    link(serviceId, id, processId, "process");
    const hostId = text(record, "host_id");
    if (hostId) {
      const host = `infrastructure-${hostId}`;
      if (!byId.has(host)) {
        const node: TopologyNode = { id: host, name: text(record, "host_name") || hostId, kind: "infrastructure", subtitle: "Host", value: 0, unit: "% CPU", problems: problemsByEntity.get(hostId) ?? 0 };
        byId.set(host, node);
        added.set(host, node);
      }
      link(id, host, processId, "process");
    }
  }
  const newEdges = [...edgeProcesses.values()].map(({ edge, processes, noun }) => ({ ...edge, label: `${processes.size} ${noun}${processes.size === 1 ? "" : noun === "process" ? "es" : "s"}` }));
  return { nodes: [...nodes, ...added.values()], edges: [...edges, ...newEdges] };
};

/**
 * A band for a service that runs in exactly one place, when the metric cannot say so itself.
 *
 * The placement bands split `dt.service.request.count` by workload or process group, but that
 * metric does not always carry either: one tenant's VM-hosted Spring Boot service had only the
 * service, `failed`, endpoint and status code, so its one process group got a bare relationship
 * line. When a service has a single placement, every request it served was served there, so the
 * service's own rate is that edge's rate - an inference from the topology rather than a split of
 * the metric, which is why the edge says so (`inferred`). A service with two or more placements
 * is left alone: there is nothing to divide its rate by.
 */
const inferSinglePlacement = ({ nodes, edges }: TopologyData, failureRates: Map<string, number>): TopologyData => {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const placements = new Map<string, TopologyEdge[]>();
  for (const edge of edges) {
    if (!edge.source.startsWith("service-") || byId.get(edge.target)?.kind !== "paas") continue;
    const list = placements.get(edge.source);
    if (list) list.push(edge); else placements.set(edge.source, [edge]);
  }
  const inferred = new Map<string, TopologyEdge>();
  for (const [serviceId, list] of placements) {
    const service = byId.get(serviceId);
    if (list.length !== 1 || !service || service.unit !== "req/min" || service.value <= 0) continue;
    const [edge] = list;
    if (edge.unit === "req/min" && edge.value > 0) continue;
    inferred.set(edge.id, { ...edge, value: service.value, unit: "req/min", failures: service.value * (failureRates.get(serviceId) ?? 0), inferred: true });
  }
  return inferred.size === 0 ? { nodes, edges } : { nodes, edges: edges.map((edge) => inferred.get(edge.id) ?? edge) };
};

/** Id of the stand-in for callers the dashboard cannot see. Never an entity, never counted. */
export const EXTERNAL_CALLERS_ID = "rum-external-callers";

/**
 * A stand-in front end for entry services that no RUM application reaches.
 *
 * Without it the map starts at the services and the traffic seems to come from nowhere. It is
 * attached to services nothing else is known to call - an internal service wired to it would claim
 * outside traffic it does not receive - and only to services with a measured request rate, which
 * for an entry service is exactly what arrives from outside. It is not a user count: batch jobs, API
 * clients and health checks all land here, hence "callers".
 *
 * Services the classic model does not hold (OTLP-only) have no caller data either way. They are
 * included, and their edge says so, because leaving them out left OTLP tenants with no front end.
 * The price is that an internal OTLP service is drawn as if it took outside traffic. Unknown only
 * counts once the callers query has actually answered - while it is loading or after it failed,
 * every service would look unknown and the whole column would be wired to this node.
 */
const addExternalCallers = ({ nodes, edges }: TopologyData, callers: Map<string, number> | null, failureRates: Map<string, number>): TopologyData => {
  if (!callers) return { nodes, edges };
  const reachedByRum = new Set(edges.filter((edge) => edge.source.startsWith("rum-")).map((edge) => edge.target));
  const entries = nodes.filter((node) => node.kind === "service" && node.unit === "req/min" && node.value > 0
    && (callers.get(entityIdOf(node.id)) ?? 0) === 0 && !reachedByRum.has(node.id));
  if (entries.length === 0) return { nodes, edges };
  const external: TopologyNode = {
    id: EXTERNAL_CALLERS_ID, name: "External callers", kind: "rum", subtitle: "No RUM application · entry and OTLP services",
    value: entries.reduce((sum, node) => sum + node.value, 0), unit: "req/min", problems: 0, virtual: true,
  };
  return {
    nodes: [...nodes, external],
    edges: [...edges, ...entries.map((node): TopologyEdge => ({
      id: `${EXTERNAL_CALLERS_ID}-${node.id}`, source: EXTERNAL_CALLERS_ID, target: node.id, value: node.value, unit: "req/min", kind: "call",
      label: callers.has(entityIdOf(node.id)) ? undefined : "callers unknown (OTLP)",
      // Everything an entry service receives comes over this edge, so its failure rate is the edge's.
      failures: node.value * (failureRates.get(node.id) ?? 0),
    }))],
  };
};

export const useTopologyData = (timeframe: Timeframe, refreshedAt: number, sortBy: TopologySort) => {
  // Memoised so a plain re-render cannot mint new query strings and retrigger the queries in a loop.
  const resolved = useMemo(() => resolveTimeframe(timeframe, refreshedAt), [timeframe, refreshedAt]);
  /**
   * Latched on the first time any query comes back at its cap, and never cleared for the life of
   * the hook.
   *
   * While it is off the query strings do not mention `sortBy`, so changing the sort re-renders the
   * map from data already in memory and costs nothing. Once a cap has been hit the browser no
   * longer holds the full population, the top ten can no longer be decided client-side, and the
   * inventory queries start carrying the sort - which means they re-issue when the sort changes.
   * Paying for that on every tenant would make an instant control take seconds for an identical
   * result; paying for it only where the data is genuinely truncated does not.
   */
  const [orderInQuery, setOrderInQuery] = useState(false);
  const order: QueryOrder = orderInQuery ? sortBy : null;
  const queries = useMemo<TopologyQueries>(() => ({
    rum: rumQuery(resolved, order),
    service: serviceQuery(resolved, order),
    infrastructure: infrastructureQuery(resolved, order),
    problems: problemsQuery(resolved),
    serviceProcess: serviceProcessQuery(resolved),
    serviceProcessTraffic: serviceProcessTrafficQuery(resolved),
    pods: podsQuery(resolved),
    podInventory: podInventoryQuery(resolved, order),
    podHost: podHostQuery(resolved),
    podHealth: podHealthQuery(resolved),
    rumService: rumServiceQuery(resolved),
    serviceHealth: serviceHealthQuery(resolved),
    hostHealth: hostHealthQuery(resolved),
    rumHealth: rumHealthQuery(resolved),
    rumErrors: rumErrorsQuery(resolved),
    affectedEntities: affectedEntitiesQuery(resolved),
    serviceWorkload: serviceWorkloadQuery(resolved),
    entryServices: entryServicesQuery(resolved),
  }), [order, resolved]);
  const rum = useDql({ query: queries.rum, ...QUERY_LIMITS });
  const service = useDql({ query: queries.service, ...QUERY_LIMITS });
  const infrastructure = useDql({ query: queries.infrastructure, ...QUERY_LIMITS });
  const problems = useDql({ query: queries.problems, ...QUERY_LIMITS });
  const serviceProcess = useDql({ query: queries.serviceProcess, ...QUERY_LIMITS });
  const serviceProcessTraffic = useDql({ query: queries.serviceProcessTraffic, ...QUERY_LIMITS });
  const pods = useDql({ query: queries.pods, ...QUERY_LIMITS });
  const podInventory = useDql({ query: queries.podInventory, ...QUERY_LIMITS });
  const podHost = useDql({ query: queries.podHost, ...QUERY_LIMITS });
  const podHealth = useDql({ query: queries.podHealth, ...QUERY_LIMITS });
  const rumService = useDql({ query: queries.rumService, ...QUERY_LIMITS });
  const serviceHealth = useDql({ query: queries.serviceHealth, ...QUERY_LIMITS });
  const hostHealth = useDql({ query: queries.hostHealth, ...QUERY_LIMITS });
  const rumHealth = useDql({ query: queries.rumHealth, ...QUERY_LIMITS });
  const rumErrors = useDql({ query: queries.rumErrors, ...QUERY_LIMITS });
  const affectedEntities = useDql({ query: queries.affectedEntities, ...QUERY_LIMITS });
  const serviceWorkload = useDql({ query: queries.serviceWorkload, ...QUERY_LIMITS });
  const entryServices = useDql({ query: queries.entryServices, ...QUERY_LIMITS });
  /**
   * Cluster and container totals for the Kubernetes tile. Deduplicated by pod first: the pods
   * query returns one row per service-pod pair, so a pod serving two services would otherwise have
   * its containers counted twice.
   */
  const kubernetes = useMemo(() => {
    const byPod = new Map<string, { cluster: string; containers: number }>();
    for (const record of records(podInventory.data)) {
      const pod = text(record, "pod");
      if (!pod || byPod.has(pod)) continue;
      byPod.set(pod, { cluster: text(record, "cluster"), containers: numeric(record, "containers") });
    }
    const values = [...byPod.values()];
    return {
      clusters: new Set(values.map((pod) => pod.cluster).filter(Boolean)).size,
      containers: values.reduce((sum, pod) => sum + pod.containers, 0),
    };
  }, [podInventory.data]);
  const problemsByEntity = useMemo(() => new Map<string, number>(records(affectedEntities.data).flatMap((record) => {
    const id = text(record, "entity_id");
    return id ? [[id, numeric(record, "alerts")] as const] : [];
  })), [affectedEntities.data]);
  const data = useMemo<TopologyData>(() => {
    const nodes = new Map<string, TopologyNode>();
    const edges = new Map<string, TopologyEdge>();
    // Request rates are reported per minute so they line up with the throughput column of the
    // Dynatrace Services explorer, where low-traffic services read as 0.01/min rather than 0.00/s.
    const minutes = resolved.seconds / 60;
    for (const record of records(rum.data)) {
      const id = text(record, "entity_id");
      const total = numeric(record, "metric_total");
      if (!id || total <= 0) continue;
      addNode(nodes, { id: `rum-${id}`, name: text(record, "entity_name") || id, kind: "rum", subtitle: "RUM application", value: total / minutes, unit: "req/min" });
    }
    for (const record of records(service.data)) {
      const id = text(record, "entity_id");
      const total = numeric(record, "metric_total");
      if (!id || total <= 0) continue;
      addNode(nodes, { id: `service-${id}`, name: text(record, "entity_name") || id, kind: "service", subtitle: "Service", value: total / minutes, unit: "req/min" });
    }
    for (const record of records(infrastructure.data)) {
      const id = text(record, "entity_id");
      // CPU usage is a percentage, not a request count - dividing it by the window would be wrong.
      // An idle host reports 0 and still belongs on the map, so only a missing id disqualifies it.
      const utilisation = numeric(record, "metric_total");
      if (!id) continue;
      addNode(nodes, { id: `infrastructure-${id}`, name: text(record, "entity_name") || id, kind: "infrastructure", subtitle: "Host CPU usage", value: utilisation, unit: "% CPU" });
    }
    // Edges come from traces. The metric queries above supply the inventory and the rates; only the
    // spans know which service actually called which, and which host carried the work.
        for (const record of records(rumService.data)) {
      const appId = text(record, "app");
      const serviceId = text(record, "svc");
      if (!appId || !serviceId) continue;
      /**
       * Smartscape calls a frontend `FRONTEND-…` while the RUM metrics call the same application
       * `APPLICATION-…`, so keying the node on the Smartscape id produced a second, edge-only copy
       * of every application alongside the metric one - two "TravelAdvisor" boxes, and a tile that
       * counted one application as two. `id_classic` is the bridge, so the node keeps the classic
       * key and carries the Smartscape id for the deep link, which needs `FRONTEND-…`.
       */
      const appKey = text(record, "app_classic") || appId;
      const rumNodeId = `rum-${appKey}`;
      ensureNode(nodes, { id: rumNodeId, entityId: appId, name: text(record, "app_name") || appId, kind: "rum", subtitle: "RUM application", value: 0, unit: "req/min" });
      const existing = nodes.get(rumNodeId);
      if (existing && !existing.entityId) existing.entityId = appId;
      ensureNode(nodes, { id: `service-${serviceId}`, name: text(record, "svc_name") || serviceId, kind: "service", subtitle: "Service", value: 0, unit: "req/min" });
      // Smartscape knows the frontend calls this service but not how often.
      edges.set(`${rumNodeId}-${serviceId}`, { id: `${rumNodeId}-${serviceId}`, source: rumNodeId, target: `service-${serviceId}`, value: 0, unit: "", kind: "call", label: "calls" });
    }
    // The column is the pod inventory, so it is built before the edges that connect a few of them.
    const podNode = (record: DqlRecord) => {
      const pod = text(record, "pod");
      if (!pod) return;
      const cluster = text(record, "cluster");
      const namespace = text(record, "namespace");
      // ensureNode, not addNode: a container count is a property of the pod, not something to sum
      // when the same pod shows up once per service it serves.
      ensureNode(nodes, {
        id: `paas-${pod}`,
        entityId: text(record, "pod_id"),
        name: pod,
        kind: "paas",
        subtitle: podScope(cluster, namespace),
        // Null when the pod's cluster publishes no Kubernetes metrics; the UI renders that as a dash.
        value: numeric(record, "containers"),
        unit: "containers",
        workload: text(record, "workload") || undefined,
        namespace: namespace || undefined,
      });
    };
    for (const record of records(podInventory.data)) podNode(record);
    for (const record of records(pods.data)) {
      const serviceId = text(record, "service_id");
      const pod = text(record, "pod");
      if (!serviceId || !pod) continue;
      // A pod the inventory missed still gets a node, so its edge has something to attach to.
      podNode(record);
      ensureNode(nodes, { id: `service-${serviceId}`, name: text(record, "service_name") || serviceId, kind: "service", subtitle: "Service", value: 0, unit: "req/min" });
      // Placement, and Smartscape carries no volume, so both hops are drawn without a number.
      edges.set(`pod-${serviceId}-${pod}`, { id: `pod-${serviceId}-${pod}`, source: `service-${serviceId}`, target: `paas-${pod}`, value: 0, unit: "", kind: "hosting", label: "runs in" });
    }
    // Pod placement comes from its own query, since there is no direct pod-to-host edge to read.
    for (const record of records(podHost.data)) {
      const pod = text(record, "pod");
      const hostId = text(record, "host_id");
      if (!pod || !hostId || !nodes.has(`paas-${pod}`)) continue;
      ensureNode(nodes, { id: `infrastructure-${hostId}`, name: hostId, kind: "infrastructure", subtitle: "Host", value: 0, unit: "% CPU" });
      edges.set(`podhost-${pod}-${hostId}`, { id: `podhost-${pod}-${hostId}`, source: `paas-${pod}`, target: `infrastructure-${hostId}`, value: 0, unit: "", kind: "hosting", label: "runs on" });
    }
    // Problem counts are attached here rather than looked up in the view, so the map can order a
    // column by them and the tiles can count impacted entities off the same field.
    for (const node of nodes.values()) node.problems = problemsByEntity.get(node.entityId ?? entityIdOf(node.id)) ?? 0;
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }, [infrastructure.data, problemsByEntity, resolved.seconds, rum.data, rumService.data, podHost.data, podInventory.data, pods.data, service.data]);

  const map = useMemo(() => {
    const minutes = resolved.seconds / 60;
    const grouped = groupPodsByWorkload(data);
    const workloadIds = new Set(grouped.nodes.filter((node) => node.members).map((node) => node.id));
    /**
     * Namespace + workload, for flows whose cluster name does not match the pod's. Only used when
     * the pair is unique on the map: the same workload name in the same namespace of two clusters
     * would otherwise be guessed at.
     */
    const byNamespace = new Map<string, string | null>();
    for (const node of grouped.nodes) {
      if (!node.members || !node.workload || !node.namespace) continue;
      const key = `${node.namespace}/${node.workload}`;
      byNamespace.set(key, byNamespace.has(key) ? null : node.id);
    }
    const flows = records(serviceWorkload.data).flatMap((record) => {
      const serviceId = text(record, "service_id");
      const workload = text(record, "workload");
      if (!serviceId || !workload) return [];
      // `failed` is a boolean dimension; tolerate it arriving as a string.
      const failed = record.failed === true || record.failed === "true";
      const namespace = text(record, "namespace");
      const exact = workloadNodeId(podScope(text(record, "cluster"), namespace), workload);
      const targetId = workloadIds.has(exact) ? exact : byNamespace.get(`${namespace}/${workload}`) ?? exact;
      return [{ serviceId: `service-${serviceId}`, targetId, perMinute: numeric(record, "requests") / minutes, failed }];
    });
    const failureRates = new Map(records(serviceHealth.data).flatMap((record) => {
      const requests = numeric(record, "requests");
      const id = text(record, "entity_id");
      return id && requests > 0 ? [[`service-${id}`, numeric(record, "failures") / requests] as const] : [];
    }));
    // Null until the callers query has answered; a service missing from an answer is OTLP-only.
    const callers = entryServices.data && !entryServices.error
      ? new Map(records(entryServices.data).map((record) => [text(record, "service_id"), numeric(record, "callers")] as const))
      : null;
    const processFlows = records(serviceProcessTraffic.data).flatMap((record) => {
      const serviceId = text(record, "service_id");
      const pgId = text(record, "pg_id");
      if (!serviceId || !pgId) return [];
      const failed = record.failed === true || record.failed === "true";
      return [{ serviceId: `service-${serviceId}`, targetId: `process-group-${pgId}`, perMinute: numeric(record, "requests") / minutes, failed }];
    });
    /**
     * Only traffic that reaches a workload on the map places the service there. Counting every
     * workload-tagged flow skipped the process-group placement for services whose workload has no
     * pod on the map (OneAgent in containers, no Kubernetes integration), and the workload band was
     * then dropped for want of a node - so those services reached neither column.
     */
    const onWorkload = new Set(flows.filter((flow) => workloadIds.has(flow.targetId)).map((flow) => flow.serviceId));
    const placed = addProcessGroups(grouped, records(serviceProcess.data), onWorkload, problemsByEntity);
    // Process-group rates only weight edges the placement drew, never create new ones.
    const drawn = new Set(placed.edges.map((edge) => edge.id));
    const placedProcessFlows = processFlows.filter((flow) => drawn.has(`hosting:${flow.serviceId}->${flow.targetId}`));
    return addExternalCallers(inferSinglePlacement(addMeasuredTraffic(placed, [...flows, ...placedProcessFlows]), failureRates), callers, failureRates);
  }, [data, entryServices.data, entryServices.error, problemsByEntity, resolved.seconds, serviceHealth.data, serviceProcess.data, serviceProcessTraffic.data, serviceWorkload.data]);

  const recordCounts = useMemo<Record<TopologyQueryKey, number>>(() => ({
    rum: records(rum.data).length,
    service: records(service.data).length,
    infrastructure: records(infrastructure.data).length,
    problems: records(problems.data).length,
    serviceProcess: records(serviceProcess.data).length,
    serviceProcessTraffic: records(serviceProcessTraffic.data).length,
    pods: records(pods.data).length,
    podInventory: records(podInventory.data).length,
    podHost: records(podHost.data).length,
    podHealth: records(podHealth.data).length,
    rumService: records(rumService.data).length,
    serviceHealth: records(serviceHealth.data).length,
    hostHealth: records(hostHealth.data).length,
    rumHealth: records(rumHealth.data).length,
    rumErrors: records(rumErrors.data).length,
    affectedEntities: records(affectedEntities.data).length,
    serviceWorkload: records(serviceWorkload.data).length,
    entryServices: records(entryServices.data).length,
  }), [affectedEntities.data, entryServices.data, serviceProcess.data, serviceProcessTraffic.data, serviceWorkload.data, hostHealth.data, infrastructure.data, podHealth.data, podHost.data, podInventory.data, pods.data, problems.data, rum.data, rumErrors.data, rumHealth.data, rumService.data, service.data, serviceHealth.data]);
  const truncated = useMemo<TopologyTruncation[]>(() => (Object.keys(recordCounts) as TopologyQueryKey[])
    .flatMap((key) => {
      const cap = QUERY_CAPS[key];
      const count = recordCounts[key];
      return count > 0 && count >= cap ? [{ key, count, cap }] : [];
    }), [recordCounts]);
  // One-way latch: once the data is known to be incomplete, ordering has to happen server-side.
  useEffect(() => { if (truncated.length > 0) setOrderInQuery(true); }, [truncated]);

  return {
    ...data,
    /** What the map draws: the same topology with pods folded into workloads. */
    map,
    queries,
    resolved,
    // Keyed by node id so the details panel can look up whatever node is selected.
    serviceHealth: new Map<string, ServiceHealth>(records(serviceHealth.data).flatMap((record) => {
      const id = text(record, "entity_id");
      return id ? [[`service-${id}`, {
        p50Micros: numeric(record, "p50"),
        p95Micros: numeric(record, "p95"),
        requests: numeric(record, "requests"),
        failures: numeric(record, "failures"),
        failureRate: numeric(record, "failure_rate"),
      }] as const] : [];
    })),
    /**
     * Open-alert count per Dynatrace entity id, keyed without the node prefix. The tiles strip the
     * prefix off a node id to look an entity up.
     */
    problemsByEntity,
    kubernetes,
    /**
     * Pod utilization keyed by node id. Requests and limits stay null when the pod declares none,
     * so the panel can say "not set" rather than implying a configured zero. The running-container
     * count comes from the pods query, which already counts the containers actually reporting.
     */
    podHealth: new Map<string, PodHealth>(records(podHealth.data).flatMap((record) => {
      const pod = text(record, "pod");
      if (!pod) return [];
      const optional = (field: string) => record[field] === null || record[field] === undefined ? null : numeric(record, field);
      const podRecord = records(pods.data).find((candidate) => text(candidate, "pod") === pod);
      return [[`paas-${pod}`, {
        cpuUsageMcore: numeric(record, "cpu_usage_mcore"),
        cpuRequestsMcore: optional("cpu_requests_mcore"),
        cpuLimitsMcore: optional("cpu_limits_mcore"),
        memoryUsageBytes: numeric(record, "memory_usage_bytes"),
        memoryRequestsBytes: optional("memory_requests_bytes"),
        memoryLimitsBytes: optional("memory_limits_bytes"),
        containersDesired: numeric(record, "containers_desired"),
        containersRunning: podRecord ? numeric(podRecord, "containers") : 0,
      }] as const];
    })),
    // Two sources: the metrics carry the headline figures, user.events carries the error split.
    rumHealth: new Map<string, RumHealth>(records(rumHealth.data).flatMap((record) => {
      const id = text(record, "entity_id");
      if (!id) return [];
      const errorRecord = records(rumErrors.data).find((candidate) => text(candidate, "entity_id") === id);
      return [[`rum-${id}`, {
        users: numeric(record, "users"),
        sessions: numeric(record, "sessions"),
        requests: numeric(record, "requests"),
        durationMillis: numeric(record, "duration"),
        jsErrors: errorRecord ? numeric(errorRecord, "js_errors") : 0,
        httpErrors: errorRecord ? numeric(errorRecord, "http_errors") : 0,
        otherErrors: errorRecord ? numeric(errorRecord, "other_errors") : 0,
      }] as const];
    })),
    hostHealth: new Map<string, HostHealth>(records(hostHealth.data).flatMap((record) => {
      const id = text(record, "entity_id");
      return id ? [[`infrastructure-${id}`, {
        cpuPercent: numeric(record, "cpu"),
        memoryPercent: numeric(record, "memory"),
        diskUsedPercent: numeric(record, "disk_used"),
        // The metrics are byte totals for the window, so the rate needs the window length.
        networkInPerSecond: numeric(record, "net_rx") / resolved.seconds,
        networkOutPerSecond: numeric(record, "net_tx") / resolved.seconds,
      }] as const] : [];
    })),
    // `summarize` collapses to a single record, so both counts live in the first row.
    problems: {
      total: numeric(records(problems.data)[0] ?? {}, "total"),
      active: numeric(records(problems.data)[0] ?? {}, "active"),
    },
    recordCounts,
    /**
     * Queries that returned exactly as many records as they are allowed to.
     *
     * Truncation is the failure mode this dashboard keeps rediscovering: the query service caps
     * results and says nothing, so a tile quietly reports a fraction of the tenant. Flagging it in
     * the UI is the point - a ranking built on a truncated result can be wrong in a way no error
     * message would ever reveal.
     */
    truncated,
    /** True once ordering moved into the queries, so the UI can explain why sorting now reloads. */
    orderInQuery,
    isLoading: rum.isLoading || service.isLoading || infrastructure.isLoading || problems.isLoading || serviceProcess.isLoading || serviceProcessTraffic.isLoading || pods.isLoading || podInventory.isLoading || podHost.isLoading || podHealth.isLoading || rumService.isLoading || serviceHealth.isLoading || hostHealth.isLoading || rumHealth.isLoading || rumErrors.isLoading || affectedEntities.isLoading || serviceWorkload.isLoading || entryServices.isLoading,
    /**
     * Reported per query rather than as one banner. The queries are independent, and on a busy
     * tenant a single heavy one can fail while everything else returns fine - collapsing that into
     * "Topology query failed" hid a dashboard that was mostly working.
     */
    errors: ([
      ["RUM applications", rum.error], ["Services", service.error], ["Infrastructure", infrastructure.error],
      ["Problems", problems.error], ["Service-to-process placement", serviceProcess.error], ["Service-to-process traffic", serviceProcessTraffic.error],
      ["Kubernetes pods", pods.error], ["Pod inventory", podInventory.error], ["Pod-to-host", podHost.error], ["Pod utilization", podHealth.error], ["RUM-to-service", rumService.error],
      ["Service latency", serviceHealth.error], ["Host resources", hostHealth.error], ["RUM metrics", rumHealth.error],
      ["RUM errors", rumErrors.error], ["Open alerts", affectedEntities.error],
      ["Service-to-workload traffic", serviceWorkload.error], ["Entry services", entryServices.error],
    ] as const).flatMap(([label, error]) => error ? [{ label, message: error.message }] : []),
    refetch: async () => { await Promise.all([rum.refetch(), service.refetch(), infrastructure.refetch(), problems.refetch(), serviceProcess.refetch(), serviceProcessTraffic.refetch(), pods.refetch(), podInventory.refetch(), podHost.refetch(), podHealth.refetch(), rumService.refetch(), serviceHealth.refetch(), hostHealth.refetch(), rumHealth.refetch(), rumErrors.refetch(), affectedEntities.refetch(), serviceWorkload.refetch(), entryServices.refetch()]); },
  };
};
