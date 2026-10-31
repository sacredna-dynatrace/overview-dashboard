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

**"On a workload" means a workload drawn on the map.** A tenant with OneAgent inside containers but no
Kubernetes integration (pods tile 0, clusters 0, services named `nubf-svc-*`) puts
`dt.entity.cloud_application` on every request, so the workload-traffic fallback resolved a workload
for every service - and the placement then skipped the process group, while the workload band was
dropped because no such workload node exists. Those services reached neither column. Only flows
whose workload is on the map now count as a workload placement.

Bands into a process group come from `dt.service.request.count` split by `dt.process_group.id`
(verified). They are attached only to service -> process-group edges the placement drew, and a
service placed on a workload never gets one, so nothing is counted on both bands. (Filtering
workload-tagged requests out in the query instead dropped them from both bands on the tenant above.) Process groups exist only on the map; the pod tile is
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

## Blast radius page

`/blast-radius` draws one Davis problem as rings around its root cause. Verified on isb54165 (7 days):
353 problems, 147 with `root_cause_entity_id` (133 of them services, a few process groups and hosts);
the rest have none and are drawn with a dashed "problem" centre ringed by the affected entities.

- **Rings come from the call graph, not from time.** Every event in a problem carries the same
  start minute, so there is no propagation order to replay. Ring 1 is the root's `called_by`
  (classic `dt.entity.service`; Smartscape has no SERVICE calls SERVICE), or the services on a
  root host/process; ring 2 their callers; the last ring is RUM apps (Smartscape FRONTEND calls).
- **Confirmed vs exposed.** Davis's `affected_entity_ids` are red; the rest of the fan is muted.
  e.g. DB service hjesmn: 31 callers, 3 confirmed affected.
- **Sort nulls.** `dt.davis.affected_users_count` is often null, and a descending sort puts nulls
  first, so the list sorts on `coalesce(users, 0)`.
- `called_by` lists are capped by the platform (a warning, not an error), and OTLP-only services
  have none, so the rings can stop early.

### Problem origin: root, self, events

Problems on isb54165 (30 days, 1,624): 660 with a root cause; of the 964 without one, **955 have a
single affected entity**. That is not "cause unknown" - nothing spread to the entity, the problem is
its own - so the page treats it as the origin (`self`) and draws its callers, exactly like a root
cause. The other ~9 group concurrent events Davis did not link: mostly one process failing on two
hosts (apache-tomcat-*, tomcat_mtms*, ContractApplication), once a host plus its nginx, twice
unrelated services. Those are drawn as events around the problem, first ring only, with no impact
colouring and no dependency fan. The Problems app shows "No root cause" for both kinds.

`dt.davis.affected_users_count` (set on 241 problems) comes from **RUM Classic**. RUM Classic does
not appear as Smartscape FRONTEND nodes or in `dt.frontend.*`, which is why the topology shows no
RUM on that tenant while Davis still counts users. It is a real user count, not a guess.

### Davis analysis and links

- **No replay.** A timeline replay was built and removed: on isb54165 a steady sweep showed each
  problem for 0.19 s, and an incident-by-incident replay still did not earn its space.
- **Davis analysis** is `event.description` (English Markdown), fetched for the selected problem
  only; the display id is checked against `^P-d+$` before it goes into DQL. The panel shows a
  Korean summary built from the problem's fields (root cause, affected entities by type, users,
  impact level) with the English original collapsed. Sending customer problem text to an outside
  translator was ruled out.
- **Deep links** (copied from real isb54165 URLs): problem by `event.id` (`…V2`, not the
  display id) with `from`/`to`; process via `PROCESS-<hex>` where the hex equals the
  `PROCESS_GROUP_INSTANCE` one; workload via its Smartscape id, which does **not** share the hex of
  the classic `CLOUD_APPLICATION-…` (e.g. CLOUD_APPLICATION-093B… is K8S_DEPLOYMENT-0226…), so it is
  looked up through `id_classic` across K8S_DEPLOYMENT/STATEFULSET/DAEMONSET/CRONJOB/JOB. Types without
  a verified link (process group, custom device, …) are not linked.

