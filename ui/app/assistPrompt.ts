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
 * The browser's time zone ("Asia/Seoul"), or null when it is UTC or cannot be read.
 *
 * Assist answers in whatever zone the prompt uses, and the prompt states UTC - which Assist and DQL
 * read unambiguously - so a timeline came back in UTC while the rest of the page shows local time.
 * The prompt keeps UTC for the window Assist queries and asks, once, for the answer in this zone -
 * Assist converts the times itself.
 */
export const browserTimeZone = (): string | null => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && !/^(Etc\/)?(UTC|GMT)$/i.test(zone) ? zone : null;
  } catch {
    return null;
  }
};

/** "UTC+09:00" for the zone at that moment, so daylight saving is right; null if it cannot be read. */
const utcOffset = (time: number, zone: string): string | null => {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(time)
      .find((part) => part.type === "timeZoneName")?.value;
    if (!name) return null;
    // "GMT" alone is a zero offset; otherwise "GMT+09:00".
    return name === "GMT" ? "UTC+00:00" : name.replace(/^GMT/, "UTC");
  } catch {
    return null;
  }
};

/**
 * Where to look for a problem's logs. Names for Kubernetes (logs carry them, not ids), ids for the
 * rest. Two Assist runs on one problem reached different root causes because one filtered logs by
 * `dt.entity.service` - which logs here do not carry - got zero records and concluded there were no
 * errors, while the other filtered by namespace and found 1,671. Naming the scope makes every run
 * look in the same place.
 */
export type LogScope = {
  namespaces: string[];
  workloads: string[];
  clusters: string[];
  processGroups: string[];
  hosts: string[];
};
/** Values per scope field and affected entities named; the rest are counted. */
const LIST_LIMIT = 5;
const list = (values: string[]) => {
  const unique = [...new Set(values)].filter(Boolean);
  return `${unique.slice(0, LIST_LIMIT).join(", ")}${unique.length > LIST_LIMIT ? ` (+${unique.length - LIST_LIMIT} more)` : ""}`;
};

/**
 * The one most specific log scope: Kubernetes namespace and workload, else process group, else host.
 * Listing several scopes let Assist pick any of them, and a broad one - a host - pulls in unrelated
 * logs and a different conclusion. Process instances are left out: they point at the same logs as
 * their process group in ids twice as long.
 */
const logScope = (scope: LogScope): string | null => {
  if (scope.namespaces.length > 0) {
    return [`k8s.namespace.name in (${list(scope.namespaces)})`, scope.workloads.length > 0 ? `k8s.workload.name in (${list(scope.workloads)})` : ""].filter(Boolean).join(" and ");
  }
  if (scope.processGroups.length > 0) return `dt.entity.process_group in (${list(scope.processGroups)})`;
  if (scope.hosts.length > 0) return `dt.entity.host in (${list(scope.hosts)})`;
  return null;
};

/**
 * The question sent to Assist, kept short and rule-shaped.
 *
 * It carries what the page already knows, so Assist does not have to rediscover it (with only the
 * display id it first searched the last 72 hours and missed). Times stay in UTC, which Assist queries
 * with; the answer is asked for in the browser's zone. Error logs come first because, between two runs
 * on one problem, they were what decided the root cause. Entities go by id only: names are free text,
 * and "Netty on 0:0:0:0:0:0:0:0:*" got the whole prompt rejected by Assist's PII blocking.
 * Kubernetes namespace and workload names are the exception - logs carry no ids for them.
 */
