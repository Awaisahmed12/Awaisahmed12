import { LM } from "./pose";
import type {
  FrameMetrics,
  Hand,
  Point,
  PunchEvent,
  PunchType,
  SessionStats,
  Stance,
} from "./types";
import { PUNCH_NUMBER } from "./types";

const MS_TO_MPH = 2.23694;
const MAX_PLAUSIBLE_SPEED = 16; // m/s — anything faster is a tracking glitch
const PUNCH_START_SPEED = 2.4; // m/s
const PUNCH_MIN_PEAK_SPEED = 3.4; // m/s (~7.5 mph)
const PUNCH_MIN_EXTENSION = 0.38; // m from shoulder to wrist
const PUNCH_MIN_TRAVEL = 0.12; // m gained during the punch
const GUARD_CHIN_RADIUS = 0.34; // m wrist-to-nose
const COMBO_GAP_S = 0.75;
const TRAIL_LEN = 12;
const RECENT_WINDOW_S = 8;

const d3 = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

function angle3(a: Point, v: Point, c: Point): number {
  const ax = a.x - v.x, ay = a.y - v.y, az = (a.z ?? 0) - (v.z ?? 0);
  const cx = c.x - v.x, cy = c.y - v.y, cz = (c.z ?? 0) - (v.z ?? 0);
  const dot = ax * cx + ay * cy + az * cz;
  const m = Math.hypot(ax, ay, az) * Math.hypot(cx, cy, cz);
  if (m === 0) return 0;
  return (Math.acos(Math.min(1, Math.max(-1, dot / m))) * 180) / Math.PI;
}

type Phase = "GUARD" | "EXTENDING" | "RETRACTING";

interface HandState {
  phase: Phase;
  pos: Point | null;
  speed: number;
  prevExt: number;
  startExt: number;
  startImgY: number;
  shrinking: number;
  peakSpeed: number;
  peakElbow: number;
  peakExt: number;
  startT: number;
  retractT: number;
  pending: PunchEvent | null;
  guardFrames: number;
  activeFrames: number;
  trail: Point[];
  recent: { t: number; up: boolean }[];
}

const hand = (): HandState => ({
  phase: "GUARD",
  pos: null,
  speed: 0,
  prevExt: 0,
  startExt: 0,
  startImgY: 0,
  shrinking: 0,
  peakSpeed: 0,
  peakElbow: 0,
  peakExt: 0,
  startT: 0,
  retractT: 0,
  pending: null,
  guardFrames: 0,
  activeFrames: 0,
  trail: [],
  recent: [],
});

const IDX = {
  LEFT: { wrist: LM.L_WRIST, elbow: LM.L_ELBOW, shoulder: LM.L_SHOULDER },
  RIGHT: { wrist: LM.R_WRIST, elbow: LM.R_ELBOW, shoulder: LM.R_SHOULDER },
} as const;

/**
 * Consumes MediaPipe pose output frame by frame and turns it into boxing
 * metrics. Speeds, reach and angles use the metric world landmarks so punches
 * thrown toward the camera register properly; image landmarks are used for
 * drawing and for "is the hand above the shoulder" style checks.
 */
export class BoxingAnalyzer {
  private lead: Hand;
  private hands: Record<Hand, HandState> = { LEFT: hand(), RIGHT: hand() };
  private world: Point[] | null = null;
  private prevT = -1;
  private activeS = 0;
  private punches: PunchEvent[] = [];
  private lastPunch: PunchEvent | null = null;
  private maxSpeedMph = 0;
  private noseSamples: Point[] = [];
  private stanceRatios: number[] = [];
  private frames = 0;
  private comboBuf: PunchEvent[] = [];
  private combos: Record<string, number> = {};
  private lastCombo: string | null = null;
  private currentRound = 1;

  constructor(stance: Stance) {
    this.lead = stance === "orthodox" ? "LEFT" : "RIGHT";
  }

  setRound(r: number) {
    this.currentRound = r;
  }

