import { getLanguage } from "@dynatrace-sdk/user-preferences";
import type { BlastProblem } from "./hooks/useBlastRadiusData";

/**
 * "Explain problem", the way the Problems app does it: Dynatrace Assist declares an `ask-question`
 * intent (manifest of `dynatrace.davis.copilot` on isb54165) that opens as an overlay panel and,
 * with `execute`, runs the prompt straight away. No `contexts` are sent: the accepted context types
 * are not documented, and the prompt names the problem and its entities outright.
 */
export const ASSIST_INTENT = { recommendedAppId: "dynatrace.davis.copilot", recommendedIntentId: "ask-question" } as const;

/**
 * How far before the problem's start Assist is asked to look: long enough to catch the deployment,
 * restart or saturation that led into it, short enough to keep the log and trace queries it runs
 * cheap. Asking for "all relevant data" without a window invites broad scans.
 */
export const ANALYSIS_LEAD_MINUTES = 30;
/** Entities named in the prompt; beyond this the rest are counted, so the prompt stays readable. */
const PROMPT_ENTITY_LIMIT = 10;

/**
 * The user's preferred language as an English name ("Korean"), or null for English or anything
 * unreadable.
 *
 * Sent from this app, Assist answered in English where the Problems app got Korean for the same user
 * and prompt - whatever the Problems app passes along, this app does not - so the language is asked
 * for explicitly. Read through Intl so `ko` and `ko-KR` both work; the SDK does not document which
 * form it returns, and outside the Dynatrace runtime it may throw.
 */
export const answerLanguage = (): string | null => {
  try {
    const code = getLanguage();
    if (!code || /^en([-_]|$)/i.test(code)) return null;
    // The base language only: "Korean", not "Korean (South Korea)".
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code.split(/[-_]/)[0]) ?? null;
  } catch {
    return null;
  }
};

/** Minute precision in UTC, the way Assist and DQL read timestamps. */
const isoMinute = (time: number) => `${new Date(time).toISOString().slice(0, 16)}Z`;
/**
 * Entities go by id only. Their names are free text and carry whatever the monitored software calls
 * itself: "Netty on 0:0:0:0:0:0:0:0:*" made Assist reject the whole prompt as an IP_ADDRESS under its
 * PII blocking. An id is never personal data, and Assist resolves it to the entity on its own - its
 * queries go by id anyway.
 */
const describeEntity = (id: string) => id;

/**
 * The question sent to Assist.
 *
 * It carries what the page already knows, so Assist does not have to rediscover it: with only the
 * display id, Assist first searched the last 72 hours, found nothing and had to search again. The
 * exact window, the origin as the page reads it, and the affected entities point its log, metric and
 * trace queries at the right place; the requested structure asks for evidence and the DQL behind it,
 * and for "not supported by the data" instead of a guess.
 */
export const explainPrompt = (problem: BlastProblem, language: string | null = answerLanguage()): string => {
  const start = Date.parse(problem.start);
  const end = Date.parse(problem.end);
  const hasWindow = Number.isFinite(start);
  const when = !hasWindow ? ""
    : problem.active ? `, which started at ${isoMinute(start)} and is still open`
    : `, which started at ${isoMinute(start)} and ended at ${isoMinute(Number.isFinite(end) ? end : start)}`;
  const origin = problem.origin === "root" && problem.rootId
    ? `Root cause reported by Davis: ${describeEntity(problem.rootId)}.`
    : problem.origin === "self" && problem.originId
      ? `The problem originated in ${describeEntity(problem.originId)} itself; Davis found no cause elsewhere.`
      : "Davis grouped concurrent events on the entities below and recorded no causal link between them.";
  const named = problem.affected.slice(0, PROMPT_ENTITY_LIMIT).map((entity) => describeEntity(entity.id)).join(", ");
  const more = problem.affected.length > PROMPT_ENTITY_LIMIT ? `, and ${problem.affected.length - PROMPT_ENTITY_LIMIT} more` : "";
  const window = hasWindow
    ? `from ${isoMinute(start - ANALYSIS_LEAD_MINUTES * 60_000)} (${ANALYSIS_LEAD_MINUTES} minutes before the start) until ${problem.active ? "now" : "the end of the problem"}`
    : "around the time of the problem";
  return [
    `Investigate Davis problem ${problem.displayId} "${problem.title}"${when}.`,
    origin,
    named ? `Affected entities: ${named}${more}.` : "",
    `Analyze the relevant logs, metrics, traces and events for these entities, ${window}, and determine the root cause as precisely as possible.`,
    "In your answer:",
    "1. What happened, as a timeline.",
    "2. The root cause and the evidence for it - which data and which values; include the DQL queries you used.",
    "3. The impact.",
    "4. Concrete remediation steps.",
    "5. How to prevent it from recurring.",
    "If the data does not support a conclusion, say so instead of guessing.",
    language ? `Please answer in ${language}.` : "",
  ].filter(Boolean).join("\n");
};
