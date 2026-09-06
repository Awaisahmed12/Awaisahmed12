import { SKELETON, LM } from "./pose";
import type { FrameMetrics } from "./types";

const ACCENT = "#ff3d1f";
const BONE = "rgba(255,255,255,0.9)";
const JOINT = "#3ddc84";

export interface ContentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fit a video's intrinsic size into its element box (object-fit: contain). */
export function contentRect(video: HTMLVideoElement): ContentRect {
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const cw = video.clientWidth, ch = video.clientHeight;
  const s = Math.min(cw / vw, ch / vh);
  const w = vw * s, h = vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  m: FrameMetrics,
  canvasW: number,
  canvasH: number,
  r: ContentRect,
  mirror: boolean
) {
  ctx.clearRect(0, 0, canvasW, canvasH);
  const lm = m.landmarks;
  if (!lm) return;
  const X = (x: number) => r.x + (mirror ? 1 - x : x) * r.w;
  const Y = (y: number) => r.y + y * r.h;

  for (const trail of [m.wristTrail.left, m.wristTrail.right]) {
    for (let i = 1; i < trail.length; i++) {
      ctx.strokeStyle = ACCENT;
      ctx.globalAlpha = i / trail.length;
      ctx.lineWidth = 2 + (5 * i) / trail.length;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(X(trail[i - 1].x), Y(trail[i - 1].y));
      ctx.lineTo(X(trail[i].x), Y(trail[i].y));
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = BONE;
  ctx.lineWidth = 2.5;
  for (const [a, b] of SKELETON) {
    ctx.beginPath();
    ctx.moveTo(X(lm[a].x), Y(lm[a].y));
    ctx.lineTo(X(lm[b].x), Y(lm[b].y));
    ctx.stroke();
  }
  ctx.fillStyle = JOINT;
  for (const [a] of SKELETON) {
    ctx.beginPath();
    ctx.arc(X(lm[a].x), Y(lm[a].y), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const side of ["left", "right"] as const) {
    const idx = side === "left" ? LM.L_WRIST : LM.R_WRIST;
    ctx.fillStyle = m.guardUp[side] ? JOINT : ACCENT;
    ctx.beginPath();
    ctx.arc(X(lm[idx].x), Y(lm[idx].y), 8, 0, Math.PI * 2);
    ctx.fill();
  }

  const nose = lm[LM.NOSE];
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.moveTo(X(nose.x), Y(nose.y) - 28);
  ctx.lineTo(X(nose.x) - 8, Y(nose.y) - 42);
  ctx.lineTo(X(nose.x) + 8, Y(nose.y) - 42);
  ctx.closePath();
  ctx.fill();
}
