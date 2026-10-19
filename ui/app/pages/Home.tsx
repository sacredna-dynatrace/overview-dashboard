import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Timeframe } from "@dynatrace/strato-components/core";
import { TimeframeSelector, TIMEFRAME_SELECTOR_PRESETS } from "@dynatrace/strato-components/filters";
import { MessageContainer } from "@dynatrace/strato-components/content";
import { Button } from "@dynatrace/strato-components/buttons";
import { getAppVersion } from "@dynatrace-sdk/app-environment";
import { RefreshControl } from "../components/RefreshControl";
import { TopologyGraph, formatEdgeValue, formatNodeValue, formatThroughput, type TopologyNode, type TopologySort } from "../components/TopologyGraph";
import { buildTileLinks, buildEntityLink } from "../components/TileLinks";
import { SortControl } from "../components/SortControl";
import { MapSearch } from "../components/MapSearch";
import { StatusIcon } from "../components/StatusMark";
import { paletteVars } from "../theme/colors";
import { CheckmarkIcon, CopyIcon, ExternalLinkIcon } from "@dynatrace/strato-icons";
import { useTopologyData, type TopologyQueryKey } from "../hooks/useTopologyData";
import { useNodeForecast, FORECAST_HORIZON_HOURS } from "../hooks/useNodeForecast";

// Read from the manifest at runtime so the badge cannot drift from app.config.json.
const appVersion = getAppVersion();
const APP_VERSION = appVersion.startsWith("dt.missing") ? "dev" : appVersion;

/** Forecast values are plain numbers, so they are formatted here rather than through a node. */
const formatForecast = (value: number, unit: string) => `${value >= 100 ? Math.round(value) : Number(value.toFixed(2))} ${unit}`;

const QUERY_LABELS: Record<TopologyQueryKey, string> = {
  rum: "RUM applications",
  service: "Services",
  infrastructure: "Infrastructure",
  problems: "Problems",
  serviceProcess: "Service → process → host placement",
  serviceProcessTraffic: "Service-to-process-group traffic",
  pods: "Kubernetes pods",
  podHost: "Pod-to-host placement",
  podHealth: "Pod utilization",
  podInventory: "Kubernetes pod inventory",
  rumService: "RUM-to-service",
  serviceHealth: "Service latency & failures",
  hostHealth: "Host resource usage",
  rumHealth: "RUM application metrics",
  rumErrors: "RUM error breakdown",
  affectedEntities: "Entities with open problems",
  serviceWorkload: "Service-to-workload traffic",
  entryServices: "Entry services (no service caller)",
};

/** `dt.service.request.response_time` is microseconds; step up the unit so it stays readable. */
const formatLatency = (micros: number) => {
  if (!Number.isFinite(micros) || micros <= 0) return "—";
  if (micros < 1000) return `${micros.toFixed(0)} µs`;
  if (micros < 1_000_000) return `${(micros / 1000).toFixed(micros < 10_000 ? 2 : 1)} ms`;
  return `${(micros / 1_000_000).toFixed(2)} s`;
};

const formatPercent = (value: number) => Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";

