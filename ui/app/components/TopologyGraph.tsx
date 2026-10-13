import React, { useMemo, useState } from "react";
import { ACTIVE, GRID, PROCESS_GROUP, STATUS, TIER as TIER_COLORS, VIRTUAL } from "../theme/colors";
import { StatusIcon, StatusMark } from "./StatusMark";

export type TopologyNode = {
  id: string;
  name: string;
  kind: "rum" | "service" | "paas" | "infrastructure";
  subtitle: string;
  /** Metric value for the selected timeframe. Its meaning depends on `unit`. */
  value: number;
  /** Unit shown next to `value` - request rates and host link utilization are not comparable. */
  unit: string;
  /**
   * Dynatrace entity id, when the node id is not built from one. Pod nodes are keyed by pod name,
   * because their metrics are, so without this they could never match the alert map.
   */
  entityId?: string;
  /** Open problems affecting this entity, for the "Problems first" ordering. */
  problems?: number;
  /** `k8s.workload.name` of a pod, which is what the map groups pods by. */
  workload?: string;
  /** Namespace of a pod or workload, for matching traffic whose cluster name differs. */
  namespace?: string;
  /** Set on a workload node only: the pod node ids it stands for. */
  members?: string[];
  /** Set on a process-group node only: its processes, which exist on the map only through it. */
  processes?: { id: string; classicId: string; name: string; host: string; problems: number }[];
  /** A stand-in rather than an entity - the external callers of entry services without RUM. */
  virtual?: boolean;
};

/**
 * How each column picks its top entities. `value` means something different per column - req/min
 * for services, container count for pods, % CPU for hosts - so it only ranks within a column, never
 * across them.
 */
export type TopologySort = "value" | "problems" | "connections" | "name";

export type TopologyEdge = {
  id: string;
  source: string;
  target: string;
  /** Rate per minute. What is being counted depends on the unit below. */
  value: number;
  /** e.g. "calls/min" for span-derived calls, "traces/min" for RUM correlation. */
  unit: string;
  /**
   * `call` is one tier invoking another and is drawn with an arrowhead. `hosting` is the traffic a
   * service puts on the host running it - nothing is being invoked, so it gets no arrowhead; an
   * arrow there reads as "the service calls the host", which is not what the relationship is.
   */
  kind: "call" | "hosting";
  /** Shown instead of the value when the source knows the relationship but not its volume. */
  label?: string;
  /**
   * Set when `value` is the service's whole rate, carried over because the service runs in exactly
   * one place - inferred from the topology, not split out of the metric.
   */
  inferred?: boolean;
  /** Failed requests per minute within `value`, on measured edges only. */
  failures?: number;
};

type TopologyGraphProps = {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  sortBy: TopologySort;
  onSelectionChange: (node: TopologyNode | null) => void;
};

// Four columns of 120px nodes inside a 1000px canvas, which is what the graph panel offers at the
// dashboard max width - wider than this and the shell starts scrolling horizontally.
const NODE_WIDTH = 120;
const NODE_HALF = NODE_WIDTH / 2;
const columnX = { rum: 80, service: 360, paas: 640, infrastructure: 920 } as const;
const columnLabels = { rum: "RUM applications", service: "Services", paas: "Workloads / processes", infrastructure: "Infrastructure" } as const;
const colors = TIER_COLORS;
/** Process groups share the workload column, so their outline is what tells the two apart. */
const outline = (node: TopologyNode) => node.processes ? PROCESS_GROUP : colors[node.kind];
/**
 * The mark inside a node reports health, not which column the node is in - the column is already
 * given by its position under a labelled heading and by the box outline, so the mark is free to
 * carry something the map could not otherwise show. Its shape carries it too (`StatusMark`).
 */
const VIRTUAL_COLOR = VIRTUAL.stroke;
/**
 * Band widths. Request rates across services span several orders of magnitude, so width follows
 * the square root of the rate - linear made every band but the busiest one a hairline.
 */
const BAND_MIN = 3;
const BAND_MAX = 22;
/** Below this the rate label would sit on a band too thin to belong to; the tooltip still has it. */
const BAND_LABEL_MIN = 7;
/** Space kept clear at the top and bottom of a node where bands are stacked. */
const PORT_PAD = 6;
/**
 * Particles riding the bands, so measured traffic reads as moving rather than as a static pipe.
 *
 * Density carries the rate, on a log scale so a 30 req/min band still visibly flows next to a
 * 900 req/min one. Speed is the same everywhere: a faster particle would read as "more traffic" or
 * "lower latency", and nothing here measures either per edge. Animated with SMIL `animateMotion`,
 * so there is no render loop and no per-frame React work.
 */
