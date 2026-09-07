Hi, I’m Awais (@Awaisahmed12), a software engineer.
How to reach me - ahmedawais672@gmail.com

---

# Boxing Coach 🥊

A boxing coach that watches every punch you throw. Prop up your phone (or
upload a recorded session), shadowbox, and get scored on guard, extension,
speed, recovery and movement — round by round, with specific fixes.

Everything runs **on-device in the browser** (MediaPipe pose tracking via
WebAssembly). No video ever leaves the phone; only session stats are stored,
and only locally.

## Product

- **Train** — pick a drill, set rounds / round length / rest, start with the
  camera or analyze a video. Bell, 10-second warning, rest timer, spoken cues
  ("hands up", "stay busy"), live HUD with speed, punch count, guard, elbow angle,
  skeleton + wrist-trail overlay and combo pop-ups.
- **Session report** — 0–100 score with grade, breakdown (guard / technique /
  output / recovery / movement), coach's notes ranked by severity, punch mix,
  detected combinations (1-2, 1-1-2, 1-2-3 …).
- **History & Progress** — every session saved, charts for score, hand speed,
  guard %, punches/min and hand-return time over time.
- **Drills** — Shadowboxing, 1-2 Drill (free); Guard Discipline, Combination
  Builder, Slip & Move, Speed Round (Pro). Each shifts the scoring weights.
- **Monetization** — 7-day Pro trial on signup (no card), then Free vs Pro.
  Free: 1 round/session, top coaching note only, last 3 sessions, 2 drills.
  Pro ($9.99/mo or $59.99/yr): everything.

## How the tracking works

- MediaPipe Pose Landmarker (lite) gives 33 image landmarks plus **metric
  world landmarks**. Speeds, reach and elbow angles use the metric 3D points so
  punches thrown toward the camera register properly; image points drive the
  overlay and "is the hand above the shoulder" checks.
- Each hand runs a state machine: GUARD → EXTENDING → RETRACTING. A punch
  counts when wrist speed, reach from the shoulder and travel all clear
  thresholds; it's classified by elbow angle (straight vs bent) and vertical
  travel (hook vs uppercut), then named by stance (jab / cross / lead hook …).
- Combos are runs of punches ≤ 0.75 s apart, recorded in punch-number notation.
- Guard = wrist within ~34 cm of the nose and at/above shoulder height, judged
  only while the hand isn't punching. Head movement = std-dev of the nose in
  the horizontal plane. Stance = ankle spread ÷ shoulder width.
- Scoring (`src/analysis/score.ts`) ramps each component between "clearly bad"
  and "clearly good" values; drills reweight the components.

## Running it

```bash
npm install     # also copies the MediaPipe WASM runtime into public/
npm run dev
```

Camera access needs HTTPS or localhost. `npm run build` produces a static
`dist/` — deploy anywhere (Vercel config included).

### Environment variables (optional)

| Variable | Purpose |
|---|---|
| `VITE_STRIPE_MONTHLY_URL` | Stripe Payment Link for the monthly plan |
| `VITE_STRIPE_YEARLY_URL` | Stripe Payment Link for the yearly plan |
| `VITE_LICENSE_KEYS` | Comma-separated keys that unlock Pro (launch stopgap until there's a backend) |

## Filming tips

Phone at waist height, 2–3 m away, side or 45° angle, whole body in frame
(feet included), decent light, plain background.

## Stack

React 18 · TypeScript · Vite · `@mediapipe/tasks-vision` · Vercel Analytics.
No backend, no external runtime dependencies — the pose model and WASM are
served with the app.
