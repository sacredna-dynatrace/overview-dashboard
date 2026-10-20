import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Timeframe } from "@dynatrace/strato-components/core";
import { TimeframeSelector, TIMEFRAME_SELECTOR_PRESETS } from "@dynatrace/strato-components/filters";
import { Markdown } from "@dynatrace/strato-components/content";
import { Button } from "@dynatrace/strato-components/buttons";
import { sendIntent } from "@dynatrace-sdk/navigation";
import { SearchInput, Select, ToggleButtonGroup } from "@dynatrace/strato-components/forms";
import { AiIcon, ExternalLinkIcon } from "@dynatrace/strato-icons";
import { BlastRadiusGraph, buildBlastLayout, type BlastLayout, type BlastLinkOf } from "../components/BlastRadiusGraph";
import { RefreshControl } from "../components/RefreshControl";
import { StatusIcon } from "../components/StatusMark";
import { buildEntityLink, buildProblemLink, buildProcessLink, buildWorkloadLink } from "../components/TileLinks";
import { useBlastRadiusData, useProblemDescription, type BlastProblem, type BlastQueryKey } from "../hooks/useBlastRadiusData";
import { paletteVars } from "../theme/colors";
import { ANSWER_LANGUAGES, ASSIST_INTENT, DEFAULT_ANSWER_LANGUAGE, answerLanguage, explainPrompt, type AnswerLanguage } from "../assistPrompt";

/** Today, as on the topology page; a week of problems is one preset away. */
const initialTimeframe: Timeframe = {
  from: { value: "@d", absoluteDate: "", type: "expression" },
  to: { value: "now()", absoluteDate: "", type: "expression" },
};
// Midnight-to-midnight of the previous day, matching the topology page.
const yesterdayPreset = { from: "now()-1d@d", to: "now()@d" };

const QUERY_LABELS: Record<BlastQueryKey, string> = { problems: "Problems", services: "Service call graph", frontends: "RUM-to-service", workloads: "Workload ids" };

