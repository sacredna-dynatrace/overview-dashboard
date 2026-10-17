import React, { useMemo } from "react";
import type { BlastProblem, FrontendCall, ServiceInfo } from "../hooks/useBlastRadiusData";
import { STATUS, TIER, VIRTUAL } from "../theme/colors";

/**
 * A problem drawn as rings around its root cause.
 *
 * The centre is the Davis root cause. Ring 1 is what depends on it directly - the services that
 * call it, or for a host or process the services running there - and each further ring is whoever
 * calls the ring inside it, ending with the RUM applications that reach those services. So the
 * picture reads outward as "who is exposed if this breaks", and Davis's own verdict is laid over
 * it: entities Davis confirmed as affected are red, the rest of the dependency fan is drawn but
 * muted. The gap between the two is the point - one DB slowdown reached one API, but sixteen
 * services lean on that DB.
 *
 * Spread is ordered by the call graph, not by time: Davis stamps every event of a problem with the
 * same minute, so there is no timing to replay.
 */

export type BlastNode = {
  id: string;
  name: string;
  kind: "root" | "service" | "frontend" | "entity";
  ring: number;
  parent: string | null;
  affected: boolean;
  /** The edge to the parent: a call, the placement of a service on a host or process, or a grouped event. */
  relation: "calls" | "runs on" | "affected" | "event";
  /** One of a problem's concurrent events, with no causal link to the others. */
  event?: boolean;
};

/** Rings past the centre: two of services, then the RUM applications. More reads as noise. */
const SERVICE_RINGS = 2;
/** A ring beyond this many nodes says "+N more" instead of overlapping. Affected nodes go first. */
const RING_CAP = 14;
const VIEW = { width: 760, height: 620 };
const CENTRE = { x: VIEW.width / 2, y: VIEW.height / 2 - 6 };
const RADII = [0, 125, 210, 285];
const NODE_RADIUS = 15;
const ROOT_RADIUS = 26;
/** Delay between rings as the radius unfolds, and the particle speed inward. */
const RING_DELAY_MS = 380;
const PARTICLE_SECONDS = 2.2;

const truncate = (value: string, length: number) => (value.length > length ? `${value.slice(0, length - 1)}…` : value);

export type BlastLayout = {
  nodes: BlastNode[];
  hidden: number[];
  /** Confirmed affected entities that are on the map, and those in the dependency fan Davis did not flag. */
  affectedShown: number;
  exposedShown: number;
};

/**
 * Builds the rings for one problem. Pure, so the page can show the counts the graph will draw.
 */