const PARTICLE_SPEED = 120;
const MAX_PARTICLES = 240;
const particlesFor = (perMinute: number) => Math.max(1, Math.min(10, Math.round(1 + 2 * Math.log10(1 + perMinute))));
/** The external-callers node carries a third line, shown against total. */
const VIRTUAL_MIN_HEIGHT = 74;
const CANVAS_WIDTH = 1000;
const ROW_HEIGHT = 92;
const NODE_HEIGHT = 58;
const FIRST_ROW_Y = 88;
/**
 * The summary tiles count every entity the queries return, but the map draws only the top few per
 * column and says how many it left out. On a tenant with hundreds of services anything larger is a
 * wall of crossing edges rather than a topology, so the cap is what makes the picture readable -
 * the sort control is how you decide which few matter.
 */
const MAX_DRAWN_PER_COLUMN = 10;

/** Column order, used to keep a traversal from doubling back on itself. */
const TIER: Record<TopologyNode["kind"], number> = { rum: 0, service: 1, paas: 2, infrastructure: 3 };

/** Sorts after every node that has a placed neighbour, without the NaN that Infinity - Infinity gives. */
const UNPARENTED = Number.MAX_SAFE_INTEGER;

/**
 * A service the request metrics do not cover still gets a node from the network-bytes query, so one
 * column can hold both `req/min` and `B/s` values. Comparing those raw numbers ranked a 464 KB/s
 * service above a 97,000 req/min one purely because bytes are the bigger number. Values in the
 * column's own unit sort first, and only values sharing a unit are compared against each other.
 */
const SECONDARY_UNITS = new Set(["B/s"]);
const unitRank = (node: TopologyNode) => SECONDARY_UNITS.has(node.unit) ? 1 : 0;

/** Keeps low-traffic entities legible: 0.01 req/min must not round away to 0.0. */
const formatNumber = (value: number) => value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);