### Analyze problem (Dynatrace Assist)

Dynatrace Assist (`dynatrace.davis.copilot`) declares an intent `ask-question` (`addonMode: overlay`;
properties `prompt` required, `execute` boolean, `contexts` [{type, value}]), read from its manifest
with `dtctl get app dynatrace.davis.copilot`. The page sends it with `sendIntent` from a Strato `Button`,
building the prompt **at click time**, with
`options: { recommendedAppId, recommendedIntentId }` - the three-argument `sendIntent` is deprecated
and fails lint - and the Problems app's own prompt. **Assist does not follow the user's language for
this app**: the same user and prompt got Korean from the Problems app and English from here. So the
prompt ends with "Please answer in <language>." from `getLanguage()` (user-preferences), mapped to
an English name with `Intl.DisplayNames` on the base code; nothing is added for English. `contexts` is not sent: its accepted types are undocumented. The overlay
only opens inside the Dynatrace shell, so check it on a deployed build, not the local dev server.

The prompt (`ui/app/assistPrompt.ts`) carries what the page knows: the problem window in UTC, the
origin as the page reads it (root / self / concurrent events), and up to 10 affected entities **by
id only**. Entity names are free text: "Netty on 0:0:0:0:0:0:0:0:*" made Assist reject the whole
prompt under its PII blocking (IP_ADDRESS). Problem titles still go in; custom-alert titles can
name hosts ("(ec2-…) Host Memory …") - not blocked so far, but the same kind of risk. With only the display id, Assist first searched the last 72 hours, found nothing and searched
again. It asks for logs, metrics, traces and events from 30 minutes before the start to the end -
bounded on purpose, since an unbounded "all relevant data" invites broad log scans - and for a
timeline, evidence with the DQL used, impact, remediation and prevention, and "not supported by the
data" rather than a guess. Longest prompt on isb54165: 1,301 characters (31 affected entities).

**`getLanguage()` returns "en" until the runtime is ready.** The SDK falls back to "en" (with a
console warning) when `dtRuntime.userPreferences` is not there yet. With `IntentButton` the payload
was computed at render, so the first click after load sent no language line and Assist answered in
English; later clicks, after a re-render, were Korean. Reading it on click was not the whole story:
the user's Dynatrace language **is** English, and the Korean answers came from their **Assist
personalization** (custom instruction "Please provide answer in Korean"), which the app cannot read
and which the first prompt sent to a freshly opened Assist panel is answered without. So the page
has an answer-language selector (한국어 / English / Auto, default 한국어, remembered in localStorage) and
the prompt always states the language for the explicit choices. Auto tries the Dynatrace language,
then the regional format, then the browser, and says nothing if all are English.

**Times.** Assist answers in the zone the prompt uses, so a UTC prompt produced a UTC timeline while the
page shows local time. The prompt keeps UTC for the window (what Assist queries with) and adds the
browser's local time beside it - "2026-10-20T02:00Z (2026-10-20 11:00 Asia/Seoul)" - then asks for all
times in that zone with its offset at the problem's start (daylight saving included). A UTC browser
gets no zone line. The browser zone is used, not the Dynatrace user setting, by the user's choice.

