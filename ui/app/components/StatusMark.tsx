import React from "react";
import { STATUS } from "../theme/colors";

/**
 * Health as shape and symbol as well as colour: a circle with a tick, or a diamond with a cross.
 *
 * Green against red was the only difference before, which is exactly the pair a red-green colour
 * deficiency cannot tell apart - and it also vanished on a greyscale screenshot. The shapes follow
 * the Strato status convention, so they read the same as elsewhere in Dynatrace.
 */
const Mark = ({ problem }: { problem: boolean }) => problem
  ? <>
    <path d="M0,-7 L7,0 L0,7 L-7,0 Z" fill={STATUS.problem} />
    <path d="M-2.4,-2.4 L2.4,2.4 M2.4,-2.4 L-2.4,2.4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
  </>
  : <>
    <circle r="6.5" fill={STATUS.ok} />
    <path d="M-3,0.2 L-0.9,2.3 L3.2,-2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </>;

/** For use inside the map's SVG, centred on (x, y). */
export const StatusMark = ({ x, y, problem }: { x: number; y: number; problem: boolean }) =>
  <g transform={`translate(${x} ${y})`} aria-hidden="true"><Mark problem={problem} /></g>;

/** A standalone icon for HTML - the legend and the pod list. */
export const StatusIcon = ({ problem, size = 12 }: { problem: boolean; size?: number }) =>
  <svg width={size} height={size} viewBox="-7.5 -7.5 15 15" aria-hidden="true" className="status-icon"><Mark problem={problem} /></svg>;
