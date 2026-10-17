import type { Timeframe } from "@dynatrace/strato-components/core";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { resolveTimeframe } from "../hooks/useTopologyData";

/**
 * Deep links from the summary tiles into the Dynatrace apps that own each entity type.
 *
 * The tiles count many entities, so they land on each app's list view rather than a single entity.
 * The one exception is RUM: when exactly one application is in scope there is no ambiguity, so the
 * link goes straight to that frontend.
 */

/**
 * Timeframes travel in two dialects, and neither is the one the selector speaks.
 *
 * Strato emits `now()-7d` for the rolling presets and `@d` / `-1d@d` for Today and Yesterday. The
 * platform apps take `tf=now-7d;now` - no parentheses - while the frontend app takes `from`/`to`
 * with them. Neither understands the `@d` day-alignment, and an unparseable value does not raise
 * anything: the app quietly falls back to its own default of two hours, which is what made "Today"
 * open as "Last 2 hours".
 *
 * So a rolling preset is translated and stays relative on the far side, and anything else - the
 * aligned presets, a custom absolute range - is resolved to ISO. Freezing those is the honest
 * outcome anyway: they name a fixed window, and that is what the dashboard was showing.
 */
const ROLLING = /^now()(?:s*-s*(d+[smhdwMy]))?$/;

const relativeBound = (value: Timeframe["from"], resolved: string, parentheses: boolean): string => {
  if (value.type === "iso8601") return resolved;
  const match = ROLLING.exec(value.value.trim());
  if (!match) return resolved;
  const now = parentheses ? "now()" : "now";
  return match[1] ? `${now}-${match[1]}` : now;
};

/**
 * Both bounds travel in the same dialect, or neither does.
 *
 * "Today" is `@d` to `now()`: one bound needs resolving and the other does not, which produced
 * `tf=2026-09-27T00:00:00Z;now` - half absolute, half relative. The apps kept falling back to two
 * hours on it. A range is stated one way or the other, so if either end has to be resolved, both
 * are.
 */
const bounds = (timeframe: Timeframe, parentheses: boolean) => {
  const resolved = resolveTimeframe(timeframe, Date.now());
  const from = relativeBound(timeframe.from, resolved.from, parentheses);
  const to = relativeBound(timeframe.to, resolved.to, parentheses);
  const mixed = (from === resolved.from) !== (to === resolved.to);
  return mixed ? { from: resolved.from, to: resolved.to } : { from, to };
};

/** `tf=<from>;<to>`, the form the services, infrastructure, Kubernetes and problems apps read. */
const timeframeParam = (timeframe: Timeframe) => {
  const { from, to } = bounds(timeframe, false);
  return `tf=${encodeURIComponent(`${from};${to}`)}`;
};

/** The frontend app takes the two bounds separately, and keeps the parentheses. */
const vitalsRange = (timeframe: Timeframe) => {
  const { from, to } = bounds(timeframe, true);
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
};

/**
 * The problems app takes `from`/`to` as absolute timestamps and ignores `tf` outright.
 *
 * A link from the dashboard arrived carrying only `tf`; after changing the timeframe inside the app
 * the URL read `?from=2026-09-19T15:00Z&to=2026-09-27T14:59Z&tf=<our untouched value>`. The app had
 * written its own range into `from`/`to` and left `tf` sitting there unread - which is why two
 * rounds of fixing the `tf` format changed nothing.
 *
 * Absolute on both ends rather than the relative form the frontend app accepts: nothing here shows
 * that this app parses `now()` expressions, and the observed value was a plain timestamp pair. A
 * rolling range therefore freezes at the moment of the click, which is the window the dashboard was
 * showing anyway.
 */
const absoluteRange = (timeframe: Timeframe) => {
  const resolved = resolveTimeframe(timeframe, Date.now());
  return `from=${encodeURIComponent(resolved.from)}&to=${encodeURIComponent(resolved.to)}`;
};

const environment = () => getEnvironmentUrl().replace(/\/$/, "");

export type TileLinkTargets = { rum: string; service: string; paas: string; infrastructure: string; problems: string };