const THROUGHPUT_UNITS = ["B/s", "KB/s", "MB/s", "GB/s"];
/** Byte rates span too many orders of magnitude for a fixed unit, so step up as needed. */
export const formatThroughput = (bytesPerSecond: number) => {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < THROUGHPUT_UNITS.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${THROUGHPUT_UNITS[unit]}`;
};

const formatValue = (value: number, unit: string) => {
  if (unit === "B/s") return formatThroughput(value);
  if (unit === "containers") return value > 0 ? `${value} container${value === 1 ? "" : "s"}` : "— containers";
  if (unit === "pods") return `${value} pod${value === 1 ? "" : "s"}`;
  if (unit === "processes") return `${value} process${value === 1 ? "" : "es"}`;
  return `${formatNumber(value)} ${unit}`;
};
export const formatNodeValue = (node: TopologyNode) => formatValue(node.value, node.unit);
/** Only a measured request rate is drawn as a Sankey band; everything else is a relationship. */
export const isMeasured = (edge: TopologyEdge) => edge.unit === "req/min" && edge.value > 0;
export const formatEdgeValue = (edge: TopologyEdge) => isMeasured(edge)
  ? `${formatValue(edge.value, edge.unit)}${edge.label ? ` · ${edge.label}` : ""}${edge.inferred ? " · inferred: single placement" : ""}`
  : edge.label ?? formatValue(edge.value, edge.unit);

export const TopologyGraph = ({ nodes, edges, sortBy, onSelectionChange }: TopologyGraphProps) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const degrees = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }
    return counts;
  }, [edges]);
  /**
   * Which nodes the map draws, and how near each one is to what the map is about.
   *
   * Ranking every column independently over the whole tenant produced a map with almost no edges:
   * the ten busiest services, the ten biggest pods and the ten hottest hosts are different
   * entities, and an edge is only drawn when both of its ends happen to be on screen. On a tenant
   * with 546 services the three rankings essentially never coincide, so the map degenerated into
   * three unrelated lists - a service could show four `runs on` relationships in the details panel
   * and not a single line on the canvas.
   *
   * So the columns are anchored instead. With nothing selected the anchors are the top services,
   * connected ones first, and the other columns show what those services reach. Selecting a node
   * makes it the sole anchor, which is what turns a click into "show me this thing's pods and
   * hosts". Nodes are then ordered by hop distance before the chosen sort, so the nearest
   * relatives fill the ten slots.
   *
   * Traversal is monotonic in tier: from an anchor it may go outward (service to pod to host) or
   * inward (host to pod to service), but never turn around. Without that, a host would drag in
   * every other pod sharing it, which is how unrelated pods reached the map before.
   */
  const neighbours = useMemo(() => {
    const map = new Map<string, string[]>();
    const link = (from: string, to: string) => {
      const known = map.get(from);
      if (known) known.push(to); else map.set(from, [to]);
    };
    for (const edge of edges) { link(edge.source, edge.target); link(edge.target, edge.source); }
    return map;
  }, [edges]);
  // Every ordering falls back to value, so ties stay deterministic instead of shuffling between
  // renders - a column that reorders on refresh is harder to read than one that is merely capped.
  const compare = useMemo(() => {
    const byValue = (a: TopologyNode, b: TopologyNode) => unitRank(a) - unitRank(b) || b.value - a.value || a.name.localeCompare(b.name);
    return (a: TopologyNode, b: TopologyNode) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "problems") return (b.problems ?? 0) - (a.problems ?? 0) || byValue(a, b);
      if (sortBy === "connections") return (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0) || byValue(a, b);
      return byValue(a, b);
    };
  }, [degrees, sortBy]);
  const hops = useMemo(() => {
    const kindOf = new Map(nodes.map((node) => [node.id, node.kind]));
    const anchors = selectedId && kindOf.has(selectedId)
      ? [selectedId]
      // An unconnected service anchors nothing, so connected ones take the slots first - otherwise
      // the default map can pick ten busy services that happen to have no topology and draw no
      // lines at all.
      : nodes.filter((node) => node.kind === "service")
        .sort((a, b) => Number((degrees.get(b.id) ?? 0) > 0) - Number((degrees.get(a.id) ?? 0) > 0) || compare(a, b))
        .slice(0, MAX_DRAWN_PER_COLUMN)
        .map((node) => node.id);
    const best = new Map<string, number>();
    let frontier = anchors.map((id) => ({ id, direction: 0 }));
    for (const { id } of frontier) best.set(id, 0);
    // Three hops is the whole map: rum - service - pod - host.
    for (let hop = 1; hop <= 3 && frontier.length > 0; hop += 1) {
      const next: { id: string; direction: number }[] = [];
      for (const { id, direction } of frontier) {
        const fromKind = kindOf.get(id);
        if (!fromKind) continue;
        for (const other of neighbours.get(id) ?? []) {
          const otherKind = kindOf.get(other);
          if (!otherKind || best.has(other)) continue;
          const step = Math.sign(TIER[otherKind] - TIER[fromKind]);
          if (step === 0 || (direction !== 0 && step !== direction)) continue;
          best.set(other, hop);
          next.push({ id: other, direction: step });
        }
      }
      frontier = next;
    }
    return best;
  }, [compare, degrees, neighbours, nodes, selectedId]);
  /** The anchor's own column keeps the chosen sort; every other column follows it. */
  const anchorKind = useMemo(() => (selectedId ? nodesById.get(selectedId)?.kind : undefined) ?? "service", [nodesById, selectedId]);
  const columns = useMemo(() => {
    const placed = new Map<string, number>();
    const built = new Map<TopologyNode["kind"], { kind: TopologyNode["kind"]; drawn: TopologyNode[]; hidden: number }>();
    // Columns are filled outward from the anchor, so a column's parents are always already ordered
    // by the time it is laid out.
    const outward = (Object.keys(columnX) as TopologyNode["kind"][])
      .sort((a, b) => Math.abs(TIER[a] - TIER[anchorKind]) - Math.abs(TIER[b] - TIER[anchorKind]));
    for (const kind of outward) {
      // `hidden` counts what is related to the anchors but did not fit, not the whole tenant. Once a
      // selection narrows the map, "+545 more not drawn" under a focused service would be true of
      // the inventory and useless on the canvas. The tiles are where the tenant totals live.
      const related = nodes.filter((node) => node.kind === kind && hops.has(node.id));
      // Where the node's highest-placed neighbour sits in the column before it. Ordering by that is
      // what makes the busiest service's pods come first and its hosts after them, so the lines run
      // across the map instead of crossing it. Pod container counts are almost always 1, so without
      // this the pod column fell back to alphabetical and bore no relation to the service order.
      const parentRank = (node: TopologyNode) => {
        let nearest = UNPARENTED;
        for (const other of neighbours.get(node.id) ?? []) {
          const index = placed.get(other);
          if (index !== undefined && index < nearest) nearest = index;
        }
        return nearest;
      };
      const drawn = related
        .map((node) => ({ node, rank: parentRank(node), hop: hops.get(node.id) ?? 0 }))
        .sort((a, b) => Number(Boolean(a.node.virtual)) - Number(Boolean(b.node.virtual)) || a.rank - b.rank || a.hop - b.hop || compare(a.node, b.node))
        .slice(0, MAX_DRAWN_PER_COLUMN)
        .map((entry) => entry.node);
      drawn.forEach((node, index) => placed.set(node.id, index));
      built.set(kind, { kind, drawn, hidden: related.length - drawn.length });
    }
    // Back into canvas order: the layout indexes columns by their position on screen.
    return (Object.keys(columnX) as TopologyNode["kind"][]).map((kind) => built.get(kind) ?? { kind, drawn: [], hidden: 0 });
  }, [anchorKind, compare, hops, neighbours, nodes]);
  /**
   * Rows are assigned per column, then nudged so that an edge which skips a column has a clear
   * corridor through it.
   *
   * A service placed straight onto a host crosses the pod column. Routing that edge around the
   * nodes produced a long sagging detour; moving the one node that sits in its way is both tidier
   * and keeps every edge close to straight, which is what makes a layered map readable.
   */
  const layout = useMemo(() => {
    const rowOf = new Map<string, number>();
    columns.forEach(({ kind, drawn }) => drawn.forEach((node, index) => rowOf.set(`${kind}:${node.id}`, index)));
    const yOfRow = (row: number) => FIRST_ROW_Y + row * ROW_HEIGHT;
    // Column and row key are fixed for the render, so they are resolved once instead of scanned
    // per edge per pass. With the edge cap at 5000 the old linear lookups ran millions of times.
    const placement = new Map<string, { column: number; key: string }>();
    columns.forEach(({ kind, drawn }, column) => drawn.forEach((node) => placement.set(node.id, { column, key: `${kind}:${node.id}` })));
    // Only edges between two drawn nodes can push anything around, and that is a few dozen of them.
    const layoutEdges = edges.filter((edge) => placement.has(edge.source) && placement.has(edge.target));

    // Bounded: each pass can only push nodes down, and a handful of passes settles the arrangement.
    for (let pass = 0; pass < 8; pass += 1) {
      let moved = false;
      for (const edge of layoutEdges) {
        const source = placement.get(edge.source);
        const target = placement.get(edge.target);
        if (!source || !target) continue;
        const sourceColumn = source.column;
        const targetColumn = target.column;
        const sourceRow = rowOf.get(source.key);
        const targetRow = rowOf.get(target.key);
        if (sourceRow === undefined || targetRow === undefined) continue;
        const [from, to] = sourceColumn < targetColumn ? [sourceColumn, targetColumn] : [targetColumn, sourceColumn];
        if (to - from < 2) continue;
        for (let column = from + 1; column < to; column += 1) {
          const progress = (column - sourceColumn) / (targetColumn - sourceColumn);
          const lineY = yOfRow(sourceRow) + (yOfRow(targetRow) - yOfRow(sourceRow)) * progress;
          for (const node of columns[column].drawn) {
            const key = `${columns[column].kind}:${node.id}`;
            const row = rowOf.get(key) ?? 0;
            if (Math.abs(yOfRow(row) - lineY) < NODE_HEIGHT / 2 + 10) { rowOf.set(key, row + 1); moved = true; }
          }
        }
      }
      if (!moved) break;
    }

    const positions = new Map<string, { x: number; y: number }>();
    let lastRow = 0;
    columns.forEach(({ kind, drawn }) => drawn.forEach((node) => {
      const row = rowOf.get(`${kind}:${node.id}`) ?? 0;
      lastRow = Math.max(lastRow, row);
      positions.set(node.id, { x: columnX[kind], y: yOfRow(row) });
    }));
    // Per column, the row just past its lowest node - a node nudged down must not end up under
    // the "more not drawn" label.
    const overflowRow = columns.map(({ kind, drawn }) =>
      drawn.reduce((lowest, node) => Math.max(lowest, (rowOf.get(`${kind}:${node.id}`) ?? 0) + 1), 0));
    return { positions, rows: lastRow + 1, overflowRow };
  }, [columns, edges]);
  const positions = layout.positions;
  const drawnNodes = useMemo(() => columns.flatMap((column) => column.drawn), [columns]);
  // The map holds thousands of edges but draws only the ones joining two visible nodes.
  const drawnEdges = useMemo(() => edges.filter((edge) => positions.has(edge.source) && positions.has(edge.target)), [edges, positions]);
  /**
   * Sankey bands for the edges with a measured rate, stacked at each end like a Sankey port.
   *
   * One scale covers every band on screen, so a band's width can be compared with any other. Where
   * a node's bands would not fit its height they are squeezed, and the squeeze applies to the whole
   * band rather than one end, so it never changes width along its length. The external-callers node
   * instead grows to hold all of its bands, which is what makes it read as the source of the flow.
   */
  const bands = useMemo(() => {
    const flows = drawnEdges.filter(isMeasured);
    const peak = flows.reduce((max, edge) => Math.max(max, edge.value), 0);
    const raw = new Map(flows.map((edge) => [edge.id, BAND_MIN + (BAND_MAX - BAND_MIN) * Math.sqrt(peak > 0 ? edge.value / peak : 0)] as const));
    const sum = (list: TopologyEdge[], widths: Map<string, number>) => list.reduce((total, edge) => total + (widths.get(edge.id) ?? 0), 0);
    const ends = (side: "source" | "target") => {
      const byNode = new Map<string, TopologyEdge[]>();
      for (const edge of flows) {
        const list = byNode.get(edge[side]);
        if (list) list.push(edge); else byNode.set(edge[side], [edge]);
      }
      return byNode;
    };
    const outgoing = ends("source");
    const incoming = ends("target");
    const heights = new Map<string, number>();
    for (const node of drawnNodes) if (node.virtual) heights.set(node.id, Math.max(VIRTUAL_MIN_HEIGHT, sum(outgoing.get(node.id) ?? [], raw) + 2 * PORT_PAD));
    const heightOf = (id: string) => heights.get(id) ?? NODE_HEIGHT;
    // Nodes are drawn from their top edge, so a taller node's centre moves down rather than up.
    const centreOf = (id: string) => (positions.get(id)?.y ?? 0) - NODE_HEIGHT / 2 + heightOf(id) / 2;
    const squeeze = (byNode: Map<string, TopologyEdge[]>) => new Map([...byNode].map(([id, list]) => {
      const total = sum(list, raw);
      const room = heightOf(id) - 2 * PORT_PAD;
      return [id, total > room ? room / total : 1] as const;
    }));
    const outSqueeze = squeeze(outgoing);
    const inSqueeze = squeeze(incoming);
    const width = new Map(flows.map((edge) => [edge.id, (raw.get(edge.id) ?? 0) * Math.min(outSqueeze.get(edge.source) ?? 1, inSqueeze.get(edge.target) ?? 1)] as const));
    const offsets = new Map<string, { source: number; target: number }>();
    const stack = (byNode: Map<string, TopologyEdge[]>, side: "source" | "target") => {
      const other = side === "source" ? "target" : "source";
      for (const list of byNode.values()) {
        // Ordered by where the far end sits, so bands leave a node without crossing each other.
        list.sort((a, b) => centreOf(a[other]) - centreOf(b[other]));
        let cursor = -sum(list, width) / 2;
        for (const edge of list) {
          const band = width.get(edge.id) ?? 0;
          const entry = offsets.get(edge.id) ?? { source: 0, target: 0 };
          entry[side] = cursor + band / 2;
          offsets.set(edge.id, entry);
          cursor += band;
        }
      }
    };
    stack(outgoing, "source");
    stack(incoming, "target");
    /**
     * What the drawn bands out of each virtual node add up to. The node's own value covers every
     * entry service, most of which sit outside the ten drawn, so on its own it disagreed with the
     * bands leaving it - and a Sankey is read by matching what goes in with what comes out.
     */
    const shown = new Map([...heights.keys()].map((id) => [id, (outgoing.get(id) ?? []).reduce((total, edge) => total + edge.value, 0)] as const));
    return { width, offsets, heights, heightOf, centreOf, shown };
  }, [drawnEdges, drawnNodes, positions]);
  const particleScale = useMemo(() => {
    const wanted = [...bands.width.keys()].reduce((total, id) => total + particlesFor(drawnEdges.find((edge) => edge.id === id)?.value ?? 0), 0);
    return wanted > MAX_PARTICLES ? MAX_PARTICLES / wanted : 1;
  }, [bands.width, drawnEdges]);
  /** How far below its row a grown node reaches, so the column's overflow label and the canvas clear it. */
  const virtualBottom = (kind: TopologyNode["kind"]) => drawnNodes.reduce((lowest, node) => {
    const position = positions.get(node.id);
    return node.kind === kind && node.virtual && position ? Math.max(lowest, position.y - NODE_HEIGHT / 2 + bands.heightOf(node.id)) : lowest;
  }, 0);
  // Each column holds one node per entity, so the canvas has to grow instead of clipping them.
  const canvasHeight = Math.max(430, FIRST_ROW_Y + layout.rows * ROW_HEIGHT + (columns.some((column) => column.hidden > 0) ? 34 : 0), virtualBottom("rum") + 50);
  const selectNode = (node: TopologyNode) => {
    const nextId = selectedId === node.id ? null : node.id;
    setSelectedId(nextId);
    onSelectionChange(nextId ? node : null);
  };
  /**
   * Every relationship edge is drawn at the same weight; only measured edges become bands.
   *
   * Thickness used to scale with `edge.value` for every edge, which only works when the values are
   * comparable. They are not: Smartscape supplies no volume, so calls, "runs in" and pod-to-host
   * edges all carry 0 and only the service-to-host edge has a byte rate. That made one edge the
   * thickest possible and every other edge the thinnest. Bands are restricted to `req/min` edges
   * with a rate (`isMeasured`) for the same reason.
   */
  const EDGE_WIDTH = 3;
  const failedShare = (edge: TopologyEdge) => edge.failures !== undefined && edge.value > 0 ? ` · ${((edge.failures / edge.value) * 100).toFixed(2)}% failed` : "";
  const describeEdge = (edge: TopologyEdge) => `${nodesById.get(edge.source)?.name ?? edge.source} → ${nodesById.get(edge.target)?.name ?? edge.target}: ${formatEdgeValue(edge)}${failedShare(edge)}`;

  /**
   * An edge between neighbouring columns can run straight across, but one that skips a column - a
   * service placed directly on a host, with no pod in between - would otherwise be drawn straight
   * through the column it skips, passing behind the nodes there and reading as if it connected to
   * them. Those are routed through a clear lane below every node instead, so the detour is visible.
   */
  /**
   * One shape for every edge. The layout pass has already cleared a corridor for edges that skip a
   * column, so nothing needs routing around an obstacle - a flat S-curve between the two nodes is
   * straighter and far easier to follow than the detour this replaced.
   */
  const edgeGeometry = (source: { x: number; y: number }, target: { x: number; y: number }) => {
    const startX = source.x + NODE_HALF;
    const endX = target.x - NODE_HALF;
    const midX = (startX + endX) / 2;
    return {
      path: `M ${startX} ${source.y} C ${midX} ${source.y}, ${midX} ${target.y}, ${endX} ${target.y}`,
      labelX: midX,
      labelY: (source.y + target.y) / 2 - 8,
    };
  };

  return (
    <div className="topology-shell">
      <div className="topology-column-labels" aria-hidden="true">
        {(Object.keys(columnX) as TopologyNode["kind"][]).map((kind) => <span key={kind} style={{ left: columnX[kind] - NODE_HALF }}>{columnLabels[kind]}</span>)}
      </div>
      <svg className="topology-canvas" style={{ height: canvasHeight }} viewBox={`0 0 ${CANVAS_WIDTH} ${canvasHeight}`} role="img" aria-label="Application, service, Kubernetes and infrastructure topology">
        <defs>
          <pattern id="topology-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill={GRID} opacity="0.42" /></pattern>
          {/*
            markerUnits defaults to strokeWidth, which multiplied the arrowhead by the line weight -
            a busy edge at strokeWidth 8.5 rendered a ~68px triangle. userSpaceOnUse pins it to a
            constant size, so the head stays the same no matter how heavy the edge is.
            Markers do not inherit the referencing path's stroke, hence one per state.
          */}
          <marker id="topology-arrow" markerUnits="userSpaceOnUse" markerWidth="20" markerHeight="16" refX="18" refY="8" orient="auto"><path d="M0,1.5 L18,8 L0,14.5 Z" fill={colors.service} /></marker>
          <marker id="topology-arrow-active" markerUnits="userSpaceOnUse" markerWidth="20" markerHeight="16" refX="18" refY="8" orient="auto"><path d="M0,1.5 L18,8 L0,14.5 Z" fill={ACTIVE} /></marker>
        </defs>
        <rect width={CANVAS_WIDTH} height={canvasHeight} fill="url(#topology-grid)" />
        {drawnEdges.map((edge) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          const active = selectedId === edge.source || selectedId === edge.target;
          const band = bands.width.get(edge.id);
          if (band !== undefined) {
            const offset = bands.offsets.get(edge.id) ?? { source: 0, target: 0 };
            const geometry = edgeGeometry({ x: source.x, y: bands.centreOf(edge.source) + offset.source }, { x: target.x, y: bands.centreOf(edge.target) + offset.target });
            const from = nodesById.get(edge.source);
            const colour = from?.virtual ? VIRTUAL_COLOR : colors[from?.kind ?? "service"];
            const sourceY = bands.centreOf(edge.source) + offset.source;
            const targetY = bands.centreOf(edge.target) + offset.target;
            const count = Math.max(1, Math.round(particlesFor(edge.value) * particleScale));
            /**
             * The failed share of the particles, rounded to whole particles - so a band with a
             * fraction of a percent failing shows none, and the tooltip carries the exact rate.
             * Spread evenly rather than bunched, so the red reads as a proportion of the stream.
             */
            const failedCount = Math.round(count * Math.min(1, (edge.failures ?? 0) / edge.value));
            const isFailed = (index: number) => Math.floor(((index + 1) * failedCount) / count) > Math.floor((index * failedCount) / count);
            // Wide bands get three lanes so the particles fill the band instead of riding its centre line.
            const lanes = band >= 10 ? [-band / 4, 0, band / 4] : [0];
            const seconds = (Math.hypot(target.x - source.x - NODE_WIDTH, targetY - sourceY) * 1.1) / PARTICLE_SPEED;
            return <g key={edge.id} className={`topology-band${active ? " is-active" : ""}${edge.inferred ? " is-inferred" : ""}`} opacity={selectedId && !active ? 0.55 : 1}>
              <path d={geometry.path} stroke={colour} strokeWidth={band} />
              {Array.from({ length: count }, (_, index) => {
                const lane = lanes[index % lanes.length];
                const route = edgeGeometry({ x: source.x, y: sourceY + lane }, { x: target.x, y: targetY + lane }).path;
                // Negative begin spreads the particles along the band from the first frame.
                const failed = isFailed(index);
                return <circle key={index} className={`topology-particle${failed ? " is-failed" : ""}`} r={Math.min(3.2, Math.max(1.6, band * 0.18)) + (failed ? 0.6 : 0)} fill={failed ? STATUS.problem : colour}>
                  <animateMotion dur={`${seconds.toFixed(2)}s`} begin={`-${((index * seconds) / count).toFixed(2)}s`} repeatCount="indefinite" path={route} />
                </circle>;
              })}
              <title>{describeEdge(edge)}</title>
              {band >= BAND_LABEL_MIN && <text x={geometry.labelX} y={geometry.labelY - band / 2 + 4} textAnchor="middle" className="topology-edge-label">{formatValue(edge.value, edge.unit)}</text>}
            </g>;
          }
          const geometry = edgeGeometry({ x: source.x, y: bands.centreOf(edge.source) }, { x: target.x, y: bands.centreOf(edge.target) });
          // A static pipe carries the weight of the edge; a thinner dashed line rides on top of the
          // identical path and animates to show direction of flow.
          const hosting = edge.kind === "hosting";
          const flowClass = `topology-edge-flow${hosting ? " is-hosting" : ""}${active ? " is-active" : ""}`;
          // Edges away from the selection are softened, not hidden. At 0.18 this was near invisible,
          // which made sense when the map drew the whole tenant and a selection had to be picked out
          // of it. Now a selection re-anchors the columns, so everything still on screen is part of
          // the chain the user asked to see - the pod-to-host hop included.
          return <g key={edge.id} opacity={selectedId && !active ? 0.55 : 1}>
            <path className="topology-edge-pipe" d={geometry.path} strokeWidth={EDGE_WIDTH} />
            <path className={flowClass} d={geometry.path} strokeWidth={EDGE_WIDTH - 1} markerEnd={hosting ? undefined : active ? "url(#topology-arrow-active)" : "url(#topology-arrow)"} />
            <title>{describeEdge(edge)}</title>
          </g>;
        })}
        {columns.map(({ kind, hidden }, column) => hidden > 0 && <text key={`overflow-${kind}`} x={columnX[kind]} y={Math.max(FIRST_ROW_Y + layout.overflowRow[column] * ROW_HEIGHT - 8, virtualBottom(kind) + 22)} textAnchor="middle" className="topology-overflow-label">+{hidden} more not drawn</text>)}
        {drawnNodes.map((node) => {
          const position = positions.get(node.id);
          if (!position) return null;
          const selected = selectedId === node.id;
          const problems = node.problems ?? 0;
          const select = () => selectNode(node);
          const onKey = (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") selectNode(node); };
          // No health dot: there is no entity behind it to have a problem.
          if (node.virtual) return <g key={node.id} className="topology-node is-virtual" role="button" tabIndex={0} aria-label={`${node.name}, ${formatNodeValue(node)}, not a monitored entity`} onClick={select} onKeyDown={onKey}>
            <rect x={position.x - NODE_HALF} y={position.y - NODE_HEIGHT / 2} width={NODE_WIDTH} height={bands.heightOf(node.id)} rx="8" fill={VIRTUAL.fill} stroke={selected ? ACTIVE : VIRTUAL_COLOR} strokeWidth={selected ? 3 : 1.5} strokeDasharray="5 4" />
            <title>{`${node.name} - ${node.subtitle}. Stands in for whatever calls these services; not a monitored entity.`}</title>
            <text x={position.x - NODE_HALF + 12} y={position.y - 9} className="topology-node-name">{node.name}</text>
            {(() => {
              const shown = bands.shown.get(node.id) ?? 0;
              // Rounded the way the label is, so a rounding difference never reads as a gap.
              const partial = Math.round(shown) < Math.round(node.value);
              return <>
                <text x={position.x - NODE_HALF + 12} y={position.y + 9} className="topology-node-meta">{partial ? `${formatNumber(shown)} shown` : formatNodeValue(node)}</text>
                {partial && <text x={position.x - NODE_HALF + 12} y={position.y + 24} className="topology-node-meta">{`${formatNumber(node.value)} total req/min`}</text>}
              </>;
            })()}
          </g>;
          return <g key={node.id} className="topology-node" role="button" tabIndex={0} aria-label={`${node.name}, ${formatNodeValue(node)}${problems > 0 ? `, ${problems} open problems` : ", no open problems"}`} onClick={() => selectNode(node)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") selectNode(node); }}><rect x={position.x - NODE_HALF} y={position.y - 29} width={NODE_WIDTH} height="58" rx="8" fill="white" stroke={selected ? ACTIVE : outline(node)} strokeWidth={selected ? 3 : 1.5} /><StatusMark x={position.x - NODE_HALF + 16} y={position.y} problem={problems > 0} /><title>{problems > 0 ? `${node.name} - ${problems} open problem${problems === 1 ? "" : "s"}` : node.name}</title><text x={position.x - NODE_HALF + 28} y={position.y - 4} className="topology-node-name">{node.name.length > 14 ? `${node.name.slice(0, 13)}…` : node.name}</text><text x={position.x - NODE_HALF + 28} y={position.y + 14} className="topology-node-meta">{formatNodeValue(node)}</text>{(node.members ?? node.processes) && <g className="topology-node-badge"><rect x={position.x + NODE_HALF - 38} y={position.y - 38} width="34" height="18" rx="9" fill={outline(node)} /><text x={position.x + NODE_HALF - 21} y={position.y - 25} textAnchor="middle">×{(node.members ?? node.processes)?.length}</text></g>}</g>;
        })}
      </svg>
      {/* Edge swatches reuse the node palette so the legend cannot drift from the CSS. */}
      <div className="topology-legend">
        {/* The column swatches this replaces were redundant - each column is labelled directly
            above it - and a coloured dot in the legend now has to mean what a node's dot means. */}
        <span><StatusIcon problem={false} /> No open problems</span>
        <span><StatusIcon problem /> Has open problems</span>
        <span className="topology-legend-divider" aria-hidden="true" />
        <span>
          <svg className="legend-edge" viewBox="0 0 34 10" aria-hidden="true">
            <path d="M1,5 H33" stroke={colors.service} strokeOpacity="0.4" strokeWidth="8" fill="none" />
          </svg>
          Measured traffic (req/min)
        </span>
        <span>
          <svg className="legend-edge" viewBox="0 0 34 10" aria-hidden="true">
            <path d="M1,5 H33" stroke={colors.service} strokeOpacity="0.4" strokeWidth="8" fill="none" />
            <circle cx="10" cy="5" r="2.4" fill={colors.service} />
            <circle cx="22" cy="5" r="3" fill={STATUS.problem} className="topology-particle is-failed" />
          </svg>
          Failed requests
        </span>
        <span>
          <svg className="legend-edge" viewBox="0 0 34 10" aria-hidden="true">
            <rect x="1" y="1" width="32" height="8" rx="2" fill={VIRTUAL.fill} stroke={VIRTUAL_COLOR} strokeDasharray="3 2" />
          </svg>
          External callers (no RUM)
        </span>
        <span>
          <svg className="legend-edge" viewBox="0 0 34 10" aria-hidden="true">
            <path d="M1,5 H22" stroke={colors.service} strokeWidth="2" strokeLinecap="round" strokeDasharray="5 4" fill="none" />
            <path d="M23,1.2 L32,5 L23,8.8 Z" fill={colors.service} />
          </svg>
          Call
        </span>
        <span>
          <svg className="legend-edge" viewBox="0 0 34 10" aria-hidden="true">
            <path d="M1,5 H33" stroke={colors.infrastructure} strokeWidth="2" strokeLinecap="round" strokeDasharray="5 4" fill="none" />
          </svg>
          Hosting
        </span>
      </div>
      {selectedId && nodesById.get(selectedId) && <button className="clear-selection" type="button" onClick={() => selectNode(nodesById.get(selectedId) as TopologyNode)}>Clear selection</button>}
    </div>
  );
};