const formatWhen = (iso: string) => {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const durationMinutes = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / 60000);
const formatDuration = (start: string, end: string) => {
  const minutes = durationMinutes(start, end);
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/**
 * The Korean side of the Davis analysis.
 *
 * Davis writes its description in English, and there is no translation inside the tenant. Sending
 * customer problem text to an outside translator was ruled out, so the Korean is a summary built
 * from the problem's structured fields - root cause, affected entities by type, users, scope - with
 * Davis's English original kept one click away. Unknown categories and types fall back to their raw
 * value rather than a guessed translation.
 */
const CATEGORY_KO: Record<string, string> = {
  AVAILABILITY: "가용성 문제", ERROR: "오류 증가", SLOWDOWN: "응답 지연", RESOURCE_CONTENTION: "리소스 경합",
  CUSTOM_ALERT: "사용자 정의 알림", MONITORING_UNAVAILABLE: "모니터링 불가", INFO: "정보성 이벤트",
};
const ENTITY_KO: Record<string, string> = {
  SERVICE: "서비스", HOST: "호스트", PROCESS_GROUP_INSTANCE: "프로세스", PROCESS_GROUP: "프로세스 그룹",
  CLOUD_APPLICATION: "쿠버네티스 워크로드", CLOUD_APPLICATION_INSTANCE: "쿠버네티스 파드", KUBERNETES_CLUSTER: "쿠버네티스 클러스터",
  KUBERNETES_NODE: "쿠버네티스 노드", CUSTOM_DEVICE: "커스텀 디바이스", CUSTOM_DEVICE_GROUP: "커스텀 디바이스 그룹",
  AWS_LAMBDA_FUNCTION: "Lambda 함수", DISK: "디스크", QUEUE: "큐", HTTP_CHECK: "HTTP 체크", SYNTHETIC_TEST: "합성 모니터", APPLICATION: "웹 애플리케이션",
};
const IMPACT_KO: Record<string, string> = { Services: "서비스", Infrastructure: "인프라", Application: "애플리케이션", Environment: "환경" };
const entityType = (id: string) => id.split("-")[0];
const koDuration = (start: string, end: string) => {
  const minutes = durationMinutes(start, end);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
};

const koreanSummary = (problem: BlastProblem, layout: BlastLayout, impact: string[]): string[] => {
  const lines: string[] = [];
  const category = CATEGORY_KO[problem.category] ?? problem.category;
  const duration = koDuration(problem.start, problem.end);
  const when = `${formatWhen(problem.start)}에 시작된 ${category} 문제`;
  lines.push(!duration ? `${when}입니다.` : problem.active ? `${when}로, 현재까지 ${duration} 동안 진행 중입니다.` : `${when}로, ${duration} 동안 지속된 뒤 종료되었습니다.`);
  const kindOf = (id: string) => ENTITY_KO[entityType(id)] ?? entityType(id);
  if (problem.origin === "root" && problem.rootId) {
    lines.push(`Davis가 근본 원인으로 ${kindOf(problem.rootId)} '${problem.rootName ?? problem.rootId}'을(를) 지목했습니다.`);
  } else if (problem.origin === "self" && problem.originId) {
    lines.push(`다른 엔티티에서 전파된 원인 없이, ${kindOf(problem.originId)} '${problem.originName ?? problem.originId}' 자체에서 발생한 문제입니다.`);
  } else {
    // Concurrent events: say what they have in common, and that Davis did not chain them.
    const names = new Set(problem.affected.map((entity) => entity.name));
    const count = problem.affected.length;
    lines.push(names.size === 1
      ? `같은 ${kindOf(problem.affected[0].id)} '${problem.affected[0].name}'의 인스턴스 ${count}개${problem.hostCount > 1 ? `(호스트 ${problem.hostCount}대)` : ""}에서 각각 발생한 이벤트를 Davis가 하나의 문제로 묶었습니다. 서로의 원인으로 연결되지는 않았습니다.`
      : problem.hostCount === 1
        ? `같은 호스트에서 동시에 발생한 이벤트 ${count}건을 Davis가 하나의 문제로 묶었습니다. 서로의 원인으로 연결되지는 않았습니다.`
        : `같은 시간대에 발생한 이벤트 ${count}건을 Davis가 하나의 문제로 묶었지만, 인과관계는 연결하지 않았습니다.`);
  }
  const byType = new Map<string, number>();
  for (const entity of problem.affected) byType.set(entityType(entity.id), (byType.get(entityType(entity.id)) ?? 0) + 1);
  const breakdown = [...byType].map(([type, count]) => `${ENTITY_KO[type] ?? type} ${count}개`).join(", ");
  lines.push(`영향을 받은 엔티티는 ${problem.affected.length}개입니다${breakdown ? ` (${breakdown})` : ""}.`);
  if (problem.users !== null) lines.push(`Davis 추정으로 사용자 약 ${problem.users.toLocaleString()}명이 영향을 받았습니다.`);
  if (impact.length > 0) lines.push(`영향 범위: ${impact.map((level) => IMPACT_KO[level] ?? level).join(", ")}.`);
  const exposed = layout.exposedShown + layout.hidden.reduce((sum, count) => sum + count, 0);
  if (problem.originId && exposed > 0) lines.push(`${problem.origin === "self" ? "이 엔티티" : "근본 원인"}에 의존하는 엔티티 ${exposed}개는 이번에는 영향 대상으로 표시되지 않았습니다.`);
  return lines;
};

/** "2 × apache-tomcat-*" when the events are one process on several hosts, otherwise a count. */
const eventsLabel = (problem: BlastProblem) => {
  const names = new Set(problem.affected.map((entity) => entity.name));
  return names.size === 1 ? `${problem.affected.length} × ${problem.affected[0].name}` : `${problem.affected.length} entities`;
};
const originLabel = (problem: BlastProblem) =>
  problem.origin === "root" ? `Root: ${problem.rootName ?? problem.rootId ?? ""}`
    : problem.origin === "self" ? `Self: ${problem.originName ?? ""}`
    : `Events: ${eventsLabel(problem)}`;

/** The answer language is remembered per browser; storage can be unavailable, so it is optional. */
const LANGUAGE_KEY = "overview-dashboard.blast.answerLanguage";
const readLanguage = (): AnswerLanguage => {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_KEY);
    return ANSWER_LANGUAGES.some((option) => option.value === stored) ? (stored as AnswerLanguage) : DEFAULT_ANSWER_LANGUAGE;
  } catch {
    return DEFAULT_ANSWER_LANGUAGE;
  }
};
const storeLanguage = (language: AnswerLanguage) => {
  try { window.localStorage.setItem(LANGUAGE_KEY, language); } catch { /* the choice just is not remembered */ }
};

