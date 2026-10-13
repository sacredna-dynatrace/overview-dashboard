# Dynatrace query notes

Hard-won findings from building the Application topology dashboard. Every item here cost a
debugging cycle; several produced **wrong numbers or empty results without any error**, which is the
failure mode to watch for in this platform.

Verify DQL against a live environment before shipping. Most of the traps below return a clean
`200 OK` with a plausible-looking but wrong answer.

---

## 1. Permissions fail silently

Grail permissions are **bucket × table**. Without `storage:buckets:read` a query succeeds and
returns **zero records** — no error, no warning.

The same query in a notebook works, because a notebook runs with the user's permissions, not the
app's. "Correct DQL, empty dashboard" almost always means a missing scope.

Every table needs its own scope. `user.events` is **not** covered by `storage:events:read`; it needs
`storage:user.events:read`. That one only surfaces as a real error:

```
NOT_AUTHORIZED_FOR_TABLE: Missing OAuth scope 'storage:user.events:read' on table 'user.events'
```

Scopes this app needs are listed in `app.config.json`. When adding a query, check the table it
reads against that list.

> Verifying with a broad-scoped developer token hides this class of bug entirely. The token used
> for local verification has far more scopes than the app.

## 2. Result limits

`maxResultRecords` defaults to **1000**. Removing `| limit` from a query is not enough; the service
truncates silently. This app passes `QUERY_LIMITS` on every `useDql` call.

### Truncation is silent, so the UI has to say it

A capped query returns its maximum and no error. Every query therefore has a declared cap in
`QUERY_CAPS` (`EDGE_LIMIT` for the edge queries, `maxResultRecords` for the rest), and a result
sitting exactly on its cap raises a banner. Without it a tile can report a fraction of the tenant
and nothing on the page looks wrong.

### Sorting does not re-run the queries - unless the data was capped

The inventory queries return the whole population, so the map sorts it in the browser and picks the
top ten. Re-running them with a different `sort` would return the same records in a different
order: no accuracy gained, fifteen queries spent, and an instant control turned into a two-second
reload.

That stops being true once a query hits its cap, because then the surviving rows are chosen by the
query rather than by the UI. So ordering is latched: `orderInQuery` flips on the first time
anything comes back truncated, and from then on the inventory queries carry the sort and re-issue
when it changes. Only `value` and `name` can be expressed that way - `problems` and `connections`
rank on other queries' data, so they keep the default order and the banner carries the caveat.

Note that re-running a query never fixes a **capped edge** ranking; the cap has to move or the query
has to aggregate. That is exactly what happened: a 546-service tenant sat on the 500-edge cap and
the "Most relationships" order was being computed from a fraction of the relationships, so `EDGE_LIMIT`
went to 5000. Edge rows are a handful of short fields, so the extra volume is negligible against
`maxResultBytes`. The map draws only edges joining two visible nodes, and the layout pass resolves
each node's column once rather than scanning per edge, so the higher cap does not cost render time. What it did fix is which rows get cut: the three edge queries that ended in a bare
`| limit` now sort first, so truncation is deterministic instead of arbitrary.

## 3. `timeseries` semantics

**No `by:` collapses everything into one record.** Summary tiles reported `1` regardless of how many
entities existed, because the query had no `by:` clause.

**`scalar: true` aggregates over the whole window**; without it you get an array of ~120 buckets.
Mixing the two breaks things:

- `sum(m, scalar: true)` then `arraySum(...)` — array function on a scalar.
- `avg(m)` then `arrayAvg(...)` — correct.

**Percentiles cannot be averaged.** `arrayAvg` over bucket-level p50s is not the window's p50. On a
low-traffic service where most buckets are empty it was off by ~300x:

| service | `arrayAvg` of bucket p50 | `scalar: true` | Services explorer |
| --- | --- | --- | --- |
| hello-world | 724.6 µs | **732.0 µs** | 732 µs |
| travel-advisor | 688 ms | **2.07 ms** | 2.07 ms |

