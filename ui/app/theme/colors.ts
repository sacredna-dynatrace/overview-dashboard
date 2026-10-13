/**
 * The app's semantic colours, in one place.
 *
 * The map draws with them directly, and `paletteVars` hands the same values to the stylesheet as
 * custom properties, so an edge in CSS and a node in SVG cannot drift apart. Page chrome (panels,
 * text, borders) is not here - it belongs to the Strato design tokens.
 */

/**
 * One colour per map column. Kept to blues, violets and a neutral slate: red is reserved for problems
 * and failures, green for healthy, and nothing on the map is yellow or orange - an orange host column
 * read as a warning when nothing was wrong.
 */
export const TIER = { rum: "#8b5cf6", service: "#0ea5a4", paas: "#2563eb", infrastructure: "#475569" } as const;

/**
 * A process group, which shares the workload column. Violet rather than the pink it was: pink sat
 * next to the problem red and made healthy process groups look like they were failing.
 */
export const PROCESS_GROUP = "#6d28d9";

/** Health. Never shown by colour alone - see `StatusMark`. */
export const STATUS = { ok: "#16a36d", problem: "#c9143c" } as const;

/** The external-callers stand-in: grey and dashed, so nobody mistakes it for a monitored entity. */
export const VIRTUAL = { stroke: "#94a3b8", fill: "#f8fafc", text: "#475569" } as const;

/** A selected node or the edges touching it. */
export const ACTIVE = "#0284c7";

/** Canvas dot grid. */
export const GRID = "#cbd5e1";

/** The palette as CSS custom properties, set once on the page root. */
export const paletteVars = {
  "--tier-rum": TIER.rum,
  "--tier-service": TIER.service,
  "--tier-paas": TIER.paas,
  "--tier-infrastructure": TIER.infrastructure,
  "--status-ok": STATUS.ok,
  "--status-problem": STATUS.problem,
  "--virtual-text": VIRTUAL.text,
  "--active": ACTIVE,
} as const;