type StatusFilter = "all" | "open" | "closed";
type ProblemSort = "newest" | "oldest" | "impact";
const SORT_OPTIONS: { value: ProblemSort; label: string; hint: string }[] = [
  { value: "newest", label: "Newest first", hint: "Most recent first" },
  { value: "oldest", label: "Oldest first", hint: "In the order they started" },
  { value: "impact", label: "Impact", hint: "Open first, then by affected users and entities" },
];
const startOf = (problem: BlastProblem) => Date.parse(problem.start) || 0;

/**
 * Whether a problem matches the search box: its display id, title, origin, or any affected entity's
 * name - so "corprd" finds the problems of that service, not only "P-…".
 */
const matchesSearch = (problem: BlastProblem, needle: string) => {
  if (!needle) return true;
  const haystack = [problem.displayId, problem.title, problem.rootName ?? "", problem.originName ?? "", ...problem.affected.map((entity) => entity.name)];
  return haystack.some((value) => value.toLowerCase().includes(needle));
};

/** Opens Dynatrace Assist with a prompt built from what this page knows about the problem. */
/**
 * The prompt is built when the button is pressed, not when the page renders. `getLanguage()` returns
 * "en" until the Dynatrace runtime has loaded the user's preferences, and an `IntentButton` carries
 * the payload from its last render - so the first click after the page loaded sent a prompt without
 * "Please answer in Korean" and Assist answered in English, while later clicks were Korean.
 */
const AnalyzeButton = ({ problem, language }: { problem: BlastProblem; language: AnswerLanguage }) =>
  <Button size="condensed" onClick={() => sendIntent({ prompt: explainPrompt(problem, answerLanguage(language)), execute: true }, ASSIST_INTENT)}>
    <Button.Prefix><AiIcon /></Button.Prefix>
    Analyze problem
  </Button>;