**`default: 0` distorts averages.** It fills gap buckets with zeros, which `arrayAvg` then averages
in — a 30 mcore request read as 29.75, a desired container count of 1 read as 0.99. Leaving it out
lets `arrayAvg` skip nulls and return configured values exactly. Use `default: 0` only where a gap
genuinely means zero.

**A multi-metric `timeseries { }` block intersects.** An entity missing any one metric drops out of
the result entirely rather than returning null for it. A pod with no CPU limit disappeared from pod
utilization until requests/limits were moved into separate `lookup`s. `nonempty: true` is accepted
at command level but does not fix this.

## 4. `lookup` vs `join`

- `lookup` is a **left outer join** — rows without a match survive with nulls. Use it for optional
  enrichment (container counts for a cluster with no Kubernetes metrics).
- `join` is inner and drops unmatched rows.

## 5. `JOIN_RIGHT_TABLE_SIZE`

```
The join command's subquery read too much data. Please continue to filter the subquery
or narrow its time range.
```

Raised when a join's **subquery** is too large. A span self-join (client span ↔ server span on
`trace.id`) works on a small tenant and fails outright at ~1.7M req/min. Anything joining raw
records whose volume scales with traffic will eventually hit this.

The fix is not to filter harder — it is to read the topology instead of the traffic. See §7.

## 6. Timeframes

The Strato timeframe selector emits its own expression dialect (`@d`, `-1d@d`, `now()-30m`). **`@d`
is not valid DQL** — DQL wants `now()@d`. Injecting selector values straight into a query silently
applies the wrong window.

`resolveTimeframe` in `useTopologyData.ts` resolves every bound to an absolute ISO timestamp with
`parseTimeAsTimeValue` from `@dynatrace-sdk/units`, which handles every form the selector produces.
That also makes the window length exact, so request rates no longer depend on regex-parsing an
expression.

For deep links into other Dynatrace apps, pass the **raw expression** as `tf=<from>;<to>` instead —
a relative range should stay relative on the far side.

## 7. Two entity models

This is the single biggest thing to understand.

| | Classic | Smartscape |
| --- | --- | --- |
| Query | `fetch dt.entity.service` | `smartscapeNodes SERVICE` |
| Relationships | `runs_on`, `calls`, `belongs_to` as record fields | `smartscapeEdges <type>` |
| ID form | `CLOUD_APPLICATION_INSTANCE-…`, `PROCESS_GROUP_INSTANCE-…` | `K8S_POD-…`, `CONTAINER-…`, `FRONTEND-…` |
| Coverage | OneAgent-instrumented workloads only | Includes OTLP-only workloads |
| Shown in the Smartscape app | no | yes |

An OTLP-only service is **absent from `dt.entity.service` entirely**. No relationship query against
the classic model can find it, which is why the map used to leave such services unconnected while
the Smartscape app drew them fine.

The `dt.entity.k8s_pod`, `dt.entity.frontend`, … tables exist as valid names but are **empty** —
they are not the way to reach the Smartscape model.

### `smartscapeNodes` / `smartscapeEdges` traps

**Default timeframe is narrow (~2h).** Pass it explicitly or short-lived entities are simply absent:

```dql
smartscapeNodes K8S_POD                     // kind-kind cluster: 0 pods
smartscapeNodes K8S_POD, from:now()-24h     // kind-kind cluster: 19 pods
```

**`source_id` / `target_id` are entity-id typed.** String functions against them return nothing and
do **not** error:

```dql
| filter startsWith(source_id, "SERVICE-")              // 0 records - wrong
| filter startsWith(toString(source_id), "SERVICE-")    // 427 records
| filter source_type == "SERVICE"                       // preferred
```

Prefer `source_type` / `target_type`.

**`entityName()` returns null for Smartscape IDs.** Get names by looking up the node table.

