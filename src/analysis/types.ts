export interface Point {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export type Hand = "LEFT" | "RIGHT";
export type Stance = "orthodox" | "southpaw";

/** Boxing punch numbering: 1 jab, 2 cross, 3 lead hook, 4 rear hook, 5 lead uppercut, 6 rear uppercut */
export type PunchType =
  | "JAB"
  | "CROSS"
  | "LEAD_HOOK"
  | "REAR_HOOK"
  | "LEAD_UPPERCUT"
  | "REAR_UPPERCUT";

export const PUNCH_NUMBER: Record<PunchType, number> = {
  JAB: 1,
  CROSS: 2,
  LEAD_HOOK: 3,
  REAR_HOOK: 4,
  LEAD_UPPERCUT: 5,
  REAR_UPPERCUT: 6,
};

export const PUNCH_LABEL: Record<PunchType, string> = {
  JAB: "Jab",
  CROSS: "Cross",
  LEAD_HOOK: "Lead hook",
  REAR_HOOK: "Rear hook",
  LEAD_UPPERCUT: "Lead uppercut",
  REAR_UPPERCUT: "Rear uppercut",
};

export interface PunchEvent {
  time: number;
  round: number;
  hand: Hand;
  type: PunchType;
  speedMph: number;
  peakElbowAngle: number;
  extensionM: number;
  retractionMs: number | null;
}

export interface FrameMetrics {
  time: number;
  landmarks: Point[] | null;
  fullBodyVisible: boolean;
  wristTrail: { left: Point[]; right: Point[] };
  speedMph: { left: number; right: number };
  maxSpeedMph: number;
  elbowAngle: { left: number; right: number };
  guardUp: { left: boolean; right: boolean };
  punchCount: number;
  lastPunch: PunchEvent | null;
  lastCombo: string | null;
  recentGuardRatio: number;
  secondsSinceLastPunch: number;
}

export interface SessionStats {
  activeS: number;
  punches: PunchEvent[];
  guardUpRatio: { left: number; right: number };
  headMovement: number;
  stanceWidthRatio: number;
  maxSpeedMph: number;
  combos: Record<string, number>;
}

export type Severity = "good" | "warn" | "bad";

export interface Critique {
  severity: Severity;
  title: string;
  detail: string;
}

export interface ScoreBreakdown {
  total: number;
  grade: string;
  guard: number;
  technique: number;
  output: number;
  recovery: number;
  movement: number;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  source: "live" | "upload";
  drillId: string;
  rounds: number;
  roundLengthS: number;
  activeS: number;
  score: ScoreBreakdown;
  punchCount: number;
  byType: Partial<Record<PunchType, number>>;
  maxSpeedMph: number;
  avgSpeedMph: number;
  punchesPerMin: number;
  guardUpRatio: { left: number; right: number };
  avgExtensionDeg: number | null;
  avgRetractionMs: number | null;
  headMovement: number;
  stanceWidthRatio: number;
  combos: Record<string, number>;
  critiques: Critique[];
}