/** Kubernetes CPU figures arrive as millicores; keep sub-10 values from rounding to a flat zero. */
const formatMcore = (mcore: number) => Number.isFinite(mcore) ? `${mcore.toFixed(mcore < 10 ? 1 : 0)} mcore` : "—";

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];
const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${BYTE_UNITS[unit]}`;
};

type HealthRow = { label: string; value: string; critical?: boolean };

/** A DaemonSet can run a pod on every node, so the workload's pod list is capped. */
const WORKLOAD_PODS_SHOWN = 20;

/** Same shape as the Problems tile: total, then the impacted subset picked out in red. */
const withImpacted = ({ total, impacted }: { total: number; impacted: number }) =>
  <>{total}/<span className="metric-critical">{impacted}</span></>;

const initialTimeframe: Timeframe = {
  from: { value: "@d", absoluteDate: "", type: "expression" },
  to: { value: "now()", absoluteDate: "", type: "expression" },
};
// Midnight-to-midnight of the previous day. `-2d`/`-1d` would have been the rolling 24h window
// ending 24h ago, which is not what "Yesterday" means.
const yesterdayPreset = { from: "now()-1d@d", to: "now()@d" };

export const Home = () => {
  const [timeframe, setTimeframe] = useState<Timeframe>(initialTimeframe);
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const [autoRefreshMs, setAutoRefreshMs] = useState<number | null>(null);
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [selectedQuery, setSelectedQuery] = useState<TopologyQueryKey | null>(null);
  const [sortBy, setSortBy] = useState<TopologySort>("value");
  // Collapsed by default: on a large tenant the edge queries hit their cap on every load, so the
  // per-query breakdown would push the tiles below the fold every time somebody opens the page.
  // The headline stays, because a caveat nobody can see is the same as no caveat at all.
  const [truncationDetail, setTruncationDetail] = useState(false);
  /**
   * Feedback for the inspector's copy button. Reset after a moment, and whenever another query is
   * opened, so "Copied" never sits next to a query that was not the one copied.
   */
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { setCopyState("idle"); }, [selectedQuery]);
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);
  const { nodes, edges, map, isLoading, errors, refetch, queries, recordCounts, problems, kubernetes, serviceHealth, hostHealth, rumHealth, podHealth, problemsByEntity, truncated, orderInQuery } = useTopologyData(timeframe, refreshedAt, sortBy);
  const { forecast, isLoading: forecastLoading } = useNodeForecast(selectedNode);
  // Node values are comparable within a column, edge values are not, so the idle panel highlights
  // the busiest service rather than claiming a "highest traffic path" the edges cannot support.
  //
  // Only services the request metrics cover are eligible. A service known solely from the network
  // bytes query carries a `B/s` value, and ranking that against `req/min` crowned a 464 KB/s
  // service over one serving 97,000 requests a minute - a comparison between two different things.
  const busiestService = useMemo(() => {
    const byRequests = nodes.filter((node) => node.kind === "service" && node.unit === "req/min");
    const candidates = byRequests.length > 0 ? byRequests : nodes.filter((node) => node.kind === "service");
    return candidates.reduce<TopologyNode | undefined>((top, node) => !top || node.value > top.value ? node : top, undefined);
  }, [nodes]);
  // Derived once per data change - with 10k nodes these were linear scans on every single render.
  // Pods and workloads both: the panel names the map's workload nodes and lists the pods inside them.
  const nodesById = useMemo(() => new Map([...nodes, ...map.nodes].map((node) => [node.id, node] as const)), [map.nodes, nodes]);
  // Node ids carry a column prefix; the problem map is keyed on the bare Dynatrace entity id.
  const entityIdOf = (nodeId: string) => nodeId.replace(/^(rum|service|paas|infrastructure)-/, "");
  const counts = useMemo(() => {
    const tally = (kind: TopologyNode["kind"]) => {
      const ofKind = nodes.filter((node) => node.kind === kind);
      return { total: ofKind.length, impacted: ofKind.filter((node) => problemsByEntity.has(entityIdOf(node.id))).length };
    };
    return { rum: tally("rum"), service: tally("service"), paas: tally("paas"), infrastructure: tally("infrastructure") };
  }, [nodes, problemsByEntity]);
  const nodeName = (id: string) => nodesById.get(id)?.name ?? id;
  /**
   * How many pods have any service on them at all. The tile counts the full Smartscape inventory,
   * and the gap between the two is large enough (1 of 109 on the reference tenant) that the tile
   * has to name it. The map draws fewer still, since it only shows what its anchors reach.
   */
  const connectedPods = useMemo(() => {
    const linked = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    return nodes.filter((node) => node.kind === "paas" && linked.has(node.id)).length;
  }, [edges, nodes]);
  // A single RUM application in scope means the tile's link has an unambiguous target.
  const tileLinks = useMemo(() => {
    const rumNodes = nodes.filter((node) => node.kind === "rum");
    return buildTileLinks(timeframe, rumNodes.length === 1 ? rumNodes[0].entityId ?? null : null);
  }, [nodes, timeframe]);

  // A relative timeframe resolves to new timestamps on every refresh, which reruns the queries by
  // itself. A fully absolute one resolves to the same window, so it has to be refetched explicitly.
  const isAbsolute = timeframe.from.type === "iso8601" && timeframe.to.type === "iso8601";
  const refresh = useCallback(() => {
    setRefreshedAt(Date.now());
    if (isAbsolute) void refetch();
  }, [isAbsolute, refetch]);

  useEffect(() => {
    if (autoRefreshMs === null) return;
    const timer = setInterval(() => setRefreshedAt(Date.now()), autoRefreshMs);
    return () => clearInterval(timer);
  }, [autoRefreshMs]);

  return <main className="dashboard-page" style={paletteVars as React.CSSProperties}>
    <section className="dashboard-heading"><div><p className="eyebrow">SERVICE FLOW / LIVE OVERVIEW</p><h1>Application topology <span className="version-badge">v{APP_VERSION}</span></h1><p className="dashboard-description">Follow request traffic from real users through services to the infrastructure carrying the load.</p></div><div className="dashboard-actions"><TimeframeSelector value={timeframe} onChange={(value) => { if (value) { setTimeframe(value); setRefreshedAt(Date.now()); setSelectedNode(null); } }}><TimeframeSelector.Presets>{TIMEFRAME_SELECTOR_PRESETS.map((preset) => <TimeframeSelector.PresetItem key={`${preset.from}-${preset.to}`} value={preset} />)}<TimeframeSelector.PresetItem value={yesterdayPreset}>Yesterday</TimeframeSelector.PresetItem></TimeframeSelector.Presets></TimeframeSelector><RefreshControl intervalMs={autoRefreshMs} onIntervalChange={setAutoRefreshMs} onRefresh={refresh} isRefreshing={isLoading} /></div></section>
    {errors.length > 0 && <div className="query-message query-error" role="alert"><div className="query-error-list"><strong>{errors.length} of the dashboard’s queries failed. The rest of the page is still accurate.</strong>{errors.map((item) => <span key={item.label}><b>{item.label}:</b> {item.message}</span>)}</div><button type="button" onClick={refresh}>Retry</button></div>}
    {/* Truncation is silent on the platform side: a capped query returns its maximum and no error.
        A ranking built on a capped result can be wrong without anything on the page looking wrong,
        so it is called out here rather than left for someone to notice in the record counts. */}
    {truncated.length > 0 && (() => {
      const headline = `${truncated.length === 1 ? "One query hit its result limit" : `${truncated.length} queries hit their result limit`}. Counts and ranking may be incomplete.`;
      return <div className="query-notice"><MessageContainer variant="warning">
        <MessageContainer.Prefix />
        {truncationDetail && <MessageContainer.Title>{headline}</MessageContainer.Title>}
        <MessageContainer.Description>{truncationDetail
          ? <div className="query-error-list">{truncated.map((item) => <span key={item.key}><b>{QUERY_LABELS[item.key]}:</b> returned the maximum {item.cap.toLocaleString()} records, so it was almost certainly cut off.</span>)}{orderInQuery && <span>Sorting now re-runs those queries so the ranking comes from the full data set, which is why the map reloads when you change it.</span>}</div>
          : headline}</MessageContainer.Description>
        <MessageContainer.Actions>
          <Button onClick={() => setTruncationDetail((shown) => !shown)}>{truncationDetail ? "Hide details" : "Show details"}</Button>
        </MessageContainer.Actions>
      </MessageContainer></div>;
    })()}
    {isLoading && <div className="query-message" role="status">Loading topology traffic...</div>}
    {!isLoading && errors.length === 0 && nodes.length === 0 && <div className="query-message" role="status"><strong>No metric data found.</strong><span>Try Last 5 minutes or Last hour first. The selected environment may not retain RUM, service, host, or service-mesh metrics for this time range.</span></div>}
    {/* The number links out to the owning Dynatrace app; the footer line opens the DQL inspector.
        Two separate controls rather than an anchor nested inside a button, which is invalid HTML. */}
    <section className="metric-strip" aria-label="Topology summary">
      {([
        { key: "rum" as const, label: "RUM applications", value: withImpacted(counts.rum), href: tileLinks.rum, meta: "Total / with open problems · View DQL", title: "Open Frontend observability" },
        { key: "service" as const, label: "Connected services", value: withImpacted(counts.service), href: tileLinks.service, meta: "Total / with open problems · View DQL", title: "Open Services explorer" },
        { key: "pods" as const, label: "Kubernetes pods", value: withImpacted(counts.paas), href: tileLinks.paas, meta: `${connectedPods} connected to a service · ${kubernetes.clusters} cluster${kubernetes.clusters === 1 ? "" : "s"} · ${kubernetes.containers} container${kubernetes.containers === 1 ? "" : "s"} · View DQL`, title: "Open Kubernetes" },
        { key: "infrastructure" as const, label: "Infrastructure targets", value: withImpacted(counts.infrastructure), href: tileLinks.infrastructure, meta: "Total / with open problems · View DQL", title: "Open Hosts explorer" },
        { key: "problems" as const, label: "Problems", value: <>{problems.total}/<span className="metric-critical">{problems.active}</span></>, href: tileLinks.problems, meta: "Total / active · View DQL", title: "Open Problems" },
      ]).map((tile) => <div className="metric-tile" key={tile.key}>
        <span>{tile.label}</span>
        <a className="metric-value" href={tile.href} target="_blank" rel="noopener noreferrer" title={tile.title}>{tile.value}<ExternalLinkIcon /></a>
        <button type="button" onClick={() => setSelectedQuery(tile.key)}>{tile.meta}</button>
      </div>)}
    </section>
    {selectedQuery && <section className="query-inspector" aria-label="Executed DQL"><div className="query-inspector-heading"><div><strong>{QUERY_LABELS[selectedQuery]} DQL</strong><span>{recordCounts[selectedQuery]} records returned</span></div><div className="query-inspector-actions"><button type="button" onClick={() => { navigator.clipboard.writeText(queries[selectedQuery]).then(() => setCopyState("copied"), () => setCopyState("failed")); }} aria-label={`Copy ${QUERY_LABELS[selectedQuery]} DQL to clipboard`}>{copyState === "copied" ? <CheckmarkIcon /> : <CopyIcon />}{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}</button><button type="button" onClick={() => setSelectedQuery(null)}>Close</button></div></div><pre>{queries[selectedQuery]}</pre></section>}
    <section className="content-grid"><div className="graph-panel"><div className="panel-heading"><div><h2>Traffic map <span className="panel-badge">Smartscape</span></h2><p>Services and what connects to them · nodes and rates from metrics, relationships from the Smartscape topology</p><div className="panel-links"><button type="button" onClick={() => setSelectedQuery("rumService")}>RUM → service DQL</button><button type="button" onClick={() => setSelectedQuery("pods")}>Pods DQL</button><button type="button" onClick={() => setSelectedQuery("serviceWorkload")}>Service → workload traffic DQL</button><button type="button" onClick={() => setSelectedQuery("entryServices")}>Entry services DQL</button><button type="button" onClick={() => setSelectedQuery("serviceProcess")}>Service → process → host DQL</button><button type="button" onClick={() => setSelectedQuery("serviceProcessTraffic")}>Service → process traffic DQL</button></div></div><div className="panel-controls"><MapSearch nodes={map.nodes} onPick={setSelectedNode} /><SortControl value={sortBy} onChange={setSortBy} /><span className="live-indicator"><i /> Live</span></div></div>{nodes.length > 0 && <TopologyGraph nodes={map.nodes} edges={map.edges} sortBy={sortBy} selectedId={selectedNode?.id ?? null} onSelectionChange={setSelectedNode} />}</div><aside className="details-panel"><div className="panel-heading"><div><h2>{selectedNode ? selectedNode.name : "Busiest service"}</h2><p>{selectedNode ? selectedNode.subtitle : busiestService?.unit === "req/min" ? "Highest request rate in the Services column" : "Highest traffic in the Services column"}</p></div></div>{selectedNode ? <div className="selected-detail"><div className="detail-type">{selectedNode.virtual ? "not a monitored entity" : selectedNode.kind}</div><strong>{formatNodeValue(selectedNode)}</strong><span>Selected timeframe</span>{selectedNode.virtual && <p className="virtual-note">No RUM application reaches these services, and no other service is known to call them - OTLP-only services are included because their callers cannot be checked. This stands in for their callers - browsers, API clients, batch jobs - and its rate is the services' own request rate. The map shows the top services only, so the bands drawn add up to less than the total.</p>}{!selectedNode.members && !selectedNode.processes && !selectedNode.virtual && <a className="entity-link" href={buildEntityLink(selectedNode.kind, selectedNode.entityId ?? selectedNode.id.replace(/^(rum|service|paas|infrastructure)-/, ""), timeframe)} target="_blank" rel="noopener noreferrer">Open {selectedNode.name} in Dynatrace<ExternalLinkIcon /></a>}{(() => {
      const service = serviceHealth.get(selectedNode.id);
      const host = hostHealth.get(selectedNode.id);
      const rum = rumHealth.get(selectedNode.id);
      const pod = podHealth.get(selectedNode.id);
      let rows: HealthRow[] = [];
      let queryKey: TopologyQueryKey = "serviceHealth";
      let podList: React.ReactNode = null;
      if (selectedNode.members) {
        queryKey = "podHealth";
        // Totals across the workload's pods; a pod without utilization data contributes nothing.
        const members = selectedNode.members.flatMap((id) => {
          const node = nodesById.get(id);
          return node ? [{ node, health: podHealth.get(id) }] : [];
        });
        const sum = (pick: (health: NonNullable<typeof members[number]["health"]>) => number) =>
          members.reduce((total, { health }) => total + (health ? pick(health) : 0), 0);
        const running = sum((health) => health.containersRunning);
        const desired = sum((health) => health.containersDesired);
        rows = [
          { label: "Pods", value: `${members.length}` },
          { label: "With open problems", value: `${members.filter(({ node }) => (node.problems ?? 0) > 0).length}`, critical: members.some(({ node }) => (node.problems ?? 0) > 0) },
          { label: "CPU usage", value: formatMcore(sum((health) => health.cpuUsageMcore)) },
          { label: "Memory usage", value: formatBytes(sum((health) => health.memoryUsageBytes)) },
          { label: "Containers running", value: `${running}`, critical: desired > 0 && running < desired },
          { label: "Containers desired", value: `${desired}` },
        ];
        // Problems first, then the busiest, so the pod worth opening is at the top.
        const ordered = [...members].sort((a, b) => (b.node.problems ?? 0) - (a.node.problems ?? 0) || (b.health?.cpuUsageMcore ?? 0) - (a.health?.cpuUsageMcore ?? 0) || a.node.name.localeCompare(b.node.name));
        const shown = ordered.slice(0, WORKLOAD_PODS_SHOWN);
        podList = <><hr /><span>Pods</span><div className="workload-pods">{shown.map(({ node, health }) => <div className="workload-pod" key={node.id}>
          <StatusIcon problem={(node.problems ?? 0) > 0} />
          <a href={buildEntityLink("paas", node.entityId ?? node.name, timeframe)} target="_blank" rel="noopener noreferrer" title={node.name}>{node.name}</a>
          <b>{health ? formatMcore(health.cpuUsageMcore) : formatNodeValue(node)}</b>
        </div>)}{ordered.length > shown.length && <span className="workload-pods-more">+{ordered.length - shown.length} more pods</span>}</div></>;
      } else if (selectedNode.processes) {
        queryKey = "serviceProcess";
        const processes = selectedNode.processes;
        const hosts = new Set(processes.map((process) => process.host).filter(Boolean));
        rows = [
          { label: "Processes", value: `${processes.length}` },
          { label: "Hosts", value: `${hosts.size}` },
          { label: "With open problems", value: `${processes.filter((process) => process.problems > 0).length}`, critical: processes.some((process) => process.problems > 0) },
        ];
        // Problems first, then by host, so instances on the same machine sit together.
        const ordered = [...processes].sort((a, b) => b.problems - a.problems || a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
        const shown = ordered.slice(0, WORKLOAD_PODS_SHOWN);
        podList = <><hr /><span>Processes</span><div className="workload-pods">{shown.map((process) => <div className="workload-pod" key={process.id}>
          <StatusIcon problem={process.problems > 0} />
          <span className="workload-process-name" title={process.name}>{process.name}</span>
          <b>{process.host || "—"}</b>
        </div>)}{ordered.length > shown.length && <span className="workload-pods-more">+{ordered.length - shown.length} more processes</span>}</div></>;
      } else if (service) {
        rows = [
          { label: "Latency p50", value: formatLatency(service.p50Micros) },
          { label: "Latency p95", value: formatLatency(service.p95Micros) },
          { label: "Failure rate", value: `${service.failureRate.toFixed(2)}%`, critical: service.failureRate > 0 },
          { label: "Requests", value: service.requests.toLocaleString() },
        ];
      } else if (rum) {
        queryKey = "rumHealth";
        rows = [
          { label: "Users", value: rum.users.toLocaleString() },
          { label: "Avg response time", value: rum.durationMillis > 0 ? `${rum.durationMillis.toFixed(0)} ms` : "—" },
          { label: "Sessions", value: rum.sessions.toLocaleString() },
          { label: "Requests", value: rum.requests.toLocaleString() },
          { label: "JS errors", value: rum.jsErrors.toLocaleString(), critical: rum.jsErrors > 0 },
          { label: "HTTP errors", value: rum.httpErrors.toLocaleString(), critical: rum.httpErrors > 0 },
          // CSP violations and anything else Dynatrace classifies as a frontend error.
          { label: "Other errors", value: rum.otherErrors.toLocaleString(), critical: rum.otherErrors > 0 },
          { label: "Total errors", value: (rum.jsErrors + rum.httpErrors + rum.otherErrors).toLocaleString(), critical: rum.jsErrors + rum.httpErrors + rum.otherErrors > 0 },
        ];
      } else if (pod) {
        queryKey = "podHealth";
        // Mirrors the CPU / Memory / Containers cards of the Kubernetes app's pod utilization panel.
        const pair = (request: number | null, limit: number | null, format: (value: number) => string) =>
          request === null && limit === null ? "not set" : `${request === null ? "—" : format(request)} / ${limit === null ? "—" : format(limit)}`;
        rows = [
          { label: "CPU usage", value: formatMcore(pod.cpuUsageMcore) },
          { label: "CPU req / limit", value: pair(pod.cpuRequestsMcore, pod.cpuLimitsMcore, formatMcore) },
          { label: "Memory usage", value: formatBytes(pod.memoryUsageBytes) },
          { label: "Memory req / limit", value: pair(pod.memoryRequestsBytes, pod.memoryLimitsBytes, formatBytes) },
          { label: "Containers running", value: `${pod.containersRunning}`, critical: pod.containersDesired > 0 && pod.containersRunning < pod.containersDesired },
          { label: "Containers desired", value: `${pod.containersDesired}` },
        ];
      } else if (host) {
        queryKey = "hostHealth";
        rows = [
          { label: "Memory usage", value: formatPercent(host.memoryPercent), critical: host.memoryPercent >= 90 },
          { label: "Disk used (max)", value: formatPercent(host.diskUsedPercent), critical: host.diskUsedPercent >= 90 },
          { label: "Network in", value: formatThroughput(host.networkInPerSecond) },
          { label: "Network out", value: formatThroughput(host.networkOutPerSecond) },
        ];
      }
      if (rows.length === 0) return null;
      return <><hr /><div className="health-grid">{rows.map((row) => <div key={row.label}><span>{row.label}</span><b className={row.critical ? "is-critical" : undefined}>{row.value}</b></div>)}</div><button type="button" className="health-link" onClick={() => setSelectedQuery(queryKey)}>View DQL</button>{podList}</>;
    })()}{(forecastLoading || forecast) && <><hr /><span>Davis forecast · next {FORECAST_HORIZON_HOURS} h</span>{forecastLoading
      ? <div className="forecast-pending">Analysing…</div>
      : forecast && <div className="forecast-row"><b>{forecast.trend >= 0 ? "▲" : "▼"} {formatForecast(forecast.predicted, forecast.unit)}</b><span>90% band {formatForecast(forecast.lower, forecast.unit)}–{formatForecast(forecast.upper, forecast.unit)} · predicted from the last 24 h</span></div>}</>}<hr /><span>Connections</span>{map.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id).map((edge) => <div className="connection-row" key={edge.id}><span>{nodeName(edge.source === selectedNode.id ? edge.target : edge.source)}</span><b>{formatEdgeValue(edge)}</b></div>)}</div> : busiestService ? <div className="path-detail"><span className="path-kicker">SERVICE</span><strong>{busiestService.name}</strong><div className="path-rate">{formatNodeValue(busiestService)}</div><p>Click any node in the map to focus it: the other columns switch to the pods, hosts and applications it connects to.</p></div> : <div className="path-detail"><p>Topology details will appear once the queries return entities.</p></div>}</aside></section>
  </main>;
};