**Inventory and relationships are different populations.** `smartscapeNodes` returns every entity
observed in the window; `smartscapeEdges` only returns relationships a traced request path
produced. On the reference tenant that is 109 pods against 1 pod reachable from a service:

```dql
smartscapeNodes K8S_POD | summarize count()                                 // 109
smartscapeEdges runs_on
| filter source_type == "SERVICE" and target_type == "K8S_POD"
| summarize countDistinct(target_id)                                        // 1
```

Counting an edge query to fill a tile therefore understates the tenant badly - this is what made the
pod tile read `1/0` while the Kubernetes app showed 111. Tiles count inventory, the map draws
relationships, and the two numbers are expected to differ.

The map resolves that by drawing only what is reachable **outward from the service column**, one
tier at a time. Filtering on "has at least one edge" was tried first and was not enough: pods and
hosts wire to each other through the container topology, so a pod no service runs on still reached
the map through its host. Reachability has to be directional - service to pod to host, never host
back to pod.

**Node counts move with the timeframe.** `smartscapeNodes K8S_POD` returned 109 over 2h and 130
over 24h, because a pod that was replaced still counts as observed in the longer window. This is
"pods that existed in the window", not "pods running now" - unlike hosts, which are stable enough
that the distinction never shows.

### Edge shapes observed

```
FRONTEND  --calls------>  SERVICE
SERVICE   --runs_on---->  K8S_POD
SERVICE   --runs_on---->  CONTAINER
K8S_POD   --runs_on---->  K8S_NODE
K8S_POD   --belongs_to->  K8S_CLUSTER / K8S_NAMESPACE
K8S_POD   --is_part_of->  K8S_DEPLOYMENT / K8S_REPLICASET
CONTAINER --is_part_of->  K8S_POD
CONTAINER --runs_on---->  HOST
SERVICE   --runs_on---->  PROCESS
PROCESS   --runs_on---->  HOST / CONTAINER
PROCESS   --calls------>  PROCESS
OS_SERVICE --runs_on--->  PROCESS
```

`PROCESS` nodes carry `dt.process_group.id`, `dt.process_group.detected_name`, `host.name`,
`process.containerized` and `id_classic` (`PROCESS_GROUP_INSTANCE-…`). Smartscape `HOST` ids equal
the classic `HOST-…` ids. There is no `SERVICE calls SERVICE` edge (see the external-callers notes).

There is **no direct pod→host edge**. Go through the container: `CONTAINER is_part_of K8S_POD` joined
with `CONTAINER runs_on HOST`. `K8S_NODE` is a different entity from the monitored `HOST` that the
infrastructure column is built from.

Nodes carry `id_classic`, which bridges back to classic IDs and therefore to the `dt.*` metrics.

`K8S_POD` nodes carry `k8s.cluster.name`, `k8s.namespace.name`, `k8s.node.name`,
`k8s.workload.name`, so column subtitles need no extra hop.

## 8. Metric coverage varies per host

`dt.host.net.nic.link_util_rx/tx` was reported by only **2 of 8 hosts** — NIC link utilization needs
a known link speed, which virtualized and cloud NICs generally do not report. The infrastructure
count was wrong until it moved to `dt.host.cpu.usage`, which every monitored host reports.

When a count disagrees with a Dynatrace app, check whether the chosen metric is universally
reported before assuming the query is wrong.

## 9. Davis problems

`dt.davis.problems` writes **one record per lifecycle state change**. A plain `count()` counts state
changes, not problems. Collapse by `display_id` first and drop `dt.davis.is_duplicate == true`.

For "does this entity currently have an alert", `dt.davis.problems.affected_entity_ids` is not
enough. An alert raised against an OS service names the custom device, not the host it runs on;
`dt.davis.events` carries `dt.entity.host` alongside `affected_entity_ids`, and the union of the two
is what matches the host rows in the Infrastructure app.

Also filter to `event.status == "ACTIVE"` — a problem that opened and closed inside the window is
history, not current impact.

### `dt.entity.host` on `dt.davis.problems` is an array

