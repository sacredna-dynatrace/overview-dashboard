import React, { useEffect, useMemo, useRef, useState } from "react";
import type { StarPoint } from "../hooks/useStarfieldData";

/** A region of the chart in data terms: end-time range (epoch ms) and response-time range (ms). */
export type StarSelection = { from: number; to: number; min: number; max: number };

export type StarScale = "log" | "linear";

type StarfieldCanvasProps = {
  points: StarPoint[];
  /** Window bounds, epoch ms. */
  from: number;
  to: number;
  /** Top of the field in ms; slower requests go to the overflow band above it. */
  ceiling: number;
  scale: StarScale;
  /** Width of the right-hand edge, in ms, where spans are still arriving; shaded when set. */
  settlingMs?: number;
  selection: StarSelection | null;
  onSelect: (selection: StarSelection | null) => void;
  height?: number;
  /** Label of the average guide, in the page's language. */
  avgLabel?: string;
  /** The chart's text alternative, in the page's language. */
  describe?: (count: number, failed: number, above: number, ceiling: string, guides: string) => string;
};

const describeInEnglish = (count: number, failed: number, above: number, ceiling: string, guides: string) =>
  `Response time of ${count} traced requests: ${failed} failed, ${above} above ${ceiling} in the overflow band${guides ? `; estimated ${guides}` : ""}. Drag to select a region.`;

/**
 * The overflow band sits above the field, with a small gap, inside the top margin. The right margin
 * holds the distribution strip.
 */
const HIST_GAP = 10;
const HIST_W = 76;
/** Height of one distribution row, px. */
const HIST_ROW_PX = 4;
const MARGIN = { top: 6, right: 16 + HIST_GAP + HIST_W, bottom: 30, left: 58 };
const BAND = 20;
const BAND_GAP = 6;
/** Width of one overflow-band column, px. */
const BUCKET_PX = 3;
/** The log axis starts at 1 ms; faster requests sit on its floor. */
const LOG_MIN = 1;

const AXIS_TEXT = "#64748b";
const SKY_TOP = "#0a1330";
const SKY_BOTTOM = "#132250";
const BAND_SKY = "#070d22";
const SKY_GRID = "rgba(148, 163, 184, 0.16)";
const SELECT_FILL = "rgba(125, 211, 252, 0.10)";
const SELECT_STROKE = "#7dd3fc";
/** Star colours as RGB, for the glow gradients. Failed is a rose red that holds up on the night sky. */
const OK_RGB = [156, 196, 255] as const;
const FAILED_RGB = [255, 92, 122] as const;
const FAILED_SPIKE = "#ffd1da";
/** Percentile guides: pale gold, so they read as reference lines rather than as more stars. */
const PERCENTILE_LINE = "rgba(252, 211, 77, 0.55)";
const PERCENTILE_TEXT = "#fde68a";
const PERCENTILES = [["p50", 0.5], ["p95", 0.95], ["p99", 0.99]] as const;
/** The average guide: a solid pale cyan line, apart from the dashed gold percentiles. */
const AVG_LINE = "rgba(103, 232, 249, 0.75)";
const AVG_TEXT = "#a5f3fc";
/** A press that moves less than this is a click, which clears the selection. */
const CLICK_PX = 4;
/**
 * Density damping. Additive glow summed to flat white where stars crowd (the 1 s and 2 s bands on
 * bby34718), hiding the shape inside them. Light is counted per cell as the glow area of the stars
 * in it; past DENSITY_CALM each star in the cell dims, so a crowd still reads brighter than its
 * surroundings but its light grows with the square root of its size, not linearly.
 */
const DENSITY_CELL_PX = 8;
const DENSITY_CALM = 6;
const DENSITY_POWER = 0.5;
const MIN_STAR_ALPHA = 0.05;