export const buildBlastLayout = (problem: BlastProblem, services: Map<string, ServiceInfo>, frontendCalls: FrontendCall[]): BlastLayout => {
  const affectedIds = new Set(problem.affected.map((entity) => entity.id));
  const nameOf = (id: string) => services.get(id)?.name ?? problem.affected.find((entity) => entity.id === id)?.name ?? (id === problem.originId ? problem.originName ?? id : id);
  const events = problem.origin === "events";
  const rootId = problem.originId ?? `problem:${problem.displayId}`;
  const placed = new Map<string, BlastNode>();
  placed.set(rootId, { id: rootId, name: problem.originId ? nameOf(problem.originId) : `${problem.affected.length} events`, kind: "root", ring: 0, parent: null, affected: !events, relation: "affected" });
  const rings: BlastNode[][] = [[...placed.values()]];
  const hidden: number[] = [0];

  const place = (ring: number, candidates: BlastNode[]) => {
    const fresh = candidates.filter((node, index) => !placed.has(node.id) && candidates.findIndex((other) => other.id === node.id) === index);
    // Confirmed first, then alphabetical, so the cap never hides what Davis flagged.
    fresh.sort((a, b) => Number(b.affected) - Number(a.affected) || a.name.localeCompare(b.name));
    const kept = fresh.slice(0, RING_CAP);
    for (const node of kept) placed.set(node.id, node);
    rings[ring] = kept;
    hidden[ring] = fresh.length - kept.length;
    return kept;
  };
  const serviceNode = (id: string, ring: number, parent: string, relation: BlastNode["relation"]): BlastNode =>
    ({ id, name: nameOf(id), kind: services.has(id) || id.startsWith("SERVICE-") ? "service" : "entity", ring, parent, affected: affectedIds.has(id), relation });

  // Ring 1: what depends on the root directly.
  const firstRing: BlastNode[] = [];
  const root = problem.originId;
  if (root && services.has(root)) {
    for (const caller of services.get(root)?.calledBy ?? []) firstRing.push(serviceNode(caller, 1, rootId, "calls"));
  } else if (root) {
    // A host or process: the services placed on it are what it takes down.
    for (const service of services.values()) if (service.hosts.includes(root) || service.pgis.includes(root)) firstRing.push(serviceNode(service.id, 1, rootId, "runs on"));
  }
  // Whatever Davis flagged and the graph did not reach still belongs on the map, next to the centre.
  for (const entity of problem.affected) {
    if (entity.id === root || firstRing.some((node) => node.id === entity.id)) continue;
    // Concurrent events sit around the problem as events: Davis did not make them each other's impact.
    firstRing.push(events ? { ...serviceNode(entity.id, 1, rootId, "event"), affected: false, event: true } : serviceNode(entity.id, 1, rootId, "affected"));
  }
  let previous = place(1, firstRing);

  // Concurrent events stop at the events themselves: with no causal link there is no dependency fan to draw.
  if (events) {
    const nodes = rings.flat();
    return { nodes, hidden, affectedShown: 0, exposedShown: 0 };
  }

  // Further rings: the callers of the ring inside.
  for (let ring = 2; ring <= SERVICE_RINGS; ring += 1) {
    const next: BlastNode[] = [];
    for (const inner of previous) for (const caller of services.get(inner.id)?.calledBy ?? []) next.push(serviceNode(caller, ring, inner.id, "calls"));
    previous = place(ring, next);
  }

  // Outermost ring: RUM applications calling anything already on the map.
  const outer = SERVICE_RINGS + 1;
  const apps: BlastNode[] = [];
  for (const call of frontendCalls) {
    const target = placed.get(call.serviceId);
    if (target) apps.push({ id: `frontend:${call.appId}`, name: call.appName, kind: "frontend", ring: outer, parent: target.id, affected: false, relation: "calls" });
  }
  place(outer, apps);

  const nodes = rings.flat();
  const nonRoot = nodes.filter((node) => node.kind !== "root");
  return { nodes, hidden, affectedShown: nonRoot.filter((node) => node.affected).length, exposedShown: nonRoot.filter((node) => !node.affected && !node.event).length };
};

/** Angles per ring, with each node set near its parent so edges fan out instead of crossing. */
const positionNodes = (nodes: BlastNode[]) => {
  const positions = new Map<string, { x: number; y: number; angle: number }>();
  const byRing = new Map<number, BlastNode[]>();
  for (const node of nodes) byRing.set(node.ring, [...(byRing.get(node.ring) ?? []), node]);
  positions.set(nodes[0].id, { ...CENTRE, angle: 0 });
  for (const ring of [...byRing.keys()].filter((ring) => ring > 0).sort((a, b) => a - b)) {
    const members = byRing.get(ring) ?? [];
    const parentAngle = (node: BlastNode) => (node.parent ? positions.get(node.parent)?.angle ?? 0 : 0);
    members.sort((a, b) => (ring === 1 ? 0 : parentAngle(a) - parentAngle(b)));
    const radius = RADII[Math.min(ring, RADII.length - 1)];
    members.forEach((node, index) => {
      // Start at the top and go clockwise; a ring of one sits straight above its parent.
      const angle = members.length === 1 ? parentAngle(node) || -Math.PI / 2 : -Math.PI / 2 + (index / members.length) * Math.PI * 2;
      positions.set(node.id, { x: CENTRE.x + radius * Math.cos(angle), y: CENTRE.y + radius * Math.sin(angle), angle });
    });
  }
  return positions;
};

const kindColour = (node: BlastNode) => node.kind === "frontend" ? TIER.rum : node.kind === "service" ? TIER.service : TIER.infrastructure;

/** Where a node opens: the entity's own Dynatrace app, or null when there is no verified link for its type. */
export type BlastLinkOf = (node: BlastNode) => string | null;