It holds `["HOST-..."]`, not `"HOST-..."`. Wrapping it with `array(dt.entity.host)` nests it, so
`expand` yields the inner array and `toString` gives `["HOST-..."]` - matching no node, with no
error. The host rollup silently contributed nothing and a host whose only open problems name custom
devices (`kjw-lab-win`, 2 alerts) disappeared from the count. Concatenate it directly:

```dql
| fieldsAdd ids = arrayConcat(coalesce(affected_entity_ids, array()), coalesce(dt.entity.host, array()))
```

The same construct worked on `dt.davis.events`, which suggests the field is scalar there. Check the
shape per table rather than assuming.

### `dt.davis.events` is not `dt.davis.problems`

`dt.davis.events` holds raw Davis events - "Process unavailable", "Monitoring not available" -
with `event.kind == "DAVIS_EVENT"` and a **null `display_id`**. Problems live in
`dt.davis.problems` and carry a `display_id` (P-xxxxx). Both tables answer "what is wrong", and
neither errors when you pick the wrong one.

The impacted-entity query read events, so on a 208-host tenant it reported 2 hosts with problems
against the Infrastructure app's 1: three `Process unavailable` events on one node group rolled up
through `dt.entity.host` and were counted as host problems. Checking `event.kind` and `display_id`
is the fastest way to tell which table you are actually in:

```dql
fetch dt.davis.events
| filter event.status == "ACTIVE"
| fields event.kind, display_id, event.name, affected_entity_types
```

All tile "impacted" counts and the map's red/green node dots read the same map, so getting this
wrong makes every red number on the page unexplainable by the Problems tile. Both now read
`dt.davis.problems` with the same `dt.davis.is_duplicate == false` filter, and collapse lifecycle
records with `countDistinct(display_id)`.

An affected entity id that `entityName()` resolves to null is an entity that is no longer
monitored. It never matches a node, so it silently drops out of the tile counts - which is correct,
but means the query can return more rows than the tile shows.

## 10. Units

| metric | unit |
| --- | --- |
| `dt.service.request.response_time` | microseconds |
| `dt.frontend.request.duration` | milliseconds |
| `dt.kubernetes.container.cpu_usage` | millicores |
| `dt.kubernetes.container.memory_working_set` | bytes |
| `dt.host.net.nic.bytes_rx/tx` | bytes over the window (divide for a rate) |
| `dt.process.network.bytes_rx/tx` | bytes over the window |

Sanity-check attribution: every process on a host should sum to less than that host's NIC total.

---

## Verifying DQL locally

`.dt-app/.tokens.json` holds an OAuth token from the last `dt-app` command. It can be refreshed and
used to run DQL directly against the environment:

```js
POST {environmentUrl}/platform/storage/query/v1/query:execute
Authorization: Bearer <access_token>
{ "query": "...", "requestTimeoutMilliseconds": 60000 }
```

Two caveats:

- Refresh tokens **rotate**. Write the refreshed pair back to `.dt-app/.tokens.json` or the next
  `dt-app` command has to re-authenticate.
- The SSO session expires server-side. Once it does, refresh fails with
  `UNSUCCESSFUL_OAUTH_REFRESH_TOKEN_MISSING_SESSION` and only an interactive login restores it.
  A headless alternative is `DT_APP_OAUTH_CLIENT_ID` / `DT_APP_OAUTH_CLIENT_SECRET`.

## Deploying

App versions are **immutable**. Redeploying the same version with changed content is rejected:

```
Cannot install app with version X because the same version is already installed
with a different checksum.
```

Bump `app.config.json` before every deploy. The UI reads the version from the manifest at runtime
via `getAppVersion()`, so there is nothing else to keep in sync.

Scope changes trigger a consent prompt on next open; the app returns empty data until it is granted.

## Map selection is anchored, not ranked per column