**Same problem, two root causes.** Two Assist runs on one problem disagreed: one filtered logs by
`dt.entity.service`, got zero records and blamed DB pool exhaustion from metrics; the other filtered by
`k8s.namespace.name`, found 1,671 ERROR logs (PSQLException, "canceling statement") starting 26 minutes
before the problem, and named a query bug. **Logs carry no service id** - none of a 15-minute sample on
isb54165 had `dt.entity.service`; most had `k8s.namespace.name` - and log levels vary (ERROR, SEVERE,
EMERGENCY, NONE). Assist cannot be made deterministic from an intent, so the prompt makes the evidence
the same: it says not to filter logs by service, lists the scope to filter on (the problem's
`k8s.namespace.name` / `k8s.workload.name` / `k8s.cluster.name` / `dt.entity.process_group`, set on 53
of 333 problems, plus the hosts and process instances of the services involved), defines what counts as
an error, and requires the checks run with their record counts (zero included) and the earliest anomaly
before the start. If runs still diverge, the next step is the app querying a fixed evidence set itself
and passing the summary.

**Compact prompt.** That prompt reached ~2,500 characters, mostly duplicated ids. It now names **one**
log scope - namespace and workload, else process group, else host - since several scopes let Assist pick
a broad one (a host) and drift; process instance ids are dropped (same logs as their process group);
lists stop at 5; times are UTC with one "Times in <zone>" line; rules are terse; and error logs are
checked first. On isb54165 (333 problems) prompts are 765-941 characters, median 826.

**Guessed names read as "no data".** Assist reported no error spans and no failure-rate series for a
service that had 42 failed spans in the window (diw85600). It had filtered spans by `status.code` and
queried `dt.service.request.failure_rate` - neither exists, and both return zero rows without an error.
Verified names: failed spans are `span.status_code == "error"` / `request.is_failed == true`
(`span.status_code` is set **only on failed spans**); the service request metrics are
`dt.service.request.count`, `.failure_count`, `.response_time` (no failure-rate metric). The prompt
now states those, plus a general rule: do not guess names, and before treating zero rows as evidence
check the field has values with `countIf(isNotNull(...))` - a one-record sample of a healthy span would
"prove" `span.status_code` missing. Prompts: 1,279-1,429 characters.

**Web application problems (bby34718).** A problem on `APPLICATION-34EA…` (www.inflight.koreanair.com)
had no link and an Assist answer of "no RUM data", while `user.events` held 13,996 requests, 547 user
actions and 479 errors for it in the window and `dt.frontend.user_action.duration` rose to 4.9 s. Assist
had followed the log-first prompt (logs carry no frontend id) and guessed `dt.rum.user_action.duration`;
new RUM metrics are `dt.frontend.*`, split by `dt.rum.application.entity` (also `dt.smartscape.frontend`,
`frontend.name`). Problems naming an `APPLICATION-…` now get a RUM-first prompt instead of the log lines.
The link goes to the frontend app on the problem: `FRONTEND-…` via `smartscapeNodes FRONTEND` `id_classic`
(hex differs from the APPLICATION id), with the problem's from/to and `problemId` = its event id.

**Assist's "data limitations" on P-2610775 (bby34718), checked.** Three claims in its answer were the
query, not the data:
- *"`user.events` cannot be binned by `event.start`"* - the field does not exist there (0 of 16,711
  records); the time field is `start_time`, present on every record. Timing is `duration`.
- *"No spans for SERVICE-D3AF…"* - true, and expected: it is `mdpt.co.kr`, a `WEB_REQUEST_SERVICE`
  with no process group, i.e. an external domain the app calls. Its calls are client spans on the
  caller, found by `server.address`: 333 from PaymentAuthenticationController to
  `mcoupon.mdpt.co.kr`, 314 failed - matching the service's 94.6% failure rate (15,200 / 16,064).
- *"Service name unknown"* - Smartscape has no node for it; the name is only in classic
  `dt.entity.service` (`entity.name`).
Each is now a line of the prompt (the `start_time` one only on the RUM branch). Prompt length on
bby34718: 1,550-1,700 characters for service problems, 1,836 for the RUM one.