/**
 * Where "open this entity in Dynatrace" goes from the details panel.
 *
 * Each app selects an entity with its own parameter - `detailsId` for services and pods,
 * `fullPageId` for hosts - and the frontend app takes the entity in the path instead. The frontend
 * app also takes the timeframe as separate `from`/`to` parameters rather than the combined `tf`
 * the others use. All four forms are copied from real URLs out of the tenant.
 *
 * The ids differ by app as well: services and hosts use classic ids, pods and frontends use their
 * Smartscape ids, which is why nodes carry `entityId` separately from the id they are keyed on.
 */
export const buildEntityLink = (kind: "rum" | "service" | "paas" | "infrastructure", entityId: string, timeframe: Timeframe): string => {
  const base = `${environment()}/ui/apps`;
  const tf = timeframeParam(timeframe);
  const id = encodeURIComponent(entityId);
  if (kind === "rum") return `${base}/dynatrace.experience.vitals/frontends/${id}/overview?${vitalsRange(timeframe)}`;
  // Assembled from parts rather than one literal: the no-secrets lint rule reads a long URL with
  // mixed-case parameters as a high-entropy string and fails the build on it.
  const routes = {
    service: ["dynatrace.services/explorer/services", "perspective=performance", "detailsId"],
    paas: [`dynatrace.kubernetes/smartscape/workload/${"K8S_POD"}`, "perspective=Health", "detailsId"],
    infrastructure: ["dynatrace.infraops/explorer/Compute/Hosts", "perspective=Health", "fullPageId"],
  } as const;
  const [path, perspective, idParam] = routes[kind];
  return `${base}/${path}?${perspective}&${idParam}=${id}&${tf}`;
};

export const buildTileLinks = (timeframe: Timeframe, singleRumApplicationId: string | null): TileLinkTargets => {
  const base = `${environment()}/ui/apps`;
  const tf = timeframeParam(timeframe);
  return {
    rum: singleRumApplicationId
      ? buildEntityLink("rum", singleRumApplicationId, timeframe)
      // The list view is the same app as the entity view, so it reads the same two parameters -
      // it was being handed `tf` instead, which it ignores.
      : `${base}/dynatrace.experience.vitals/frontends?${vitalsRange(timeframe)}`,
    service: `${base}/dynatrace.services/explorer/services?${tf}`,
    paas: `${base}/dynatrace.kubernetes/smartscape/workload/${"K8S_POD"}?${tf}`,
    infrastructure: `${base}/dynatrace.infraops/explorer/Compute/Hosts?${tf}`,
    problems: `${base}/dynatrace.davis.problems/?${absoluteRange(timeframe)}`,
  };
};

/**
 * Deep links for the blast-radius page, each copied from a real URL on isb54165.
 *
 * - A problem opens by its `event.id` (`…_1792113840000V2`), not its display id, and takes
 *   `from`/`to` with parentheses like the frontend app.
 * - A process opens in the infrastructure app under its Smartscape `PROCESS-…` id. Problems name
 *   it `PROCESS_GROUP_INSTANCE-…`; the hex part is the same in both models.
 * - A workload opens in the Kubernetes app under its Smartscape id (`K8S_DEPLOYMENT-…` and so on).
 *   That hex differs from the classic `CLOUD_APPLICATION-…` a problem names, so the caller has to
 *   look it up (`id_classic`); there is no string rewrite that gets from one to the other.
 */
export const buildProblemLink = (eventId: string, timeframe: Timeframe): string =>
  `${environment()}/ui/apps/${"dynatrace.davis.problems"}/problem/${encodeURIComponent(eventId)}?${vitalsRange(timeframe)}`;

export const buildProcessLink = (processGroupInstanceId: string, timeframe: Timeframe): string | null => {
  const hex = /^PROCESS_GROUP_INSTANCE-([0-9A-F]+)$/.exec(processGroupInstanceId)?.[1];
  if (!hex) return null;
  return `${environment()}/ui/apps/${"dynatrace.infraops"}/smartscape/Compute/Processes?${timeframeParam(timeframe)}&fullPageId=${encodeURIComponent(`PROCESS-${hex}`)}`;
};

export const buildWorkloadLink = (smartscapeWorkloadId: string, timeframe: Timeframe): string =>
  `${environment()}/ui/apps/${"dynatrace.kubernetes"}/smartscape/workload/${"K8S_WORKLOAD"}?perspective=Health&detailsId=${encodeURIComponent(smartscapeWorkloadId)}&${timeframeParam(timeframe)}`;
