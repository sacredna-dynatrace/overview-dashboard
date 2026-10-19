import React, { useMemo, useState } from "react";
import { SearchInput } from "@dynatrace/strato-components/forms";
import { formatNodeValue, type TopologyNode } from "./TopologyGraph";

/**
 * Find a node by name and select it.
 *
 * The map draws ten nodes per column, so a search that only highlighted what is on screen would miss
 * most of a tenant with hundreds of services. This searches the whole map data and selects the match,
 * which re-anchors the map on it the way a click does. Pod names and process names are searched too
 * and resolve to the workload or process group they belong to - an alert usually names the pod.
 */

type Hit = {
  node: TopologyNode;
  /** What matched: the node's own name, or a pod or process inside it. */
  matched: string;
  via: "name" | "pod" | "process";
  /** Set when the whole query found nothing and this part of it did. */
  fragment?: string;
};

const MAX_RESULTS = 10;
const KIND_ORDER: Record<TopologyNode["kind"], number> = { service: 0, paas: 1, infrastructure: 2, rum: 3 };

export const kindLabel = (node: TopologyNode) =>
  node.kind === "service" ? "Service"
    : node.kind === "infrastructure" ? "Host"
    : node.kind === "rum" ? "RUM app"
    : node.members ? "Workload"
    : node.processes ? "Process group"
    : "Pod";

/** Pod node ids are `paas-<pod name>`. */
const podName = (memberId: string) => memberId.replace(/^paas-/, "");

/** Fragments shorter than this match too much to be worth showing. */
const MIN_FRAGMENT = 3;

/**
 * The parts of a pasted display name worth searching on their own.
 *
 * Dynatrace shows a process instance as "bin/nuxt.js (nuxt) focus-webfront-* (focus-webfront-6476fbc46c-jw4lg)"
 * - process group, then pod in brackets. No map name contains that whole string, but its pieces name
 * the pod and the service. So the bracketed values and the space-separated words are tried one by
 * one, with wildcards and the dangling separator before them removed ("focus-webfront-*" becomes
 * "focus-webfront").
 */
const fragmentsOf = (query: string): string[] => {
  const bracketed = [...query.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]);
  const words = query.replace(/\([^()]*\)/g, " ").split(/\s+/);
  const cleaned = [...bracketed, ...words]
    .map((part) => part.replace(/[*"'`]/g, "").replace(/^[-_.\s]+|[-_.\s]+$/g, "").trim())
    .filter((part) => part.length >= MIN_FRAGMENT);
  return [...new Set(cleaned)].filter((part) => part.toLowerCase() !== query.trim().toLowerCase());
};

const matchAll = (nodes: TopologyNode[], needle: string, fragment: string | undefined, base: number, hits: Map<string, Hit & { rank: number }>) => {
  const consider = (node: TopologyNode, text: string, via: Hit["via"]) => {
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) return;
    // A name that starts with the query beats one that only contains it; a node's own name beats a member's.
    const rank = base + (at === 0 ? 0 : 2) + (via === "name" ? 0 : 1);
    const known = hits.get(node.id);
    if (!known || rank < known.rank) hits.set(node.id, { node, matched: text, via, rank, fragment });
  };
  for (const node of nodes) {
    // The external-callers stand-in is not an entity anyone searches for.
    if (node.virtual) continue;
    consider(node, node.name, "name");
    for (const member of node.members ?? []) consider(node, podName(member), "pod");
    for (const process of node.processes ?? []) consider(node, process.name, "process");
  }
};

const searchMap = (nodes: TopologyNode[], query: string): Hit[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits = new Map<string, Hit & { rank: number }>();
  matchAll(nodes, needle, undefined, 0, hits);
  // Only when the whole query found nothing: a fragment hit ranks behind any whole-query hit anyway,
  // and showing both would bury the exact match under loose ones.
  if (hits.size === 0) for (const fragment of fragmentsOf(query)) matchAll(nodes, fragment.toLowerCase(), fragment, 10, hits);
  return [...hits.values()]
    .sort((a, b) => a.rank - b.rank || KIND_ORDER[a.node.kind] - KIND_ORDER[b.node.kind] || b.node.value - a.node.value || a.node.name.localeCompare(b.node.name))
    .slice(0, MAX_RESULTS);
};

export const MapSearch = ({ nodes, onPick }: { nodes: TopologyNode[]; onPick: (node: TopologyNode) => void }) => {
  const [query, setQuery] = useState("");
  const hits = useMemo(() => searchMap(nodes, query), [nodes, query]);
  const pick = (node: TopologyNode) => { onPick(node); setQuery(""); };
  return (
    <div className="map-search" onKeyDown={(event) => {
      if (event.key === "Enter" && hits[0]) pick(hits[0].node);
      if (event.key === "Escape") setQuery("");
    }}>
      <SearchInput value={query} onChange={setQuery} placeholder="Find service, workload, process or host" aria-label="Find a node on the map" />
      {query.trim() && <ul className="map-search-results" role="listbox" aria-label="Matching nodes">
        {hits.map(({ node, matched, via, fragment }) => <li key={node.id} role="option" aria-selected={false}>
          <button type="button" onClick={() => pick(node)}>
            <span className="map-search-kind">{kindLabel(node)}</span>
            <span className="map-search-name">
              <b>{node.name}</b>
              {via !== "name" && <em>{via} {matched}</em>}
              {fragment && <em>matched part “{fragment}”</em>}
            </span>
            <span className="map-search-value">{formatNodeValue(node)}</span>
          </button>
        </li>)}
        {hits.length === 0 && <li className="map-search-empty">No service, workload, process or host matches “{query.trim()}”.</li>}
      </ul>}
    </div>
  );
};
