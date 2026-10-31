import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@dynatrace/strato-components/buttons";
import type { Timeframe } from "@dynatrace/strato-components/core";
import { SegmentSelector, TimeframeSelector, useSegments } from "@dynatrace/strato-components/filters";
import { Select } from "@dynatrace/strato-components/forms";
import { DataTable, type DataTableColumnDef, type DataTableColumnVisibilityState } from "@dynatrace/strato-components/tables";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { getIntentLink } from "@dynatrace-sdk/navigation";
import { Tooltip } from "@dynatrace/strato-components/overlays";
import { ExternalLinkIcon, RefreshAutoIcon, RefreshIcon } from "@dynatrace/strato-icons";
import { useServiceTagOptions, useTagFilter } from "../components/SharedFilters";
import { StarfieldCanvas, type StarScale, type StarSelection } from "../components/StarfieldCanvas";
import { StarfieldOverview, type TimeSpan } from "../components/StarfieldOverview";
import { useSpanRetentionDays, useStarfieldOverview } from "../hooks/useStarfieldOverview";
import { TagControl } from "../components/TagControl";
import { SETTLING_MS, STARFIELD_CAP, useStarfieldData, type StarPoint } from "../hooks/useStarfieldData";
import { resolveTimeframe } from "../hooks/useTopologyData";
import { starfieldText, type StarfieldText } from "../starfieldText";
import { paletteVars } from "../theme/colors";

/**
 * Ten minutes is what the record cap holds on the reference tenant. Any window can be picked, past
 * ones included, but the field shows at most its last fifteen minutes: longer, and the cap would
 * cut it to its newest records anyway.
 */
const PRESETS = [5, 10, 15].map((minutes) => ({ from: `now()-${minutes}m`, to: "now()" }));
const MAX_WINDOW_MS = 15 * 60_000;
const DEFAULT_TIMEFRAME: Timeframe = {
  from: { value: "now()-10m", absoluteDate: "", type: "expression" },
  to: { value: "now()", absoluteDate: "", type: "expression" },
};
/** Live needs a window that ends now; a fixed or past end has nothing new to add. */
const endsNow = (timeframe: Timeframe) => timeframe.to.type === "expression" && /^now(\(\))?$/.test(timeframe.to.value.trim());
/** The top of the field. Slower requests are gathered into the overflow band above it, so outliers stay visible. */
const CEILINGS = [2000, 4000, 8000, 16000, 32000] as const;
const DEFAULT_CEILING = 8000;
/** Linear by default, the reading people know; log spreads out the requests under half a second. */
const DEFAULT_SCALE: StarScale = "linear";
/**
 * Live update cadences. Each update re-reads two minutes of root spans, a billed scan of about
 * 0.1 GiB on bby34718: every ten seconds that was 38 GiB an hour per open page. Thirty seconds is
 * the shortest offered; switching off is left to the user. Labels come from the page text.
 */
const LIVE_INTERVALS: { value: string; ms: number | null }[] = [
  { value: "off", ms: null },
  { value: "30s", ms: 30_000 },
  { value: "1m", ms: 60_000 },
  { value: "5m", ms: 300_000 },
];
/**
 * Sampling is hidden until asked for: "1 of N" raised more questions than it answered. The table's
 * column settings bring it back.
 */
const DEFAULT_COLUMN_VISIBILITY: DataTableColumnVisibilityState = { multiplicity: false };

/**
 * The trace as a link rather than a sent intent, so it opens in a new tab and the field and the
 * selected list stay where they were. Same app and intent as before: Distributed Tracing's view-trace.
 */
const traceLink = (point: StarPoint) => getIntentLink({ "trace.id": point.traceId, "span.id": point.spanId, timestamp: new Date(point.end).toISOString() }, "dynatrace.distributedtracing", "view-trace");