/** Davis repeats the problem title as a top-level heading; the panel already shows it. */
const withoutTitle = (markdown: string) => markdown.replace(/^\s*#\s+[^\n]*\n+/, "");

export const BlastRadius = () => {
  const [timeframe, setTimeframe] = useState<Timeframe>(initialTimeframe);
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const [category, setCategory] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoRefreshMs, setAutoRefreshMs] = useState<number | null>(null);
  const { problems, services, frontendCalls, workloadIds, isLoading, errors, truncated, resolved, refetch } = useBlastRadiusData(timeframe, refreshedAt);

  /**
   * A relative timeframe resolves to new timestamps on a refresh, which reruns the queries by itself;
   * an absolute one resolves to the same window and has to be refetched. The timer goes through the
   * same function as the button, so an absolute window refreshes on schedule too.
   */
  const isAbsolute = timeframe.from.type === "iso8601" && timeframe.to.type === "iso8601";
  const refresh = useCallback(() => {
    setRefreshedAt(Date.now());
    if (isAbsolute) void refetch();
  }, [isAbsolute, refetch]);
  // Through a ref: `refetch` is a new function every render, and a timer that restarted on every
  // click would keep postponing the refresh while someone works the page.
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => {
    if (autoRefreshMs === null) return;
    const timer = setInterval(() => refreshRef.current(), autoRefreshMs);
    return () => clearInterval(timer);
  }, [autoRefreshMs]);

  const categories = useMemo(() => [...new Set(problems.map((problem) => problem.category))].sort(), [problems]);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [language, setLanguage] = useState<AnswerLanguage>(readLanguage);
  const chooseLanguage = (value: AnswerLanguage) => { setLanguage(value); storeLanguage(value); };
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ProblemSort>("newest");
  /**
   * Filtering and sorting run on the problems already loaded, so they cost no query. "Impact" is the
   * order the query returns; the time orders sort by start, newest first by default.
   */
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const kept = problems.filter((problem) => (!category || problem.category === category)
      && (status === "all" || (status === "open") === problem.active)
      && matchesSearch(problem, needle));
    if (sort === "newest") return [...kept].sort((a, b) => startOf(b) - startOf(a));
    if (sort === "oldest") return [...kept].sort((a, b) => startOf(a) - startOf(b));
    return kept;
  }, [category, problems, search, sort, status]);
  const sortHint = SORT_OPTIONS.find((option) => option.value === sort)?.hint ?? "";
  // A display id typed in full that is not in the list is outside the timeframe, not missing.
  const searchedId = /^p-\d+$/i.test(search.trim()) ? search.trim().toUpperCase() : null;
  // The list is ordered by impact, so the first problem is the one worth opening.
  const selected: BlastProblem | undefined = visible.find((problem) => problem.displayId === selectedId) ?? visible[0];
  const layout = useMemo(() => (selected ? buildBlastLayout(selected, services, frontendCalls) : null), [frontendCalls, selected, services]);
  const description = useProblemDescription(selected?.displayId ?? null, resolved);

  /** The entity's own app, for the types with a verified link; null for everything else. */
  const linkFor = (id: string): string | null => {
    const type = entityType(id);
    if (type === "SERVICE") return buildEntityLink("service", id, timeframe);
    if (type === "HOST") return buildEntityLink("infrastructure", id, timeframe);
    if (type === "PROCESS_GROUP_INSTANCE") return buildProcessLink(id, timeframe);
    if (type === "CLOUD_APPLICATION") {
      const workload = workloadIds.get(id);
      return workload ? buildWorkloadLink(workload, timeframe) : null;
    }
    return null;
  };
  const problemLink = selected?.eventId ? buildProblemLink(selected.eventId, timeframe) : null;
  const linkOf: BlastLinkOf = (node) => {
    if (node.kind === "root") return selected?.originId ? linkFor(selected.originId) : problemLink;
    if (node.kind === "frontend") return buildEntityLink("rum", node.id.replace(/^frontend:/, ""), timeframe);
    return linkFor(node.id);
  };
  const entityName = (id: string, name: string) => {
    const href = linkFor(id);
    return href
      ? <a className="blast-entity-link" href={href} target="_blank" rel="noopener noreferrer" title={id}>{name}</a>
      : <span className="workload-process-name" title={id}>{name}</span>;
  };

  return <main className="dashboard-page" style={paletteVars as React.CSSProperties}>
    <section className="dashboard-heading">
      <div>
        <p className="eyebrow">DAVIS PROBLEMS / BLAST RADIUS</p>
        <h1>Blast radius</h1>
        <p className="dashboard-description">Pick a problem to see what depends on its root cause: Davis-confirmed impact in red, the rest of the dependency fan muted. Click a node to open it in Dynatrace.</p>
      </div>
      <div className="dashboard-actions">
        <TimeframeSelector value={timeframe} onChange={(value) => { if (value) { setTimeframe(value); setRefreshedAt(Date.now()); setSelectedId(null); } }}>
          <TimeframeSelector.Presets>{TIMEFRAME_SELECTOR_PRESETS.map((preset) => <TimeframeSelector.PresetItem key={`${preset.from}-${preset.to}`} value={preset} />)}<TimeframeSelector.PresetItem value={yesterdayPreset}>Yesterday</TimeframeSelector.PresetItem></TimeframeSelector.Presets>
        </TimeframeSelector>
        <RefreshControl intervalMs={autoRefreshMs} onIntervalChange={setAutoRefreshMs} onRefresh={refresh} isRefreshing={isLoading} />
      </div>
    </section>
    {errors.length > 0 && <div className="query-message query-error" role="alert"><div className="query-error-list"><strong>{errors.length} of the page’s queries failed.</strong>{errors.map((item) => <span key={item.label}><b>{item.label}:</b> {item.message}</span>)}</div></div>}
    {truncated.length > 0 && <div className="query-message" role="status">{truncated.map((key) => QUERY_LABELS[key]).join(", ")} hit the result limit, so the list or the rings may be incomplete. Narrow the timeframe.</div>}
    {isLoading && <div className="query-message" role="status">Loading problems and the service call graph…</div>}
    <section className="blast-grid">
      <aside className="graph-panel blast-list">
        <div className="panel-heading"><div><h2>Problems <span className="panel-badge">{visible.length}</span></h2><p>{sortHint}</p></div></div>
        <div className="blast-controls">
          <SearchInput value={search} onChange={setSearch} placeholder="Search ID, title or entity" aria-label="Search problems" />
          <div className="blast-controls-row">
            <ToggleButtonGroup value={status} onChange={(value) => setStatus(value as StatusFilter)} aria-label="Filter by status">
              <ToggleButtonGroup.Item value="all">All</ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="open">Open</ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="closed">Closed</ToggleButtonGroup.Item>
            </ToggleButtonGroup>
            <Select name="problem-sort" aria-label="Sort problems" value={sort} onChange={(value) => { if (value) setSort(value); }}>
              <Select.Trigger />
              <Select.Content>
                {SORT_OPTIONS.map((option) => <Select.Option key={option.value} value={option.value}>{option.label}</Select.Option>)}
              </Select.Content>
            </Select>
          </div>
        </div>
        <div className="blast-filters" role="group" aria-label="Filter by category">
          <button type="button" className={category === null ? "is-active" : undefined} onClick={() => setCategory(null)}>All</button>
          {categories.map((value) => <button key={value} type="button" className={category === value ? "is-active" : undefined} onClick={() => setCategory(value)}>{value.toLowerCase().replace(/_/g, " ")}</button>)}
        </div>
        <ol className="blast-problems">
          {visible.map((problem) => <li key={problem.displayId}>
            <button type="button" className={problem.displayId === selected?.displayId ? "is-selected" : undefined} onClick={() => setSelectedId(problem.displayId)}>
              <span className="blast-problem-top"><StatusIcon problem={problem.active} /><b>{problem.title}</b></span>
              <span className="blast-problem-meta">{problem.displayId} · {problem.category.toLowerCase().replace(/_/g, " ")} · {formatWhen(problem.start)}</span>
              <span className="blast-problem-meta">{originLabel(problem)} · {problem.affected.length} affected{problem.users !== null ? ` · ${problem.users.toLocaleString()} users` : ""}</span>
            </button>
          </li>)}
          {!isLoading && visible.length === 0 && <li className="blast-empty">{searchedId
            ? `${searchedId} is not in the selected timeframe. Widen the timeframe to find it.`
            : problems.length === 0 ? "No problems in this timeframe." : "No problems match these filters."}</li>}
        </ol>
      </aside>
      <div className="graph-panel blast-graph">
        {selected && layout ? <>
          <div className="panel-heading"><div>
            <h2>{selected.title}</h2>
            <p>{selected.displayId} · {selected.active ? "Open" : "Closed"} · {formatWhen(selected.start)} · {formatDuration(selected.start, selected.end)}</p>
            <div className="panel-links blast-actions">
              {problemLink && <a href={problemLink} target="_blank" rel="noopener noreferrer">Open {selected.displayId} in Problems <ExternalLinkIcon /></a>}
              <AnalyzeButton problem={selected} language={language} />
              <Select name="answer-language" aria-label="Answer language for Assist" value={language} onChange={(value) => { if (value) chooseLanguage(value); }}>
                <Select.Trigger />
                <Select.Content>
                  {ANSWER_LANGUAGES.map((option) => <Select.Option key={option.value} value={option.value}>{option.label}</Select.Option>)}
                </Select.Content>
              </Select>
            </div>
          </div></div>
          {/* Keyed by problem so the rings unfold again on every selection. */}
          <BlastRadiusGraph key={selected.displayId} problem={selected} layout={layout} linkOf={linkOf} />
          <div className="topology-legend">
            <span><StatusIcon problem /> Root cause / confirmed affected</span>
            <span><svg className="legend-edge" viewBox="0 0 34 10" aria-hidden="true"><circle cx="17" cy="5" r="4" fill="#fff" stroke="var(--tier-service)" strokeWidth="1.6" /></svg> Depends on the root, not flagged</span>
            <span><svg className="legend-edge" viewBox="0 0 34 10" aria-hidden="true"><circle cx="17" cy="5" r="4" fill="#fff" stroke="var(--tier-rum)" strokeWidth="1.6" /></svg> RUM application</span>
            <span><svg className="legend-edge" viewBox="0 0 34 10" aria-hidden="true"><path d="M1,5 H33" stroke="var(--tier-infrastructure)" strokeWidth="1.4" strokeDasharray="3 3" /></svg> Runs on</span>
            <span><svg className="legend-edge" viewBox="0 0 34 10" aria-hidden="true"><circle cx="17" cy="5" r="4" fill="#fff" stroke="var(--virtual-text)" strokeWidth="1.4" /><circle cx="17" cy="5" r="1.6" fill="var(--virtual-text)" /></svg> Concurrent event, no causal link</span>
          </div>
        </> : <div className="path-detail"><p>{isLoading ? "Loading…" : "Select a problem to draw its blast radius."}</p></div>}
      </div>
      <aside className="details-panel">
        {selected && layout ? <div className="selected-detail">
          <div className="detail-type">{selected.category.toLowerCase().replace(/_/g, " ")}</div>
          <strong>{selected.users !== null ? `${selected.users.toLocaleString()} users` : `${selected.affected.length} entities`}</strong>
          <span>{selected.users !== null ? "affected, as estimated by Davis" : "confirmed affected by Davis"}</span>
          <hr />
          {/* The root cause gets the full width: entity names here run long and do not break. */}
          <div className="blast-root">
            <span>Root cause</span>
            {selected.origin === "events"
              ? <b>None - concurrent events ({eventsLabel(selected)})</b>
              : selected.originId && <>{entityName(selected.originId, selected.originName ?? selected.originId)}{selected.origin === "self" && <em>self-originated: the problem is this entity's own</em>}</>}
          </div>
          <div className="health-grid blast-stats">
            <div><span>Confirmed affected</span><b className={selected.affected.length > 0 ? "is-critical" : undefined}>{selected.affected.length}</b></div>
            <div><span>Exposed, not flagged</span><b>{layout.exposedShown + layout.hidden.reduce((sum, count) => sum + count, 0)}</b></div>
            <div><span>Duration</span><b>{formatDuration(selected.start, selected.end)}</b></div>
          </div>
          <hr />
          <span>Confirmed affected</span>
          <div className="workload-pods">{selected.affected.map((entity) => <div className="workload-pod" key={entity.id}><StatusIcon problem />{entityName(entity.id, entity.name)}<b>{ENTITY_KO[entityType(entity.id)] ?? entityType(entity.id).toLowerCase()}</b></div>)}</div>
          <hr />
          <div className="blast-analysis-heading"><span>Davis 분석</span><AnalyzeButton problem={selected} language={language} /></div>
          <div className="blast-description">
            {description.isLoading ? <p>Davis 분석을 불러오는 중…</p>
              : description.error ? <p>분석을 불러오지 못했습니다: {description.error}</p>
              : <>
                <ul className="blast-summary">{koreanSummary(selected, layout, description.impact).map((line) => <li key={line}>{line}</li>)}</ul>
                {description.description && <details>
                  <summary>Davis 원문 보기 (영어)</summary>
                  <Markdown>{withoutTitle(description.description)}</Markdown>
                </details>}
              </>}
          </div>
        </div> : <div className="path-detail"><p>Problem details appear here.</p></div>}
      </aside>
    </section>
  </main>;
};