Ranking each column independently over the whole tenant produces a map with almost no edges. The
ten busiest services, the ten biggest pods and the ten hottest hosts are different entities, and an
edge only draws when both ends are on screen. On a 546-service tenant the rankings never coincide:
a service listed four `runs on` hosts in its details panel and had no line on the canvas.

So columns are anchored. With nothing selected the anchors are the top services - connected ones
first, because an unconnected service anchors nothing - and the other columns show what those
services reach. Selecting a node makes it the sole anchor, which is what makes a click mean "show
me this thing's pods and hosts". Within a column, nodes sort by hop distance before the chosen sort.

Traversal is monotonic in tier (rum 0, service 1, pod 2, host 3): from the anchor it goes outward or
inward but never turns around, so a host cannot drag in every other pod sharing it.

`hidden` (the "+N more not drawn" label) counts related nodes that did not fit, not the tenant.
Tenant totals belong to the summary tiles.

### Columns are ordered outward from the anchor

Only the anchor's column uses the chosen sort. Every other column orders by where its nearest
already-placed neighbour sits, filling outward from the anchor, so the busiest service's pods come
first and its hosts after them and the lines run across the map instead of crossing it.

This matters because most columns have nothing meaningful to sort on. Pod container counts are
almost always 1, so `value` ties and the column fell back to alphabetical - a pod list in name
order next to a service list in traffic order, with edges crossing between them.

### One column can hold two units

A service the request metrics do not cover used to get a node from the network-bytes query, carrying
`B/s` instead of `req/min`. Comparing the raw numbers ranked a 464 KB/s service above one serving
97,000 req/min. Values in the column's own unit sort first, and only same-unit values are compared.
The "Busiest service" panel picks from `req/min` services for the same reason. The network-bytes
query is gone (see below), but the unit rule stays: pods count containers, process groups processes.

## Services outside Kubernetes: process groups

The third column is "where the service runs". A service with a Kubernetes workload (Smartscape pod
edge or workload-tagged traffic) is drawn on its workload; any other service is drawn on its
**process group**, built from `SERVICE runs_on PROCESS` + `PROCESS runs_on HOST` (`serviceProcess`).
Kubernetes services also have `SERVICE runs_on PROCESS`, which is why the workload wins - otherwise
the same service would be placed twice.

**Smartscape does not have every service.** On diw85600 `[embedded]` (a `DATABASE_SERVICE` inside
the Spring Boot process, called by hello-world) has no Smartscape edge of any kind and no Smartscape
SERVICE node, while classic `dt.entity.service` still has `runs_on` its process group instance. So
`serviceProcess` reads the classic `runs_on[dt.entity.process_group_instance]`, maps it to PROCESS
via `id_classic`, and `append`s the Smartscape `SERVICE runs_on PROCESS` edges, deduplicated. Each
process is then followed to its pod (`PROCESS runs_on CONTAINER`, `CONTAINER is_part_of K8S_POD`):
a service whose process sits in a pod on the map is linked to that pod's workload, not to a process
group, so one process is never drawn as both.

This replaced the service → host query built on `dt.process.network.bytes_*`. It drew an edge only
where that metric was non-zero, so on a tenant whose hosts did not report it a VM-hosted service
showed no host at all - a RUM app's services could be selected and the two right columns stayed
empty.

Bands into a process group come from `dt.service.request.count` split by `dt.process_group.id`
(verified), excluding requests that carry `k8s.workload.name` so nothing is counted on both a
workload band and a process-group band. Process groups exist only on the map; the pod tile is
unaffected. Verified on diw85600, where every service is in Kubernetes, so no process group is
drawn there - the effect has to be checked on a tenant with VM-hosted services.

## The pod column is grouped by workload

The map folds pods into `k8s.workload.name` (scoped by cluster and namespace) in
`groupPodsByWorkload`; the queries and the tiles stay per pod. Before this, one service with many
replicas filled all ten pod slots and fanned an edge to each - it looked like a join bug, but the
joins are by entity id and the fan was real. Edges into a workload are deduplicated and labelled with
how many pods carry them. A pod with no workload name stays a pod node.