  /**
   * @param img normalized image landmarks (for drawing / up-down checks)
   * @param world metric landmarks, meters, hip-centered
   * @param t seconds, monotonic within the session
   * @param active false during rest periods — frames are drawn but not scored
   */
  update(img: Point[] | null, world: Point[] | null, t: number, active: boolean): FrameMetrics {
    const dt = this.prevT >= 0 ? t - this.prevT : 0;
    this.prevT = t;

    if (!img || !world || img.length < 33 || world.length < 33) {
      return this.metrics(t, null, false);
    }

    const a = 0.5;
    if (!this.world) {
      this.world = world.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 }));
    } else {
      for (let i = 0; i < 33; i++) {
        const s = this.world[i];
        s.x = a * world[i].x + (1 - a) * s.x;
        s.y = a * world[i].y + (1 - a) * s.y;
        s.z = a * (world[i].z ?? 0) + (1 - a) * (s.z ?? 0);
      }
    }
    const w = this.world;
    const fullBody =
      (img[LM.L_ANKLE].visibility ?? 1) > 0.4 &&
      (img[LM.R_ANKLE].visibility ?? 1) > 0.4;

    const valid = dt > 0 && dt < 0.5;
    if (valid && active) {
      this.activeS += dt;
      this.frames++;
      this.noseSamples.push({ x: w[LM.NOSE].x, y: w[LM.NOSE].y, z: w[LM.NOSE].z });
      if (this.noseSamples.length > 400) this.noseSamples.shift();
      const shoulderW = d3(w[LM.L_SHOULDER], w[LM.R_SHOULDER]);
      if (fullBody && shoulderW > 0.15) {
        this.stanceRatios.push(d3(w[LM.L_ANKLE], w[LM.R_ANKLE]) / shoulderW);
      }
    }
    for (const h of ["LEFT", "RIGHT"] as const) {
      this.track(h, img, w, dt, t, valid, active);
    }
    this.expireCombo(t);

    return this.metrics(t, img, fullBody);
  }

  private track(hand: Hand, img: Point[], w: Point[], dt: number, t: number, valid: boolean, active: boolean) {
    const h = this.hands[hand];
    const ix = IDX[hand];
    const wrist = w[ix.wrist], elbow = w[ix.elbow], shoulder = w[ix.shoulder];

    h.trail.push({ x: img[ix.wrist].x, y: img[ix.wrist].y });
    if (h.trail.length > TRAIL_LEN) h.trail.shift();

    if (h.pos && valid) {
      const inst = d3(wrist, h.pos) / dt;
      if (inst < MAX_PLAUSIBLE_SPEED) h.speed = 0.5 * inst + 0.5 * h.speed;
    }
    h.pos = { x: wrist.x, y: wrist.y, z: wrist.z };
    if (!valid) return;

    const ext = d3(wrist, shoulder);
    const elbowAngle = angle3(shoulder, elbow, wrist);
    h.shrinking = ext > h.prevExt ? 0 : h.shrinking + 1;
    const prevExt = h.prevExt;
    h.prevExt = ext;

    const mph = h.speed * MS_TO_MPH;
    if (active && mph > this.maxSpeedMph) this.maxSpeedMph = mph;

    const up = this.guardUp(hand, img, w);
    h.recent.push({ t, up });
    while (h.recent.length && t - h.recent[0].t > RECENT_WINDOW_S) h.recent.shift();

    if (!active) {
      h.phase = "GUARD";
      h.pending = null;
      return;
    }

    switch (h.phase) {
      case "GUARD":
        h.activeFrames++;
        if (up) h.guardFrames++;
        if (h.speed > PUNCH_START_SPEED && ext > prevExt) {
          h.phase = "EXTENDING";
          h.startT = t;
          h.startExt = prevExt;
          h.startImgY = img[ix.wrist].y;
          h.peakSpeed = h.speed;
          h.peakElbow = elbowAngle;
          h.peakExt = ext;
        }
        break;
      case "EXTENDING": {
        h.peakSpeed = Math.max(h.peakSpeed, h.speed);
        h.peakElbow = Math.max(h.peakElbow, elbowAngle);
        h.peakExt = Math.max(h.peakExt, ext);
        const stalled = h.shrinking >= 2 || h.speed < 0.8;
        if (stalled) {
          const counts =
            h.peakSpeed > PUNCH_MIN_PEAK_SPEED &&
            h.peakExt > PUNCH_MIN_EXTENSION &&
            h.peakExt - h.startExt > PUNCH_MIN_TRAVEL;
          if (counts) {
            const rose = h.startImgY - img[ix.wrist].y; // image y is down-positive
            const punch: PunchEvent = {
              time: t,
              round: this.currentRound,
              hand,
              type: this.classify(hand, h.peakElbow, rose),
              speedMph: h.peakSpeed * MS_TO_MPH,
              peakElbowAngle: h.peakElbow,
              extensionM: h.peakExt,
              retractionMs: null,
            };
            this.punches.push(punch);
            this.lastPunch = punch;
            this.pushCombo(punch);
            h.pending = punch;
            h.retractT = t;
            h.phase = "RETRACTING";
          } else {
            h.phase = "GUARD";
          }
        } else if (t - h.startT > 0.7) {
          h.phase = "GUARD";
        }
        break;
      }
      case "RETRACTING": {
        const home = ext < h.startExt + 0.08 || up;
        if (home) {
          if (h.pending) h.pending.retractionMs = (t - h.retractT) * 1000;
          h.pending = null;
          h.phase = "GUARD";
        } else if (t - h.retractT > 1.5) {
          h.pending = null;
          h.phase = "GUARD";
        }
        break;
      }
    }
  }

  private classify(hand: Hand, peakElbow: number, rose: number): PunchType {
    const isLead = hand === this.lead;
    if (peakElbow >= 150) return isLead ? "JAB" : "CROSS";
    if (rose > 0.07) return isLead ? "LEAD_UPPERCUT" : "REAR_UPPERCUT";
    return isLead ? "LEAD_HOOK" : "REAR_HOOK";
  }

  private guardUp(hand: Hand, img: Point[], w: Point[]): boolean {
    const ix = IDX[hand];
    const nearChin = d3(w[ix.wrist], w[LM.NOSE]) < GUARD_CHIN_RADIUS;
    const shoulderW = Math.abs(img[LM.L_SHOULDER].x - img[LM.R_SHOULDER].x) || 0.2;
    const high = img[ix.wrist].y < img[ix.shoulder].y + 0.3 * shoulderW;
    return nearChin && high;
  }

  private pushCombo(p: PunchEvent) {
    const last = this.comboBuf[this.comboBuf.length - 1];
    if (last && p.time - last.time > COMBO_GAP_S) this.flushCombo();
    this.comboBuf.push(p);
  }

  private expireCombo(t: number) {
    const last = this.comboBuf[this.comboBuf.length - 1];
    if (last && t - last.time > COMBO_GAP_S) this.flushCombo();
  }

  private flushCombo() {
    if (this.comboBuf.length >= 2) {
      const key = this.comboBuf.map((p) => PUNCH_NUMBER[p.type]).join("-");
      this.combos[key] = (this.combos[key] ?? 0) + 1;
      this.lastCombo = key;
    }
    this.comboBuf = [];
  }

  private metrics(t: number, img: Point[] | null, fullBody: boolean): FrameMetrics {
    const L = this.hands.LEFT, R = this.hands.RIGHT;
    const recent = [...L.recent, ...R.recent];
    const w = this.world;
    return {
      time: t,
      landmarks: img,
      fullBodyVisible: fullBody,
      wristTrail: { left: [...L.trail], right: [...R.trail] },
      speedMph: { left: L.speed * MS_TO_MPH, right: R.speed * MS_TO_MPH },
      maxSpeedMph: this.maxSpeedMph,
      elbowAngle: w
        ? {
            left: angle3(w[LM.L_SHOULDER], w[LM.L_ELBOW], w[LM.L_WRIST]),
            right: angle3(w[LM.R_SHOULDER], w[LM.R_ELBOW], w[LM.R_WRIST]),
          }
        : { left: 0, right: 0 },
      guardUp:
        img && w
          ? { left: this.guardUp("LEFT", img, w), right: this.guardUp("RIGHT", img, w) }
          : { left: false, right: false },
      punchCount: this.punches.length,
      lastPunch: this.lastPunch,
      lastCombo: this.lastCombo,
      recentGuardRatio: recent.length
        ? recent.filter((r) => r.up).length / recent.length
        : 1,
      secondsSinceLastPunch: this.lastPunch ? t - this.lastPunch.time : t,
    };
  }

  stats(): SessionStats {
    this.flushCombo();
    const ratio = (h: HandState) => (h.activeFrames > 0 ? h.guardFrames / h.activeFrames : 1);
    let headMovement = 0;
    const n = this.noseSamples.length;
    if (n > 10) {
      const mx = this.noseSamples.reduce((s, p) => s + p.x, 0) / n;
      const mz = this.noseSamples.reduce((s, p) => s + (p.z ?? 0), 0) / n;
      headMovement = Math.sqrt(
        this.noseSamples.reduce((s, p) => s + (p.x - mx) ** 2 + ((p.z ?? 0) - mz) ** 2, 0) / n
      );
    }
    const sorted = [...this.stanceRatios].sort((a, b) => a - b);
    return {
      activeS: this.activeS,
      punches: [...this.punches],
      guardUpRatio: { left: ratio(this.hands.LEFT), right: ratio(this.hands.RIGHT) },
      headMovement,
      stanceWidthRatio: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      maxSpeedMph: this.maxSpeedMph,
      combos: { ...this.combos },
    };
  }

  hasData(): boolean {
    return this.frames > 40;
  }
}
