import { getLanguage, getRegionalFormat } from "@dynatrace-sdk/user-preferences";
import type { BlastProblem } from "./hooks/useBlastRadiusData";

/**
 * "Analyze problem" - the Problems app's "Explain problem", asking for more: Dynatrace Assist declares an `ask-question`
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
 * The language Assist is asked to answer in, chosen next to the button.
 *
 * Why the prompt has to say it: the Korean answers came from the user's Assist personalization
 * ("Please provide answer in Korean"), not from their Dynatrace language, which is English - and
 * the first prompt this app sends to a freshly opened Assist panel is answered before that
 * personalization applies, so it came back in English while later ones were Korean. The app cannot
 * read Assist's settings, so the user picks the language here and the prompt states it.
 */
export type AnswerLanguage = "ko" | "en" | "auto";
export const ANSWER_LANGUAGES: { value: AnswerLanguage; label: string }[] = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
  { value: "auto", label: "Auto" },
];
/** Korean by default: the reason the selector exists is that answers did not come back in Korean. */
export const DEFAULT_ANSWER_LANGUAGE: AnswerLanguage = "ko";

/** "ko-KR" to "Korean"; null for English, empty or unreadable codes. */
const nonEnglishName = (code: string | undefined): string | null => {
  if (!code || /^en([-_]|$)/i.test(code)) return null;
  try {
    // The base language only: "Korean", not "Korean (South Korea)".
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code.split(/[-_]/)[0]) ?? null;
  } catch {
    return null;
  }
};
const safely = (read: () => string): string | undefined => {
  try { return read(); } catch { return undefined; }
};

/**
 * The language to put in the prompt, as an English name, or null to say nothing.
 *
 * "auto" looks at the Dynatrace language, then the regional format, then the browser, and takes the
 * first that is not English; English everywhere means no instruction. The explicit choices always
 * state the language - "English" included, so it wins over a Korean Assist personalization.
 */
export const answerLanguage = (choice: AnswerLanguage): string | null => {
  if (choice === "ko") return "Korean";
  if (choice === "en") return "English";
  const candidates = [safely(getLanguage), safely(getRegionalFormat), typeof navigator === "undefined" ? undefined : navigator.language];
  for (const code of candidates) {
    const name = nonEnglishName(code);
    if (name) return name;
  }
  return null;
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
export const explainPrompt = (problem: BlastProblem, language: string | null): string => {
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