A workload node has no entity id (the deployment entity is not fetched), so the details panel links
each member pod instead of the workload.

## Measured traffic and the external-callers node

Only two hops on the map have a measured volume, and only those are drawn as Sankey bands
(`isMeasured`: unit `req/min`, value > 0). Everything else stays a thin relationship line.

- **Service → workload.** `dt.service.request.count` carries `k8s.cluster.name`,
  `k8s.namespace.name` and `k8s.workload.name` (verified on diw85600; also `k8s.workload.kind`,
  `dt.smartscape.k8s_deployment`). It is generated from spans at ingest
  (`dt.metrics.source: openpipeline:spans`), so splitting by workload is a metric read, not a span
  scan.
  **The `k8s.*` dimensions are not on every tenant.** On one tenant the same metric carried only
  `k8s.namespace.name` and `k8s.cluster.uid`, plus the classic `dt.entity.cloud_application` (the
  Deployment) and `dt.entity.kubernetes_cluster` - no `k8s.workload.name`, no `k8s.cluster.name`.
  Filtering on `k8s.workload.name` dropped every request, so services in plain workloads got a
  relationship line. The query now falls back to
  `entityName(dt.entity.cloud_application)` / `entityName(dt.entity.kubernetes_cluster)` (equal to the
  `k8s.*` values on diw85600), and the map matches on namespace + workload when the cluster name
  differs and that pair is unique. Spans showed the workload on that tenant too, under the older
  `dt.kubernetes.*` attribute names - a trace having it says nothing about the metric having it.
- **Single placement, inferred.** Some tenants put no placement dimension on the metric at all: a
  VM-hosted Spring Boot service (`dt.system.monitoring_source: fullstack_container`) carried only
  `dt.entity.service`, `failed`, `endpoint.name`, `http.response.status_code`, `dt.service.name` -
  no process group, no Kubernetes. When a service has exactly one placement edge and nothing
  measured it, `inferSinglePlacement` gives that edge the service's own rate and failure rate,
  marked `inferred` (tooltip: "inferred: single placement", band drawn a shade lighter). Two or more
  placements stay relationship lines - there is no basis for dividing the rate.
- **External callers → entry service.** The band is the service's own request rate. That equals
  outside traffic only for an entry service, so the stand-in node attaches to services with no
  service caller and no RUM edge.

Entry services come from the classic `dt.entity.service` `called_by[dt.entity.service]`, because
**Smartscape has no `SERVICE calls SERVICE` edge** - on diw85600 `smartscapeEdges calls` held only
`PROCESS→PROCESS` and `HOST→HOST`. The classic model holds OneAgent services only, so an OTLP-only
service has no caller data. Those are included as candidates (their edge is labelled "callers
unknown (OTLP)") - excluding them left OTLP tenants with no front end. Unknown only counts once the
callers query has answered; while it loads or after it fails nothing is attached, otherwise every
service would look unknown.

On a OneAgent tenant all of the busiest services came back with callers (`called_by` 1-100), which
is why the bands land on smaller services further down: the busy ones are internal.

The node shows "N shown" (sum of drawn bands) above "N total req/min" (all entry services), because
most entry services fall outside the ten drawn.

Failed requests are drawn as red particles, in proportion to each band's failure share (rounded
to whole particles; the tooltip has the exact rate). Service → workload splits by the metric's own
`failed` dimension (observed as a boolean on `dt.service.request.count`) instead of adding a
filtered second metric to the block, because a multi-metric `timeseries` intersects and an edge
with no failures would vanish. External callers → service uses the service-wide rate from
`serviceHealth`, which for an entry service is the rate of exactly the traffic on that band.
The `failed` split was not re-verified live when it was added (token session had expired).

RUM → service still has no per-edge volume. Weighting it with the service rate would double-count a
service several frontends call, so it stays a relationship line.