const formatTick = (ms: number) => (ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${Math.round(ms)} ms`);
const formatClock = (epoch: number) => new Date(epoch).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * A star's core radius from the requests it stands for. A record sampled 1 of 512 is drawn larger
 * and brighter than an unsampled one, so the field shows load rather than only stored traces.
 */
const radiusOf = (multiplicity: number) => Math.min(4.5, 0.9 + 0.55 * Math.log2(Math.max(1, multiplicity)));

type Guide = { label: string; ms: number; kind: "percentile" | "avg" };

/**
 * Request-weighted percentiles and average: each record counts for the requests it stands for, so
 * a sampled busy endpoint is not outvoted by a quiet one traced in full. Per service the weights
 * matched the request-count metric on bby34718 (UICommonController: 93,381 against 93,461), but
 * the figures remain estimates from traces. Sorted by value, the order their labels stack in.
 */
const weightedGuides = (points: StarPoint[], avgLabel: string): Guide[] => {
  if (points.length === 0) return [];
  const sorted = points.map((point) => [point.ms, point.multiplicity] as const).sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((sum, [, weight]) => sum + weight, 0);
  const percentiles = PERCENTILES.map(([label, share]): Guide => {
    let reached = 0;
    for (const [ms, weight] of sorted) {
      reached += weight;
      if (reached >= total * share) return { label, ms, kind: "percentile" };
    }
    return { label, ms: sorted[sorted.length - 1][0], kind: "percentile" };
  });
  const avg: Guide = { label: avgLabel, ms: sorted.reduce((sum, [ms, weight]) => sum + ms * weight, 0) / total, kind: "avg" };
  return [...percentiles, avg].sort((a, b) => a.ms - b.ms);
};

/** A soft radial glow, rendered once per colour and stamped for every star. */
const sprites = new Map<string, HTMLCanvasElement>();
const spriteOf = (rgb: readonly [number, number, number]) => {
  const key = rgb.join(",");
  const cached = sprites.get(key);
  if (cached) return cached;
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const half = size / 2;
    const gradient = context.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
    gradient.addColorStop(0.18, `rgba(${key}, 0.95)`);
    gradient.addColorStop(0.42, `rgba(${key}, 0.28)`);
    gradient.addColorStop(1, `rgba(${key}, 0)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  sprites.set(key, canvas);
  return canvas;
};

/**
 * The Starfield drawn straight onto canvas: requests as stars on a night sky, with the ones slower
 * than the ceiling gathered into an overflow band above the field instead of a pinned line.
 *
 * Two stacked layers: the stars redraw only when the data, scale, ceiling, size or selection
 * changes; the drag rectangle lives on the layer above, so dragging never repaints the stars.
 */