const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 1 : 0)} ms`);
const formatTime = (epoch: number) => new Date(epoch).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const formatDateTime = (epoch: number) => new Date(epoch).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const DAY_MS = 86_400_000;
const dayOf = (epoch: number) => new Date(epoch).toDateString();
const isToday = (epoch: number) => dayOf(epoch) === dayOf(Date.now());

/**
 * "1 of N" split by where the other N-1 went: stored 1/n is the agent's sampling (never recorded),
 * read 1/n is this page's read ratio (stored, not read). Each part shows only when it applies.
 */
const samplingLabel = (text: StarfieldText, point: StarPoint) => {
  const total = Math.round(point.multiplicity);
  if (total <= 1) return "—";
  const stored = Math.round(point.multiplicity / point.readRatio);
  return text.samplingValue(total.toLocaleString(), stored > 1 ? stored.toLocaleString() : null, point.readRatio > 1 ? point.readRatio.toLocaleString() : null);
};

const columnsFor = (text: StarfieldText): DataTableColumnDef<StarPoint>[] => [
  { id: "end", header: text.columnFinished, accessor: "end", width: 170, cell: ({ value }) => <DataTable.DefaultCell>{formatDateTime(value as number)}</DataTable.DefaultCell> },
  { id: "ms", header: text.columnResponseTime, accessor: "ms", alignment: "right", width: 130, cell: ({ value }) => <DataTable.DefaultCell>{formatMs(value as number)}</DataTable.DefaultCell> },
  { id: "failed", header: text.columnResult, width: 90, accessor: (row) => (row.failed ? text.resultFailed : text.resultOk), cell: ({ rowData }) => <DataTable.DefaultCell>{rowData.failed ? <b className="star-failed">{text.resultFailed}</b> : text.resultOk}</DataTable.DefaultCell> },
  { id: "service", header: text.columnService, accessor: "service", width: "1fr", minWidth: 120 },
  { id: "endpoint", header: text.columnEndpoint, accessor: "endpoint", width: "2fr", minWidth: 160 },
  { id: "multiplicity", header: text.columnSampling, accessor: "multiplicity", alignment: "right", width: 240, cell: ({ rowData }) => <DataTable.DefaultCell>{samplingLabel(text, rowData)}</DataTable.DefaultCell> },
  { id: "trace", header: text.columnTrace, accessor: "traceId", width: 90, cell: ({ rowData }) => <DataTable.DefaultCell><a className="star-trace-link" href={traceLink(rowData)} target="_blank" rel="noopener noreferrer">{text.open} <ExternalLinkIcon /></a></DataTable.DefaultCell> },
];

/**
 * The response time the slowest 1% of requests reach, for the keyboard route into the list. Weighted:
 * in a sampled read the slow tail is read in full and the rest at 1 in N, so counting records would
 * put the floor far too low.
 */
const slowestFloor = (points: StarPoint[]) => {
  if (points.length === 0) return 0;
  const sorted = [...points].sort((a, b) => b.ms - a.ms);
  const total = sorted.reduce((sum, point) => sum + point.multiplicity, 0);
  let reached = 0;
  for (const point of sorted) {
    reached += point.multiplicity;
    if (reached >= total * 0.01) return point.ms;
  }
  return sorted[sorted.length - 1].ms;
};

export const Starfield = () => {
  const text = useMemo(starfieldText, []);
  const columns = useMemo(() => columnsFor(text), [text]);
  const liveLabel = (value: string) => (value === "off" ? text.liveOff : text.liveEvery[value]);
  const [timeframe, setTimeframe] = useState<Timeframe>(DEFAULT_TIMEFRAME);
  const [ceiling, setCeiling] = useState<number>(DEFAULT_CEILING);
  const [scale, setScale] = useState<StarScale>(DEFAULT_SCALE);
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const [selection, setSelection] = useState<StarSelection | null>(null);
  const [liveMs, setLiveMs] = useState<number | null>(null);
  const [columnVisibility, setColumnVisibility] = useState<DataTableColumnVisibilityState>(DEFAULT_COLUMN_VISIBILITY);
  // Held here, not in the table: the table unmounts when a selection is cleared, and widths a reader
  // set should survive picking the next region.
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({});
  /** The fifteen minutes picked in the overview; null is the latest fifteen. */
  const [slot, setSlot] = useState<TimeSpan | null>(null);
  const live = LIVE_INTERVALS.find((interval) => interval.ms === liveMs) ?? LIVE_INTERVALS[0];
  const retentionDays = useSpanRetentionDays();
  // Spans older than the bucket keeps cannot be drawn, so the timeframe starts no earlier.
  const retentionStart = retentionDays === null ? null : refreshedAt - retentionDays * DAY_MS;
  const range = useMemo(() => {
    const resolved = resolveTimeframe(timeframe, refreshedAt);
    const end = Date.parse(resolved.to);
    const start = Math.min(end, Math.max(Date.parse(resolved.from), retentionStart ?? Number.NEGATIVE_INFINITY));
    return { start, end, clamped: end - start > MAX_WINDOW_MS };
  }, [refreshedAt, retentionStart, timeframe]);
  const shown = slot ?? { from: Math.max(range.start, range.end - MAX_WINDOW_MS), to: range.end };
  // Live follows the latest stretch of a timeframe that ends now; a picked stretch stays put.
  const followsNow = endsNow(timeframe) && slot === null;
  const { tags, setTags } = useTagFilter();
  const { segments } = useSegments();
  const tagOptions = useServiceTagOptions();
  // A selection holds the field still: stars sliding under an open list would no longer match it.
  const { points, from, to, ratio, slowFloorMs, isLoading, isUpdating, error, truncated } = useStarfieldData(shown.from, shown.to, followsNow, tags, liveMs, selection !== null);

  /**
   * The overview follows the services in the field, fixed per timeframe and tag choice: picking
   * another stretch changes the stars but must not redraw the strip it was picked from.
   */
  const overviewKey = `${range.start}|${range.end}|${tags.join("\u0000")}`;
  const [overviewServices, setOverviewServices] = useState({ key: "", ids: [] as string[] });
  useEffect(() => {
    if (!range.clamped || points.length === 0) return;
    setOverviewServices((previous) => (previous.key === overviewKey ? previous
      : { key: overviewKey, ids: [...new Set(points.map((point) => point.serviceId).filter(Boolean))].sort() }));
  }, [overviewKey, points, range.clamped]);
  const overview = useStarfieldOverview(range.start, range.end, overviewServices.key === overviewKey ? overviewServices.ids : [], range.clamped);
  const pickSlot = (picked: TimeSpan) => {
    setSelection(null);
    // A stretch reaching the end of the timeframe is the latest one, which Live can follow.
    setSlot(picked.to >= range.end - 1000 ? null : picked);
  };
  // A time alone reads as today: anything else - a past stretch, a timeframe across midnight -
  // carries its date.
  const formatWhen = isToday(range.start) && isToday(range.end) && isToday(from) ? formatTime : formatDateTime;

  const refresh = () => { setRefreshedAt(Date.now()); setSelection(null); setSlot(null); };

  const stats = useMemo(() => {
    let requests = 0; let failed = 0; let overCeiling = 0;
    for (const point of points) {
      requests += point.multiplicity;
      // Weighted like the request total: in a sampled read failures are read in full, the rest at 1 in N.
      if (point.failed) failed += point.multiplicity;
      if (point.ms > ceiling) overCeiling += 1;
    }
    return { requests: Math.round(requests), failed: Math.round(failed), overCeiling };
  }, [ceiling, points]);

  /** A request pinned to the ceiling belongs to a selection that reaches the ceiling. */
  const selected = useMemo(() => {
    if (!selection) return [];
    return points
      .filter((point) => point.end >= selection.from && point.end <= selection.to)
      .filter((point) => { const y = Math.min(point.ms, ceiling); return y >= selection.min && y <= selection.max; })
      .sort((a, b) => b.ms - a.ms);
  }, [ceiling, points, selection]);

  return <main className="dashboard-page" style={paletteVars as React.CSSProperties}>
    <section className="dashboard-heading starfield-heading">
      <div>
        <p className="eyebrow">{text.eyebrow}</p>
        <h1>Starfield</h1>
        <p className="dashboard-description">{text.description}</p>
      </div>
      <div className="dashboard-actions">
        <SegmentSelector variant="compact" />
        <TagControl options={tagOptions.options} value={tags} onChange={(value) => { setTags(value); setSelection(null); setSlot(null); setRefreshedAt(Date.now()); }} />
        <TimeframeSelector value={timeframe} min={retentionStart === null ? undefined : new Date(retentionStart).toISOString()} onChange={(value) => { if (value) { setTimeframe(value); setSelection(null); setSlot(null); setRefreshedAt(Date.now()); } }}>
          <TimeframeSelector.Presets>{PRESETS.map((preset) => <TimeframeSelector.PresetItem key={preset.from} value={preset} />)}</TimeframeSelector.Presets>
        </TimeframeSelector>
        <Select name="starfield-ceiling" aria-label={text.ceilingAria} value={String(ceiling)} onChange={(value) => { if (value) setCeiling(Number(value)); }}>
          <Select.Trigger />
          <Select.Content>{CEILINGS.map((ms) => <Select.Option key={ms} value={String(ms)}>{text.ceilingOption(ms / 1000)}</Select.Option>)}</Select.Content>
        </Select>
        <Select name="starfield-scale" aria-label={text.scaleAria} value={scale} onChange={(value) => { if (value === "log" || value === "linear") setScale(value); }}>
          <Select.Trigger />
          <Select.Content>
            <Select.Option value="log">{text.logScale}</Select.Option>
            <Select.Option value="linear">{text.linearScale}</Select.Option>
          </Select.Content>
        </Select>
        <Select name="starfield-live" aria-label={text.liveAria} disabled={!followsNow} value={live.value} onChange={(value) => setLiveMs(LIVE_INTERVALS.find((interval) => interval.value === value)?.ms ?? null)}>
          <Select.Trigger>
            <Select.DisplayValue>
              <Select.Prefix><RefreshAutoIcon /></Select.Prefix>
              {liveLabel(live.value)}
            </Select.DisplayValue>
          </Select.Trigger>
          <Select.Content>{LIVE_INTERVALS.map((interval) => <Select.Option key={interval.value} value={interval.value}>{liveLabel(interval.value)}</Select.Option>)}</Select.Content>
        </Select>
        <Button variant="emphasized" onClick={refresh} loading={isLoading}><Button.Prefix><RefreshIcon /></Button.Prefix>{text.refresh}</Button>
      </div>
    </section>
    {error && <div className="query-message query-error" role="alert"><span><b>{text.errorLabel}</b> {error}</span></div>}
    {range.clamped && <div className="query-message" role="status"><span>{text.clamped}</span></div>}
    {!followsNow && liveMs !== null && <div className="query-message" role="status"><span>{text.liveNeedsNow}</span></div>}
    {truncated && <div className="query-message" role="status"><span>{text.truncated(STARFIELD_CAP.toLocaleString())}</span></div>}
    <section className="graph-panel starfield-panel">
      <div className="panel-heading">
        <div>
          <h2>{text.heading} <span className="panel-badge">{text.badge(points.length.toLocaleString())}</span></h2>
          <p>{text.summary(`${formatWhen(from)} – ${formatWhen(to)}`, stats.failed.toLocaleString(), stats.overCeiling.toLocaleString(), ceiling / 1000)}</p>
          {liveMs !== null && followsNow && <p className="starfield-live" role="status">{selection ? text.livePaused : text.liveUpdated(formatTime(to), isUpdating)}</p>}
        </div>
      </div>
      {/* Only claim sampling when a record actually stands for more than one request. */}
      <p className="starfield-note">{stats.requests > points.length
        ? text.sampledNote(points.length.toLocaleString(), stats.requests.toLocaleString())
        : text.fullNote}</p>
      {ratio > 1 && <p className="starfield-note starfield-ratio">{text.readRatio(ratio, slowFloorMs === null ? null : formatMs(slowFloorMs))}</p>}
      {range.clamped && <div className="starfield-overview-block">
        <p className="starfield-overview-title"><b>{text.overviewTitle}</b>
          <span className="starfield-legend"><i className="ov-requests" /> {text.overviewRequests} <i className="ov-p95" /> p95 <i className="ov-avg" /> {text.overviewAvg}</span>
          <span>{text.overviewHint}</span></p>
        <StarfieldOverview buckets={overview.buckets} from={range.start} to={range.end} slot={shown} maxSlotMs={MAX_WINDOW_MS} onSlot={pickSlot} ariaLabel={text.overviewAria(formatDateTime(range.start), formatDateTime(range.end))} />
        {(overview.isLoading || overview.error || (overviewServices.key === overviewKey && overview.buckets.length === 0)) && <p className="starfield-overview-status">{overview.error ?? (overview.isLoading ? text.overviewLoading : text.overviewEmpty)}</p>}
      </div>}
      <div className="starfield-toolbar">
        <span className="starfield-legend"><i className="star-dot" /> {text.legendOk} <i className="star-spike" /> {text.legendFailed} <i className="star-dot star-dot-large" /> {text.legendSampled} <i className="star-avg" /> {text.legendAvg} <i className="star-percentile" /> {text.legendPercentiles}</span>
        <span>{text.dragHint}</span>
        <Tooltip text={text.slowestTooltip}>
          <Button size="condensed" variant="emphasized" disabled={points.length === 0} onClick={() => setSelection({ from, to, min: Math.min(slowestFloor(points), ceiling), max: ceiling })}>{text.slowestButton}</Button>
        </Tooltip>
      </div>
      <div className="starfield-chart">
        <StarfieldCanvas points={points} from={from} to={to} ceiling={ceiling} scale={scale} settlingMs={liveMs !== null && followsNow ? SETTLING_MS : 0} selection={selection} onSelect={setSelection} avgLabel={text.avgLabel} describe={text.describe} />
        {points.length === 0 && <p className="starfield-loading">{isLoading ? text.loading
          : segments.length > 0 ? text.emptySegment
          : tags.length > 0 ? text.emptyTags
          : text.empty}</p>}
      </div>
    </section>
    {selection && <section className="graph-panel starfield-panel">
      <div className="panel-heading">
        <div>
          <h2>{text.selectedHeading} <span className="panel-badge">{selected.length.toLocaleString()}</span></h2>
          <p>{formatWhen(selection.from)} – {formatWhen(selection.to)} · {formatMs(selection.min)} – {selection.max >= ceiling ? text.andAbove(formatMs(ceiling)) : formatMs(selection.max)} · {text.slowestFirst}</p>
          {columnVisibility.multiplicity === true && <p>{text.samplingExplain}</p>}
        </div>
        <div className="panel-controls"><Button size="condensed" variant="emphasized" onClick={() => setSelection(null)}>{text.clear}</Button></div>
      </div>
      {/* The page is always light, but the table follows the Dynatrace theme: its custom cells
          inherited the page's dark ink and vanished on the dark-theme table. The theme token keeps
          the text in step with whatever background the table draws. */}
      <div className="starfield-table" style={{ color: Colors.Text.Neutral.Default, background: Colors.Background.Surface.Default }}>
        <DataTable data={selected} columns={columns} sortable fullWidth resizable columnSizing={columnSizing} onColumnSizingChange={setColumnSizing} variant={{ verticalDividers: true }} columnVisibility={columnVisibility} onColumnVisibilityChange={setColumnVisibility}>
          <DataTable.Toolbar>
            <DataTable.VisibilitySettings />
          </DataTable.Toolbar>
          <DataTable.Pagination defaultPageSize={20} />
        </DataTable>
      </div>
    </section>}
  </main>;
};