export const explainPrompt = (problem: BlastProblem, language: string | null, scope: LogScope, zone: string | null = browserTimeZone()): string => {
  const start = Date.parse(problem.start);
  const end = Date.parse(problem.end);
  const hasWindow = Number.isFinite(start);
  const until = problem.active ? "ongoing" : isoMinute(Number.isFinite(end) ? end : start);
  const offset = zone && hasWindow ? utcOffset(start, zone) : null;
  const origin = problem.origin === "root" && problem.rootId
    ? `Root cause per Davis: ${problem.rootId}.`
    : problem.origin === "self" && problem.originId
      ? `Origin: ${problem.originId} itself (Davis found no cause elsewhere).`
      : "Davis grouped concurrent events with no causal link.";
  const affected = problem.affected.length > 0 ? `Affected: ${list(problem.affected.map((entity) => entity.id))}.` : "";
  const where = logScope(scope);
  /**
   * A problem on a web application is answered by RUM data, not logs. Sent the log-first prompt,
   * Assist searched logs that carry no frontend id, then guessed a dt.rum.* metric, and reported no
   * RUM data - while user.events held 479 errors for that app in the window and
   * dt.frontend.user_action.duration had risen to 4.9 s (bby34718).
   */
  const apps = [...new Set([problem.originId ?? "", ...problem.affected.map((entity) => entity.id)].filter((id) => id.startsWith("APPLICATION-")))];
  const rum = apps.length > 0;
  const sources = rum
    ? [`Steps: 1) fetch user.events where dt.rum.application.entity in (${list(apps)}), 2) dt.frontend.* metrics, 3) the backend services it calls.`]
    : [
      // With no scope, "find the hosts or namespaces first" sent Assist hunting for a scope that did
      // not exist: P-2610895 on bby34718 was an AWS Lambda function (no host, process or tag, no
      // spans of its own, no logs), and the run hit Assist's tool-call limit before answering.
      ...(where
        ? [
          "Steps: 1) error logs first, 2) then metrics, traces and events.",
          `Logs: filter by ${where} - logs here have no dt.entity.service.`,
          "Errors = loglevel ERROR/SEVERE/CRITICAL/ALERT/EMERGENCY, or content with exception/error/failed/timeout at any level.",
        ]
        : ["Steps: 1) service metrics, 2) callers' client spans, 3) events. No host, process or Kubernetes scope is known - it may be serverless (e.g. AWS Lambda); skip logs unless one check finds them."]),
    ];
  return [
    `Analyze Davis problem ${problem.displayId} "${problem.title}"${hasWindow ? `, ${isoMinute(start)} to ${until}` : ""}.`,
    `${origin} ${affected}`.trim(),
    hasWindow ? `Window: ${isoMinute(start - ANALYSIS_LEAD_MINUTES * 60_000)} (${ANALYSIS_LEAD_MINUTES} min before start) to ${problem.active ? "now" : "end"}.` : "",
    ...sources,
    // Assist guessed names that do not exist - status.code on spans, dt.service.request.failure_rate,
    // dt.rum.* metrics, event.start on user.events - got zero rows without an error and reported "no
    // data". Names differ per tenant, so the prompt says how to look them up rather than listing them
    // all; each method was checked on bby34718, isb54165 and diw85600. fieldsSummary is ruled out: it
    // counts records, and reported the absent event.start on all 14,922. A one-record sample fails too,
    // because span.status_code is set only on failed spans. No angle brackets: the Assist panel strips
    // them as markup, and "isNotNull(<field>)" arrived as "isNotNull()".
    // A budget, as in the SRE Agent prompt: Assist stops at its tool-call limit with no answer at all.
    "Use about 10 queries, in the step order; when calls run low, answer with what you have. Use entity ids as given - do not look up names unless the answer needs them.",
    // Checked only on a 0-row result: verifying every name up front cost calls the analysis needed.
    "A wrong field or metric name returns 0 rows without an error. Only when a query returns 0 rows, check the name before treating it as evidence:",
    "- Fields: fetch the source in the window | limit 1 | fieldsKeep \"*keyword*\".",
    "- Values: countIf(isNotNull(fieldname)) over the window - not fieldsSummary (counts records, so absent fields look full), not a 1-record sample.",
    `- Metrics and dimensions: fetch metric.series | filter startsWith(metric.key, "${rum ? "dt.frontend." : "dt.service."}").`,
    // Verified facts that Assist got wrong. The external-service one: a 94% failing "service"
    // (mdpt.co.kr) had no spans in three days - it is a domain the app calls, seen only as client spans
    // on the caller, and its name was only in the classic model.
    `Known here: ${[
      rum ? "user.events time = start_time" : "",
      "failed span = span.status_code == \"error\" or request.is_failed == true",
      "failure rate = dt.service.request.failure_count / dt.service.request.count",
      // Lambda: faas.invoked_name and server.address lambda.<region>.amazonaws.com on the callers' client spans (bby34718).
      "services with no process - external WEB_REQUEST_SERVICE or AWS Lambda - have no spans of their own: their calls are client spans on the callers, by server.address or faas.invoked_name (the Lambda function name)",
      "names missing from Smartscape are in dt.entity.*",
    ].filter(Boolean).join("; ")}.`,
    // From the SRE Agent's Dynatrace Intelligence prompt. Recurrence decides most custom threshold
    // alerts here: "(ALL) Host CPU 사용량 높음(>90 %)" fires many times a day on isb54165.
    "If calls remain, also check: how often this alert name fired on the same entity in the last 48h (fetch dt.davis.problems, same event.name, expand affected_entity_ids; list the problem ids); for a threshold alert, the triggering metric's own time series, not its description.",
    "Judge whether it needs attention: synthetic, test-origin, or steadily recurring alerts with no correlating logs are noise - say so.",
    "Answer: start with a one-sentence Verdict (kind of problem, what is happening, which entity, since when); then checks run (filter, range, record count incl. 0); timeline from the earliest anomaly; root cause with evidence and DQL; impact; remediation; prevention; evidence links as relative paths (/ui/entity/ENTITY-ID, /ui/apps/dynatrace.davis.problems/problem/P-ID). Say so if the data does not support a conclusion.",
    zone ? `Times in ${zone}${offset ? ` (${offset})` : ""}.` : "",
    language ? `Answer in ${language}.` : "",
  ].filter(Boolean).join("\n");
};