export const StarfieldCanvas = ({ points, from, to, ceiling, scale, settlingMs = 0, selection, onSelect, height = 440, avgLabel = "avg", describe = describeInEnglish }: StarfieldCanvasProps) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [width, setWidth] = useState(0);
  const guides = useMemo(() => weightedGuides(points, avgLabel), [avgLabel, points]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const bandTop = MARGIN.top;
  const bandBottom = bandTop + BAND;
  const plotTop = bandBottom + BAND_GAP;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - plotTop - MARGIN.bottom);
  const plotBottom = plotTop + plotH;
  const span = Math.max(1, to - from);
  const logSpan = Math.max(1e-6, Math.log10(ceiling) - Math.log10(LOG_MIN));

  /** Share of the field's height a response time reaches, 0 at the floor and 1 at the ceiling. */
  const fraction = (ms: number) => {
    const value = scale === "log"
      ? (Math.log10(Math.max(ms, LOG_MIN)) - Math.log10(LOG_MIN)) / logSpan
      : ms / ceiling;
    return Math.min(1, Math.max(0, value));
  };
  const xOf = (time: number) => MARGIN.left + ((time - from) / span) * plotW;
  const yOf = (ms: number) => plotBottom - fraction(ms) * plotH;
  const timeAt = (x: number) => from + ((x - MARGIN.left) / plotW) * span;
  /** The response time at a height; anything above the field's top means the ceiling and beyond. */
  const msAt = (y: number) => {
    if (y <= plotTop) return ceiling;
    const share = Math.min(1, Math.max(0, (plotBottom - y) / plotH));
    return scale === "log" ? 10 ** (Math.log10(LOG_MIN) + share * logSpan) : share * ceiling;
  };
  const clampX = (x: number) => Math.min(MARGIN.left + plotW, Math.max(MARGIN.left, x));
  const clampY = (y: number) => Math.min(plotBottom, Math.max(bandTop, y));

  /** Sizes a canvas for the device pixel ratio and returns a context drawing in CSS pixels. */
  const prepare = (canvas: HTMLCanvasElement | null) => {
    if (!canvas || width === 0) return null;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return context;
  };

  const drawRect = (context: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) => {
    context.fillStyle = SELECT_FILL;
    context.strokeStyle = SELECT_STROKE;
    context.lineWidth = 1;
    context.setLineDash([4, 3]);
    context.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    context.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    context.setLineDash([]);
  };

  const drawOverlay = () => {
    const context = prepare(overlayRef.current);
    if (!context) return;
    const drag = dragRef.current;
    if (drag) drawRect(context, drag.x0, drag.y0, drag.x1, drag.y1);
    else if (selection) {
      // A selection reaching the ceiling takes in the overflow band; one starting at it is the band alone.
      const top = selection.max >= ceiling ? bandTop : yOf(selection.max);
      const bottom = selection.min >= ceiling ? bandBottom : yOf(selection.min);
      drawRect(context, xOf(selection.from), top, xOf(selection.to), bottom);
    }
  };

  // Sky, axes, overflow band and stars.
  useEffect(() => {
    const context = prepare(baseRef.current);
    if (!context) return;

    const sky = context.createLinearGradient(0, plotTop, 0, plotBottom);
    sky.addColorStop(0, SKY_TOP);
    sky.addColorStop(1, SKY_BOTTOM);
    context.fillStyle = sky;
    context.fillRect(MARGIN.left, plotTop, plotW, plotH);
    context.fillStyle = BAND_SKY;
    context.fillRect(MARGIN.left, bandTop, plotW, BAND);
    if (settlingMs > 0) {
      // Spans for the last few seconds are still arriving: a haze says the edge will fill in.
      const edge = Math.max(MARGIN.left, xOf(to - settlingMs));
      const haze = context.createLinearGradient(edge, 0, MARGIN.left + plotW, 0);
      haze.addColorStop(0, "rgba(148, 163, 184, 0)");
      haze.addColorStop(1, "rgba(148, 163, 184, 0.22)");
      context.fillStyle = haze;
      context.fillRect(edge, bandTop, MARGIN.left + plotW - edge, plotBottom - bandTop);
    }

    context.font = "11px 'Segoe UI', sans-serif";
    context.fillStyle = AXIS_TEXT;
    context.strokeStyle = SKY_GRID;
    context.lineWidth = 1;

    // Y: decades on the log axis, quarters on the linear one; the ceiling always tops the field.
    const ticks = scale === "log"
      ? [...[1, 10, 100, 1000, 10000, 100000].filter((ms) => ms < ceiling * 0.6), ceiling]
      : [0, 1, 2, 3, 4].map((step) => (ceiling / 4) * step);
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (const ms of ticks) {
      const y = Math.round(yOf(ms)) + 0.5;
      context.beginPath(); context.moveTo(MARGIN.left, y); context.lineTo(MARGIN.left + plotW, y); context.stroke();
      context.fillText(scale === "log" && ms === LOG_MIN ? `≤ ${formatTick(ms)}` : formatTick(ms), MARGIN.left - 8, y);
    }
    context.fillText(`> ${formatTick(ceiling)}`, MARGIN.left - 8, bandTop + BAND / 2);
    // X: whole minutes, thinned so labels never collide.
    const minuteWidth = (60_000 / span) * plotW;
    const every = Math.max(1, Math.ceil(56 / Math.max(1, minuteWidth)));
    context.textAlign = "center";
    context.textBaseline = "top";
    for (let tick = Math.ceil(from / 60_000) * 60_000, index = 0; tick <= to; tick += 60_000, index += 1) {
      if (index % every !== 0) continue;
      const x = Math.round(xOf(tick)) + 0.5;
      context.beginPath(); context.moveTo(x, plotTop); context.lineTo(x, plotBottom); context.stroke();
      context.fillText(formatClock(tick), x, plotBottom + 8);
    }

    const inTime = (end: number) => !selection || (end >= selection.from && end <= selection.to);
    const inside = (point: StarPoint) => inTime(point.end) && (!selection
      || (Math.min(point.ms, ceiling) >= selection.min && Math.min(point.ms, ceiling) <= selection.max));

    // Overflow band: how many requests went past the ceiling in each sliver of time.
    const buckets = Math.max(1, Math.ceil(plotW / BUCKET_PX));
    const okCounts = new Array<number>(buckets).fill(0);
    const failedCounts = new Array<number>(buckets).fill(0);
    for (const point of points) {
      if (point.ms <= ceiling) continue;
      const bucket = Math.min(buckets - 1, Math.max(0, Math.floor((xOf(point.end) - MARGIN.left) / BUCKET_PX)));
      if (point.failed) failedCounts[bucket] += 1; else okCounts[bucket] += 1;
    }
    const peak = Math.max(1, ...okCounts.map((count, index) => count + failedCounts[index]));
    const bandSelected = !selection || selection.max >= ceiling;
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const total = okCounts[bucket] + failedCounts[bucket];
      if (total === 0) continue;
      const x = MARGIN.left + bucket * BUCKET_PX;
      const lit = bandSelected && inTime(timeAt(x + BUCKET_PX / 2));
      context.globalAlpha = (0.2 + 0.8 * Math.sqrt(total / peak)) * (lit ? 1 : 0.3);
      context.fillStyle = `rgb(${OK_RGB.join(",")})`;
      context.fillRect(x, bandTop + 2, BUCKET_PX - 1, BAND - 4);
      if (failedCounts[bucket] > 0) {
        // Failures sit as a red cap on the column, so they show even where OK requests dominate.
        context.fillStyle = `rgb(${FAILED_RGB.join(",")})`;
        context.fillRect(x, bandTop + 2, BUCKET_PX - 1, Math.max(3, (BAND - 4) * (failedCounts[bucket] / total)));
      }
    }
    context.globalAlpha = 1;

    // Stars: additive glow, so dense regions brighten like a galaxy instead of turning into a block.
    context.save();
    context.beginPath(); context.rect(MARGIN.left, plotTop, plotW, plotH); context.clip();
    context.globalCompositeOperation = "lighter";
    const okSprite = spriteOf(OK_RGB);
    const cellColumns = Math.ceil(plotW / DENSITY_CELL_PX) + 1;
    const cellOf = (x: number, y: number) => Math.max(0, Math.floor((x - MARGIN.left) / DENSITY_CELL_PX))
      + Math.max(0, Math.floor((y - plotTop) / DENSITY_CELL_PX)) * cellColumns;
    const stars = points.flatMap((point) => {
      if (point.failed || point.ms > ceiling) return [];
      const x = xOf(point.end);
      const y = yOf(point.ms);
      const radius = radiusOf(point.multiplicity);
      return [{ point, x, y, radius, cell: cellOf(x, y) }];
    });
    const light = new Map<number, number>();
    for (const star of stars) light.set(star.cell, (light.get(star.cell) ?? 0) + star.radius * star.radius);
    for (const { point, x, y, radius, cell } of stars) {
      const glow = radius * 3;
      const damping = Math.min(1, (DENSITY_CALM / (light.get(cell) ?? 1)) ** DENSITY_POWER);
      context.globalAlpha = Math.max(MIN_STAR_ALPHA, (inside(point) ? 0.55 : 0.12) * damping);
      context.drawImage(okSprite, x - glow, y - glow, glow * 2, glow * 2);
    }
    // Failures on top in normal blending, with a four-point spike: shape as well as colour.
    context.globalCompositeOperation = "source-over";
    const failedSprite = spriteOf(FAILED_RGB);
    context.strokeStyle = FAILED_SPIKE;
    context.lineWidth = 1;
    for (const point of points) {
      if (!point.failed || point.ms > ceiling) continue;
      const x = xOf(point.end);
      const y = yOf(point.ms);
      const radius = Math.max(1.6, radiusOf(point.multiplicity));
      const glow = radius * 3.2;
      const spike = radius * 2.4 + 2;
      context.globalAlpha = inside(point) ? 1 : 0.22;
      context.drawImage(failedSprite, x - glow, y - glow, glow * 2, glow * 2);
      context.beginPath();
      context.moveTo(x - spike, y); context.lineTo(x + spike, y);
      context.moveTo(x, y - spike); context.lineTo(x, y + spike);
      context.stroke();
    }
    context.restore();

    // Distribution strip: requests per height, weighted like the percentiles. Bar length is the
    // square root of the share, so the crowd near the floor does not flatten every other row.
    const histX = MARGIN.left + plotW + HIST_GAP;
    context.fillStyle = BAND_SKY;
    context.fillRect(histX, bandTop, HIST_W, BAND);
    context.fillStyle = sky;
    context.fillRect(histX, plotTop, HIST_W, plotH);
    const rows = Math.max(1, Math.ceil(plotH / HIST_ROW_PX));
    const okRows = new Array<number>(rows).fill(0);
    const failedRows = new Array<number>(rows).fill(0);
    let okOver = 0;
    let failedOver = 0;
    for (const point of points) {
      if (point.ms > ceiling) {
        if (point.failed) failedOver += point.multiplicity; else okOver += point.multiplicity;
        continue;
      }
      const row = Math.min(rows - 1, Math.max(0, Math.floor((plotBottom - yOf(point.ms)) / HIST_ROW_PX)));
      if (point.failed) failedRows[row] += point.multiplicity; else okRows[row] += point.multiplicity;
    }
    const rowPeak = Math.max(1, okOver + failedOver, ...okRows.map((count, row) => count + failedRows[row]));
    const drawBar = (y: number, barHeight: number, ok: number, failedCount: number) => {
      const total = ok + failedCount;
      if (total === 0) return;
      const length = Math.max(1, HIST_W * Math.sqrt(total / rowPeak));
      context.fillStyle = `rgba(${OK_RGB.join(",")}, 0.75)`;
      context.fillRect(histX, y, length, barHeight);
      if (failedCount > 0) {
        context.fillStyle = `rgb(${FAILED_RGB.join(",")})`;
        context.fillRect(histX, y, Math.max(1, length * (failedCount / total)), barHeight);
      }
    };
    for (let row = 0; row < rows; row += 1) {
      const y = Math.max(plotTop, plotBottom - (row + 1) * HIST_ROW_PX);
      drawBar(y, Math.min(HIST_ROW_PX - 1, plotBottom - row * HIST_ROW_PX - y), okRows[row], failedRows[row]);
    }
    drawBar(bandTop + 2, BAND - 4, okOver, failedOver);

    // Percentile and average guides across the field, labelled in the strip. Labels step apart
    // when close; a guide past the ceiling is named in the band row.
    context.font = "600 10px 'Segoe UI', sans-serif";
    context.textAlign = "right";
    context.textBaseline = "bottom";
    let labelFloor = Number.POSITIVE_INFINITY;
    for (const { label, ms, kind } of guides) {
      const over = ms > ceiling;
      const lineY = over ? bandTop + BAND / 2 : Math.round(yOf(ms)) + 0.5;
      if (!over) {
        context.strokeStyle = kind === "avg" ? AVG_LINE : PERCENTILE_LINE;
        context.setLineDash(kind === "avg" ? [] : [3, 4]);
        context.beginPath(); context.moveTo(MARGIN.left, lineY); context.lineTo(histX + HIST_W, lineY); context.stroke();
        context.setLineDash([]);
      }
      const labelY = Math.min(lineY - 1, labelFloor - 11);
      labelFloor = labelY;
      if (labelY < bandTop + 8) continue;
      context.fillStyle = kind === "avg" ? AVG_TEXT : PERCENTILE_TEXT;
      context.fillText(over ? `${label} > ${formatTick(ceiling)}` : `${label} ${formatTick(ms)}`, histX + HIST_W - 2, labelY);
    }
    drawOverlay();
    // Every value the drawing reads is listed; the helpers above are derived from them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, guides, from, to, ceiling, scale, settlingMs, selection, width, height]);

  const position = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const { x, y } = position(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x0: clampX(x), y0: clampY(y), x1: clampX(x), y1: clampY(y) };
    drawOverlay();
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = position(event);
    drag.x1 = clampX(x);
    drag.y1 = clampY(y);
    drawOverlay();
  };
  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (Math.abs(drag.x1 - drag.x0) < CLICK_PX && Math.abs(drag.y1 - drag.y0) < CLICK_PX) {
      onSelect(null);
      drawOverlay();
      return;
    }
    const top = Math.min(drag.y0, drag.y1);
    const bottom = Math.max(drag.y0, drag.y1);
    onSelect({
      from: timeAt(Math.min(drag.x0, drag.x1)),
      to: timeAt(Math.max(drag.x0, drag.x1)),
      // A box down to the floor takes everything below it, including sub-millisecond requests on the log axis.
      min: bottom >= plotBottom - 1 ? 0 : msAt(bottom),
      // A box reaching the top of the field or into the band takes in the overflow.
      max: top <= plotTop + 1 ? ceiling : msAt(top),
    });
  };

  const failed = points.reduce((count, point) => count + (point.failed ? 1 : 0), 0);
  const above = points.reduce((count, point) => count + (point.ms > ceiling ? 1 : 0), 0);

  return <div
    ref={wrapRef}
    className="starfield-canvas"
    style={{ height }}
    tabIndex={0}
    onKeyDown={(event) => { if (event.key === "Escape") onSelect(null); }}
  >
    <canvas ref={baseRef} style={{ width, height }} role="img" aria-label={describe(points.length, failed, above, formatTick(ceiling), guides.map(({ label, ms }) => `${label} ${formatTick(ms)}`).join(", "))} />
    <canvas
      ref={overlayRef}
      style={{ width, height }}
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { dragRef.current = null; drawOverlay(); }}
    />
  </div>;
};
