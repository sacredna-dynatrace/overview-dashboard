import React, { useEffect, useRef, useState } from "react";
import type { OverviewBucket } from "../hooks/useStarfieldOverview";

/** A stretch of time, epoch ms. */
export type TimeSpan = { from: number; to: number };

type StarfieldOverviewProps = {
  buckets: OverviewBucket[];
  /** The whole timeframe, epoch ms. */
  from: number;
  to: number;
  /** The stretch the field shows. */
  slot: TimeSpan;
  /** The longest stretch the field can show. */
  maxSlotMs: number;
  onSlot: (slot: TimeSpan) => void;
  ariaLabel: string;
  height?: number;
};

/** Same side margins as the field, so the two strips line up on the page. */
const MARGIN = { top: 6, right: 102, bottom: 22, left: 58 };
const SKY = "#0d1838";
const AXIS_TEXT = "#64748b";
const REQUESTS_FILL = "rgba(156, 196, 255, 0.35)";
const P95_LINE = "#fcd34d";
const AVG_LINE = "#67e8f9";
const SLOT_STROKE = "#7dd3fc";
const OUTSIDE_SLOT = "rgba(2, 6, 23, 0.45)";
const CLICK_PX = 4;
const MIN_SLOT_MS = 60_000;

/** A tick names its date when it is the first one or the day has changed since the previous one. */
const formatTick = (epoch: number, withDate: boolean) => new Date(epoch).toLocaleString(undefined, withDate
  ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
  : { hour: "2-digit", minute: "2-digit" });
const formatMs = (ms: number) => (ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${Math.round(ms)} ms`);

/**
 * The whole timeframe as one strip: requests as a filled area, p95 and average response time as
 * lines, and the stretch the field shows highlighted. A click centres a fifteen-minute stretch on
 * that moment; a drag picks a stretch, cut to fifteen minutes from its end when longer.
 */
export const StarfieldOverview = ({ buckets, from, to, slot, maxSlotMs, onSlot, ariaLabel, height = 92 }: StarfieldOverviewProps) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x0: number; x1: number } | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);
  const plotBottom = MARGIN.top + plotH;
  const span = Math.max(1, to - from);
  const xOf = (time: number) => MARGIN.left + ((time - from) / span) * plotW;
  const timeAt = (x: number) => from + ((Math.min(MARGIN.left + plotW, Math.max(MARGIN.left, x)) - MARGIN.left) / plotW) * span;

  /** Keeps a stretch inside the timeframe without changing its length. */
  const fit = (start: number, end: number): TimeSpan => {
    const length = Math.min(end - start, span);
    const fittedStart = Math.min(Math.max(start, from), to - length);
    return { from: fittedStart, to: fittedStart + length };
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = SKY;
    context.fillRect(MARGIN.left, MARGIN.top, plotW, plotH);

    // Requests as an area on their own scale; response times share a second scale.
    const peakRequests = Math.max(1, ...buckets.map((bucket) => bucket.requests));
    const peakMs = Math.max(1, ...buckets.map((bucket) => Math.max(bucket.p95Ms ?? 0, bucket.avgMs ?? 0)));
    context.fillStyle = REQUESTS_FILL;
    for (const bucket of buckets) {
      const x0 = xOf(bucket.start);
      const barHeight = (bucket.requests / peakRequests) * plotH * 0.9;
      context.fillRect(x0, plotBottom - barHeight, Math.max(1, xOf(bucket.end) - x0), barHeight);
    }
    const line = (pick: (bucket: OverviewBucket) => number | null, color: string) => {
      context.strokeStyle = color;
      context.lineWidth = 1.25;
      context.beginPath();
      let drawing = false;
      for (const bucket of buckets) {
        const value = pick(bucket);
        if (value === null) { drawing = false; continue; }
        const x = xOf((bucket.start + bucket.end) / 2);
        const y = plotBottom - (value / peakMs) * plotH * 0.9;
        if (drawing) context.lineTo(x, y); else context.moveTo(x, y);
        drawing = true;
      }
      context.stroke();
    };
    line((bucket) => bucket.avgMs, AVG_LINE);
    line((bucket) => bucket.p95Ms, P95_LINE);

    // Scale notes beside the strip: the highest p95 and the busiest bucket.
    context.font = "600 10px 'Segoe UI', sans-serif";
    context.textAlign = "left";
    context.textBaseline = "top";
    if (buckets.length > 0) {
      context.fillStyle = "#b45309";
      context.fillText(`p95 ≤ ${formatMs(peakMs)}`, MARGIN.left + plotW + 8, MARGIN.top);
    }

    // Time ticks, about one per 140 px.
    context.fillStyle = AXIS_TEXT;
    context.font = "11px 'Segoe UI', sans-serif";
    context.textAlign = "center";
    const ticks = Math.max(2, Math.floor(plotW / 140));
    let previousDay = "";
    for (let index = 0; index <= ticks; index += 1) {
      const time = from + (span * index) / ticks;
      const day = new Date(time).toDateString();
      context.fillText(formatTick(time, day !== previousDay), Math.min(Math.max(xOf(time), MARGIN.left + 45), MARGIN.left + plotW - 45), plotBottom + 6);
      previousDay = day;
    }

    // The stretch shown below, or the one being dragged: the rest of the strip is dimmed.
    const drag = dragRef.current;
    const left = drag ? Math.min(drag.x0, drag.x1) : xOf(slot.from);
    const right = drag ? Math.max(drag.x0, drag.x1) : xOf(slot.to);
    context.fillStyle = OUTSIDE_SLOT;
    context.fillRect(MARGIN.left, MARGIN.top, Math.max(0, left - MARGIN.left), plotH);
    context.fillRect(right, MARGIN.top, Math.max(0, MARGIN.left + plotW - right), plotH);
    context.strokeStyle = SLOT_STROKE;
    context.lineWidth = 1.5;
    context.strokeRect(left + 0.5, MARGIN.top + 0.5, Math.max(2, right - left), plotH - 1);
  };

  useEffect(draw);

  const position = (event: React.PointerEvent<HTMLCanvasElement>) => event.clientX - event.currentTarget.getBoundingClientRect().left;
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const x = position(event);
    dragRef.current = { x0: x, x1: x };
    draw();
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    dragRef.current.x1 = position(event);
    draw();
  };
  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (Math.abs(drag.x1 - drag.x0) < CLICK_PX) {
      const centre = timeAt(drag.x0);
      onSlot(fit(centre - maxSlotMs / 2, centre + maxSlotMs / 2));
      return;
    }
    const end = timeAt(Math.max(drag.x0, drag.x1));
    const start = Math.max(timeAt(Math.min(drag.x0, drag.x1)), end - maxSlotMs);
    onSlot(fit(Math.min(start, end - MIN_SLOT_MS), end));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Arrow keys step the stretch by its own length, for readers without a pointer.
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = (slot.to - slot.from) * (event.key === "ArrowLeft" ? -1 : 1);
    onSlot(fit(slot.from + step, slot.to + step));
  };

  return <div ref={wrapRef} className="starfield-overview" style={{ height }} tabIndex={0} onKeyDown={onKeyDown}>
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      role="img"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { dragRef.current = null; draw(); }}
    />
  </div>;
};