**Let Assist look names up instead of listing them.** Field and metric names differ per tenant
(log levels: only `NONE` on bby34718 in that window, `ERROR` on isb54165), and a wrong name returns
zero rows with no error - `timeseries avg(dt.rum.user_action.duration)` returns an empty result. So
the prompt gives three lookup methods, checked on bby34718, isb54165 and diw85600:
- field names: `fetch … | limit 1 | fieldsKeep "*keyword*"` (wildcards work);
- values: `countIf(isNotNull(field))` over the window;
- metric keys and their dimensions: `fetch metric.series | filter startsWith(metric.key, "dt.frontend.")`.

**`fieldsSummary` cannot show a field is missing.** On `user.events` it reported `event.start` with
`count` 14,922 - every record - although the field does not exist there; it counts records, not
values. Use `countIf(isNotNull(...))`.

**Assist strips angle brackets.** The prompt line `countIf(isNotNull(<field>))` arrived in the Assist
panel as `countIf(isNotNull())` - `<field>` was taken as markup. Prompt text uses no `<word>` forms.
After the rewrite: 1,473 characters for the RUM problem, 1,537-1,687 for service problems.

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

## Starfield: raw root spans, sampled

The Starfield page plots every root span (`request.is_root_span == true`) in a short window as a
point: end time against duration. It is the only query that reads raw spans; metrics cannot draw it.

- **Spans are sampled.** Adaptive traffic management samples busy services at the agent, and
  aggregation folds calls together. On bby34718, 19,741 root spans in ten minutes stood for about
  265,000 requests; half the records were sampled, up to 512 requests each. Extrapolate with
  `coalesce(1 / ((power(2, 56) - coalesce(sampling.threshold, 0)) * power(2, -56)), 1) * coalesce(aggregation.count, 1)`.
  A point chart therefore shows the shape of the distribution, not every request: busy services
  are thinned the most, so counts and percentiles belong to the service metrics.
- **Volume.** Ten minutes on bby34718 was 19,730 records, about 4 s per query. The cap is 25,000,
  newest first (`sort end_time desc`), so a long window loses its oldest minutes and raises the
  truncation banner.
- **dtctl caps results at 1,000** unless given `--max-result-records`; it says so only in a warning
  line on stderr, before the JSON.
- Service names come from `dt.service.name` on the span; `service.name` was null on bby34718.
- Traces open with the Distributed Tracing intent `view-trace` (`trace.id` required; `span.id`
  and `timestamp` optional), listed by `dtctl get app dynatrace.distributedtracing`.

**Live mode is a billed scan per update.** Each update re-reads the last two minutes (late spans:
the newest root span on bby34718 was ~20 s old). Measured on bby34718: 112 MB scanned per update
against 0.53 GiB for a full ten-minute read, billed as "Traces - Query". Every ten seconds that was
~38 GiB an hour per open page - about half the tenant's whole daily trace-query volume in an
eight-hour shift. Hence: 30 s is the shortest interval, updates stop while the tab is hidden, and a
return reads from the last update so the hidden minutes leave no gap (one read of up to the window).

## Shared segment and tag filters

Segments and tags are chosen once (`SegmentsProvider`, `TagFilterProvider` in `App.tsx`) and hold on
every page. How each page applies them, verified on bby34718:

- **Topology:** unchanged - segments on every query except the entity list; tags filter the map.
- **Starfield:** segments on the span query. Tags inside the query, one
  `classicEntitySelector("type(SERVICE),tag(\"...\")")` per tag joined with `or` - tag() conditions
  inside one selector combine with AND. Root spans there carried a host but no `k8s.cluster.name`
  or `k8s.namespace.name` (0 of 20,238), so a Kubernetes segment empties the page.
- **Blast radius:** segments on the problem list only; the call graph, entity lookups and the
  description opt out with `filterSegments: []`. Tags match `entity_tags` after the per-problem
  summarize (`iAny(entity_tags[] == "...")`), the same strings as service tags but for every entity
  Davis attached, hosts included. Whether segments narrow `dt.davis.problems` could not be checked:
  dtctl has no option to apply a segment.
- Selector values escape `~` and `"` with a leading `~`.