The external-callers node lives in the map data only (`map` from the hook). It is never counted in
the tiles and carries no problems or entity link.

## Davis analyzers (the forecast finding)

`@dynatrace-sdk/client-davis-analyzers` takes a DQL timeseries expression directly, so the forecast
reuses the metrics the map already reads - no spans, no logs. The app needs
`davis:analyzers:execute` on top of the metric scopes; adding it triggers a consent prompt on every
tenant. Verified live on all three node kinds (`OK` / `VALID`, 18 steps).

```
GET  /platform/davis/analyzers/v1/analyzers                        # catalogue, 10 on this tenant
POST /platform/davis/analyzers/v1/analyzers/{name}:execute
```

`dt.statistics.GenericForecastAnalyzer` is the one in use. It answers synchronously for a handful of
series and otherwise returns a `requestToken` to poll. Output per series is `dt.davis.forecast:`
`point` / `lower` / `upper` arrays covering **only the forecast window**, so "the current value" is
not in the response - the trend is taken from the first and last point of the same array instead.

**Watch the interval.** `sum(dt.service.request.count)` with `interval: 10m` forecasts requests per
ten minutes. Presenting that as `req/min` would repeat the unit mix-up the services column had; the
hook divides by the interval for per-minute metrics.

**Anomaly detection did not work here.**
`dt.statistics.anomaly_detection.SeasonalBaselineAnomalyDetectionAnalyzer` returned
`COMPLETED` / `SUCCESSFUL` with **zero outputs and no logs** on both 24 h and 7 d of host CPU. It is
`IMPLEMENTED`, so this is not a missing analyzer - the input needs something the forecast analyzer
does not. Another silent empty result; investigate before promising an anomaly finding.

## Deep links: three timeframe dialects

The timeframe selector, the platform apps and the frontend app all spell a timeframe differently,
and a value the target cannot parse is **not** an error - the app silently opens at its own default
of two hours. That is what made a dashboard set to "Today" open the Problems app as "Last 2 hours".

| Speaker | Today | Last 7 days |
| --- | --- | --- |
| Strato selector | `from: "@d"`, `to: "now()"` | `from: "now()-7d"` |
| Platform apps (`tf=`) | no equivalent | `tf=now-7d;now` (no parentheses) |
| Frontend app (`from=`/`to=`) | no equivalent | `from=now()-7d&to=now()` |
| Problems app (`from=`/`to=`) | absolute only | `from=<ISO>&to=<ISO>` |

**Which parameter an app reads is per app, and there is no way to find out from the API.** The app
bundle is not fetchable (`/ui/apps/<id>/...` and the hosting paths all 404) and the registry returns
only id, name, version and description - no intents, no route metadata. The reliable method is to
open the app, change its timeframe and read the URL.

That is how the problems app was settled: a link arrived carrying only `tf`, and after changing the
timeframe the URL read `?from=...&to=...&tf=<our untouched value>`. The app had written its own
range into `from`/`to` and left `tf` unread - so two rounds spent fixing the `tf` format changed
nothing. A wrong parameter name looks exactly like a wrong parameter value: the app opens at its
default and says nothing.

Also do not mix dialects across the two ends of one range. `tf=<ISO>;now` - the result of resolving
`@d` but leaving `now()` relative - was rejected as a whole. If either end has to be resolved, both
are.

`TileLinks.ts` translates the rolling presets into each dialect so they stay relative, and resolves
anything with `@` day-alignment - Today, Yesterday - or an absolute range to ISO. Note the frontend
app takes the two bounds separately in **both** its list and entity views; handing it `tf` does
nothing.

## Known gaps

- **Map readability at scale.** The map caps drawing at 10 nodes per column, but on a tenant with
  hundreds of services that is still an unreadable wall of edges. It needs a different visual
  approach — aggregation, filtering, or drill-down — rather than a taller canvas.
- Smartscape carries no per-relationship call volume, so `calls`, `runs in` and `runs on` edges are
  drawn without a number.