export const BlastRadiusGraph = ({ problem, layout, linkOf }: { problem: BlastProblem; layout: BlastLayout; linkOf: BlastLinkOf }) => {
  const positions = useMemo(() => positionNodes(layout.nodes), [layout.nodes]);
  const centre = layout.nodes[0];
  return (
    <svg className="blast-canvas" viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} role="img" aria-label={`Blast radius of ${problem.title}`}>
      {RADII.slice(1).map((radius, index) => <circle key={radius} className="blast-ring-guide" cx={CENTRE.x} cy={CENTRE.y} r={radius} style={{ animationDelay: `${(index + 1) * RING_DELAY_MS}ms` }} />)}
      {layout.nodes.filter((node) => node.parent).map((node) => {
        const from = positions.get(node.id);
        const to = node.parent ? positions.get(node.parent) : undefined;
        if (!from || !to) return null;
        const path = `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
        // Calls flow inward, towards the thing that broke. Red when both ends were confirmed affected.
        const hot = node.affected && (layout.nodes.find((other) => other.id === node.parent)?.affected ?? false);
        return <g key={`edge-${node.id}`} className={`blast-edge${hot ? " is-hot" : ""}${node.relation === "runs on" ? " is-placement" : ""}${node.relation === "event" ? " is-event" : ""}`} style={{ animationDelay: `${node.ring * RING_DELAY_MS}ms` }}>
          <path d={path} />
          <title>{`${node.name} ${node.relation === "runs on" ? "runs on" : node.relation === "calls" ? "calls" : "affected with"} ${to === positions.get(centre.id) ? centre.name : layout.nodes.find((other) => other.id === node.parent)?.name ?? ""}`}</title>
          {node.relation !== "runs on" && node.relation !== "event" && [0, 1].map((index) => <circle key={index} className="blast-particle" r={hot ? 2.6 : 2}>
            <animateMotion dur={`${PARTICLE_SECONDS}s`} begin={`${(node.ring * RING_DELAY_MS) / 1000 + index * (PARTICLE_SECONDS / 2)}s`} repeatCount="indefinite" path={path} />
          </circle>)}
        </g>;
      })}
      {layout.hidden.map((count, ring) => count > 0 && <text key={`hidden-${ring}`} className="blast-hidden" x={CENTRE.x} y={CENTRE.y + RADII[Math.min(ring, RADII.length - 1)] + 30}>+{count} more in this ring</text>)}
      {layout.nodes.map((node) => {
        const position = positions.get(node.id);
        if (!position) return null;
        const isRoot = node.kind === "root";
        const radius = isRoot ? ROOT_RADIUS : NODE_RADIUS;
        // A new tab, so the radius stays where it was when the user comes back.
        const href = linkOf(node);
        const open = () => { if (href) window.open(href, "_blank", "noopener,noreferrer"); };
        return <g key={node.id} className={`blast-node${node.event ? " is-event" : node.affected ? " is-affected" : " is-exposed"}${isRoot ? " is-root" : ""}${href ? " is-linked" : ""}`} style={{ animationDelay: `${node.ring * RING_DELAY_MS}ms` }} transform={`translate(${position.x} ${position.y})`}
          {...(href ? { role: "link", tabIndex: 0, onClick: open, onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter") open(); } } : {})}>
          {isRoot && node.affected && <circle className="blast-pulse" r={radius} />}
          <circle r={radius} fill={isRoot && !problem.originId ? VIRTUAL.fill : "#fff"} stroke={node.affected ? STATUS.problem : node.event ? VIRTUAL.stroke : kindColour(node)} strokeWidth={node.affected ? 2.6 : 1.6} strokeDasharray={isRoot && !problem.originId ? "4 3" : undefined} />
          {node.event && <circle r={4.5} fill={VIRTUAL.text} />}
          {node.affected && <path d={isRoot ? "M-6,-6 L6,6 M6,-6 L-6,6" : "M-4,-4 L4,4 M4,-4 L-4,4"} stroke={STATUS.problem} strokeWidth="2" strokeLinecap="round" />}
          <text className="blast-label" y={radius + 13}>{truncate(node.name, isRoot ? 28 : 18)}</text>
          <title>{`${node.name}${isRoot ? (problem.origin === "root" ? " - Davis root cause" : problem.origin === "self" ? " - the problem is this entity's own (no root cause elsewhere)" : " - concurrent events grouped by Davis, no causal link") : node.event ? " - one of the concurrent events" : node.affected ? " - confirmed affected by Davis" : " - depends on the root, not flagged by Davis"}${href ? " · click to open in Dynatrace" : ""}`}</title>
        </g>;
      })}
    </svg>
  );
};
