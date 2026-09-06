import { useCallback, useEffect, useRef, useState } from "react";
import { BoxingAnalyzer } from "../analysis/analyzer";
import { buildCritiques } from "../analysis/critique";
import { contentRect, drawOverlay } from "../analysis/draw";
import { getPoseLandmarker } from "../analysis/pose";
import { scoreSession } from "../analysis/score";
import { PUNCH_LABEL, type FrameMetrics, type PunchType, type SessionRecord } from "../analysis/types";
import { FREE_MAX_ROUNDS } from "../billing/plans";
import { TopBar } from "../components/Nav";
import { beep, bell, primeAudio, speak } from "../lib/audio";
import { navigate, routeQuery } from "../lib/router";
import { useStore } from "../state/store";
import { DRILLS, drillById } from "../training/drills";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";

type Phase = "setup" | "loading" | "countdown" | "round" | "rest" | "paused" | "finishing";

interface Live {
  phase: Phase;
  round: number;
  roundsTotal: number;
  remainingS: number;
  metrics: FrameMetrics | null;
  notice: string | null;
}

const COUNTDOWN_S = 5;
const fmt = (s: number) => {
  const v = Math.max(0, Math.ceil(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};

export function Train() {
  const { profile, pro, addSession } = useStore();
  const { settings } = profile;

  const [drillId, setDrillId] = useState(() => {
    const q = routeQuery().get("drill");
    const d = q ? drillById(q) : DRILLS[0];
    return d.pro && !pro ? DRILLS[0].id : d.id;
  });
  const drill = drillById(drillId);
  const [rounds, setRounds] = useState(() => (pro ? drill.rounds : FREE_MAX_ROUNDS));
  const [roundLen, setRoundLen] = useState(drill.roundLengthS);
  const [rest, setRest] = useState(drill.restS);
  const [source, setSource] = useState<"live" | "upload">("live");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live>({
    phase: "setup",
    round: 0,
    roundsTotal: 1,
    remainingS: 0,
    metrics: null,
    notice: null,
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const S = useRef({
    phase: "setup" as Phase,
    prevPhase: "round" as Phase,
    round: 0,
    roundsTotal: 1,
    roundLen: 180,
    rest: 60,
    phaseEnds: 0,
    pausedRemaining: 0,
    warned: false,
    restBeeps: 0,
    raf: 0,
    lastTs: -1,
    lastUi: 0,
    notVisibleSince: -1,
    startedAt: 0,
    source: "live" as "live" | "upload",
    analyzer: null as BoxingAnalyzer | null,
    landmarker: null as PoseLandmarker | null,
    stream: null as MediaStream | null,
    objectUrl: null as string | null,
    wakeLock: null as { release(): Promise<void> } | null,
    finished: false,
  });

  const pickDrill = (id: string) => {
    const d = drillById(id);
    if (d.pro && !pro) return navigate("plans");
    setDrillId(id);
    setRounds(pro ? d.rounds : FREE_MAX_ROUNDS);
    setRoundLen(d.roundLengthS);
    setRest(d.restS);
  };

  const teardown = useCallback(() => {
    const s = S.current;
    cancelAnimationFrame(s.raf);
    s.stream?.getTracks().forEach((t) => t.stop());
    s.stream = null;
    if (s.objectUrl) URL.revokeObjectURL(s.objectUrl);
    s.objectUrl = null;
    void s.wakeLock?.release().catch(() => undefined);
    s.wakeLock = null;
    window.speechSynthesis?.cancel();
  }, []);

  useEffect(() => teardown, [teardown]);

  const finish = useCallback(() => {
    const s = S.current;
    if (s.finished) return;
    s.finished = true;
    s.phase = "finishing";
    setLive((l) => ({ ...l, phase: "finishing" }));
    teardown();
    const analyzer = s.analyzer;
    if (!analyzer || !analyzer.hasData()) {
      setError("Not enough of you was tracked to score the session. Make sure your full body is in frame with decent light.");
      s.phase = "setup";
      s.finished = false;
      setLive((l) => ({ ...l, phase: "setup" }));
      return;
    }
    const stats = analyzer.stats();
    const score = scoreSession(stats, drill);
    const critiques = buildCritiques(stats, drill, profile.stance);
    const byType: Partial<Record<PunchType, number>> = {};
    for (const p of stats.punches) byType[p.type] = (byType[p.type] ?? 0) + 1;
    const straights = stats.punches.filter((p) => p.type === "JAB" || p.type === "CROSS");
    const rets = stats.punches.map((p) => p.retractionMs).filter((r): r is number => r !== null);
    const record: SessionRecord = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      startedAt: s.startedAt,
      source: s.source,
      drillId: drill.id,
      rounds: s.roundsTotal,
      roundLengthS: s.roundLen,
      activeS: stats.activeS,
      score,
      punchCount: stats.punches.length,
      byType,
      maxSpeedMph: stats.maxSpeedMph,
      avgSpeedMph: stats.punches.length
        ? stats.punches.reduce((a, p) => a + p.speedMph, 0) / stats.punches.length
        : 0,
      punchesPerMin: stats.punches.length / Math.max(stats.activeS / 60, 1 / 60),
      guardUpRatio: stats.guardUpRatio,
      avgExtensionDeg: straights.length
        ? straights.reduce((a, p) => a + p.peakElbowAngle, 0) / straights.length
        : null,
      avgRetractionMs: rets.length ? rets.reduce((a, r) => a + r, 0) / rets.length : null,
      headMovement: stats.headMovement,
      stanceWidthRatio: stats.stanceWidthRatio,
      combos: stats.combos,
      critiques,
    };
    addSession(record);
    navigate(`session/${record.id}`);
  }, [addSession, drill, profile.stance, teardown]);

  const startRound = useCallback(
    (n: number, now: number) => {
      const s = S.current;
      s.round = n;
      s.phase = "round";
      s.phaseEnds = now + s.roundLen;
      s.warned = false;
      s.analyzer?.setRound(n);
      if (settings.sound) bell();
      if (settings.voice && pro) speak(n === 1 ? drill.cue : `Round ${n}. ${drill.cue}`, 0);
    },
    [drill.cue, pro, settings.sound, settings.voice]
  );

  const loop = useCallback(() => {
    const s = S.current;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || s.finished) return;
    const now = performance.now() / 1000;
    let notice: string | null = null;

    if (s.phase === "countdown" && now >= s.phaseEnds) startRound(1, now);
    else if (s.phase === "round") {
      const remaining = s.phaseEnds - now;
      if (s.source === "live") {
        if (remaining <= 10 && !s.warned) {
          s.warned = true;
          if (settings.sound) beep(1);
        }
        if (remaining <= 0) {
          if (s.round >= s.roundsTotal) return finish();
          if (settings.sound) bell();
          if (s.rest > 0) {
            s.phase = "rest";
            s.phaseEnds = now + s.rest;
            s.restBeeps = 0;
            if (settings.voice && pro) speak("Rest. Breathe.", 0);
          } else startRound(s.round + 1, now);
        }
      }
    } else if (s.phase === "rest") {
      const remaining = s.phaseEnds - now;
      if (remaining <= 3 && s.restBeeps < 3 && remaining <= 3 - s.restBeeps) {
        s.restBeeps++;
        if (settings.sound) beep(1);
      }
      if (remaining <= 0) startRound(s.round + 1, now);
    }

    let metrics: FrameMetrics | null = null;
    if (s.landmarker && s.analyzer && video.readyState >= 2 && !video.paused && !video.ended) {
      const ts = performance.now();
      if (ts > s.lastTs) {
        s.lastTs = ts;
        const res = s.landmarker.detectForVideo(video, ts);
        const t = s.source === "upload" ? video.currentTime : now;
        metrics = s.analyzer.update(res.landmarks[0] ?? null, res.worldLandmarks[0] ?? null, t, s.phase === "round");
        const rect = contentRect(video);
        if (canvas.width !== video.clientWidth || canvas.height !== video.clientHeight) {
          canvas.width = video.clientWidth;
          canvas.height = video.clientHeight;
        }
        const ctx = canvas.getContext("2d");
        const mirror = s.source === "live" && settings.camera === "user" && settings.mirror;
        if (ctx) drawOverlay(ctx, metrics, canvas.width, canvas.height, rect, mirror);

        if (!metrics.landmarks || !metrics.fullBodyVisible) {
          if (s.notVisibleSince < 0) s.notVisibleSince = now;
          if (now - s.notVisibleSince > 2) {
            notice = metrics.landmarks ? "Step back — feet aren't in frame" : "No boxer detected";
          }
        } else s.notVisibleSince = -1;

        if (s.phase === "round" && settings.voice && pro && metrics.landmarks) {
          if (metrics.recentGuardRatio < 0.45 && metrics.secondsSinceLastPunch > 1.5) speak("Hands up.");
          else if (metrics.secondsSinceLastPunch > 10) speak("Stay busy. Throw the jab.");
        }
      }
    }
    if (s.source === "upload" && video.ended) return finish();

    if (now - s.lastUi > 0.1) {
      s.lastUi = now;
      const remaining =
        s.source === "upload"
          ? (video.duration || 0) - video.currentTime
          : s.phase === "paused"
            ? s.pausedRemaining
            : s.phaseEnds - now;
      setLive((l) => ({
        phase: s.phase,
        round: s.round,
        roundsTotal: s.roundsTotal,
        remainingS: remaining,
        metrics: metrics ?? l.metrics,
        notice,
      }));
    }
    s.raf = requestAnimationFrame(loop);
  }, [finish, pro, settings.camera, settings.mirror, settings.sound, settings.voice, startRound]);

  const begin = useCallback(
    async (src: "live" | "upload", file?: File) => {
      const s = S.current;
      setError(null);
      primeAudio();
      s.source = src;
      s.roundsTotal = src === "upload" ? 1 : rounds;
      s.roundLen = roundLen;
      s.rest = rest;
      s.finished = false;
      s.analyzer = new BoxingAnalyzer(profile.stance);
      s.startedAt = Date.now();
      s.phase = "loading";
      setLive({ phase: "loading", round: 0, roundsTotal: s.roundsTotal, remainingS: 0, metrics: null, notice: null });
      const video = videoRef.current!;
      try {
        if (src === "live") {
          s.stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: settings.camera, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
          video.srcObject = s.stream;
        } else {
          s.objectUrl = URL.createObjectURL(file!);
          video.srcObject = null;
          video.src = s.objectUrl;
        }
        await video.play();
        s.landmarker = await getPoseLandmarker();
        try {
          s.wakeLock = await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen") ?? null;
        } catch {
          /* wake lock is best-effort */
        }
        const now = performance.now() / 1000;
        if (src === "live") {
          s.phase = "countdown";
          s.phaseEnds = now + COUNTDOWN_S;
          if (settings.voice && pro) speak("Get ready.", 0);
        } else {
          s.round = 1;
          s.phase = "round";
          s.phaseEnds = now + (video.duration || 0);
          s.analyzer.setRound(1);
        }
        s.raf = requestAnimationFrame(loop);
      } catch (e) {
        teardown();
        s.phase = "setup";
        setLive((l) => ({ ...l, phase: "setup" }));
        const name = e instanceof Error ? e.name : "";
        setError(
          name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access in your browser settings and try again."
            : name === "NotFoundError"
              ? "No camera found on this device. Try uploading a video instead."
              : e instanceof Error
                ? `Couldn't start: ${e.message}`
                : "Couldn't load the pose model. Check your connection and try again."
        );
      }
    },
    [loop, pro, profile.stance, rest, roundLen, rounds, settings.camera, settings.voice, teardown]
  );

  const togglePause = () => {
    const s = S.current;
    const now = performance.now() / 1000;
    const video = videoRef.current;
    if (s.phase === "paused") {
      s.phase = s.prevPhase;
      s.phaseEnds = now + s.pausedRemaining;
      void video?.play();
    } else if (s.phase === "round" || s.phase === "rest" || s.phase === "countdown") {
      s.prevPhase = s.phase;
      s.pausedRemaining = s.phaseEnds - now;
      s.phase = "paused";
      if (s.source === "upload") video?.pause();
    }
  };

  const m = live.metrics;
  const inSession = live.phase !== "setup";
  const mirrorCss = source === "live" && settings.camera === "user" && settings.mirror;
  const speed = m ? Math.max(m.speedMph.left, m.speedMph.right) : 0;
  const guard = m ? (m.guardUp.left && m.guardUp.right ? "UP" : m.guardUp.left || m.guardUp.right ? "HALF" : "DOWN") : "—";

  return (
    <div className={`screen ${inSession ? "screen-live" : "with-nav"}`}>
      {!inSession && <TopBar title="Train" back="home" />}

      {!inSession && (
        <div className="setup">
          <h2>Drill</h2>
          <div className="chips">
            {DRILLS.map((d) => (
              <button
                key={d.id}
                className={`chip ${d.id === drillId ? "on" : ""} ${d.pro && !pro ? "chip-locked" : ""}`}
                onClick={() => pickDrill(d.id)}
              >
                {d.name}
                {d.pro && !pro && " 🔒"}
              </button>
            ))}
          </div>
          <p className="muted">{drill.description}</p>

          <div className="setup-grid">
            <div className="field">
              <span>Rounds {!pro && <button className="link" onClick={() => navigate("plans")}>Pro: unlimited</button>}</span>
              <div className="stepper">
                <button onClick={() => setRounds((r) => Math.max(1, r - 1))}>−</button>
                <span className="num">{rounds}</span>
                <button
                  onClick={() => (pro ? setRounds((r) => Math.min(12, r + 1)) : navigate("plans"))}
                >
                  +
                </button>
              </div>
            </div>
            <div className="field">
              <span>Round length</span>
              <div className="seg">
                {[60, 120, 180].map((v) => (
                  <button key={v} className={roundLen === v ? "on" : ""} onClick={() => setRoundLen(v)}>
                    {v / 60}m
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>Rest</span>
              <div className="seg">
                {[30, 45, 60].map((v) => (
                  <button key={v} className={rest === v ? "on" : ""} onClick={() => setRest(v)}>
                    {v}s
                  </button>
                ))}
              </div>
            </div>
          </div>

          {error && <p className="error">{error}</p>}

          <div className="start-buttons">
            <button className="btn btn-primary btn-lg" onClick={() => { setSource("live"); void begin("live"); }}>
              ● Start with camera
            </button>
            <label className="btn btn-ghost btn-lg">
              ▲ Analyze a video
              <input
                type="file"
                accept="video/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setSource("upload");
                    void begin("upload", f);
                  }
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <p className="muted small">
            Prop the phone up at waist height, 2–3 m away, full body in frame. The {settings.camera === "user" ? "front" : "back"} camera is
            selected — change it in Settings.
          </p>
        </div>
      )}

      <div className={`stage ${inSession ? "" : "hidden"}`}>
        <video ref={videoRef} playsInline muted style={{ transform: mirrorCss ? "scaleX(-1)" : undefined }} />
        <canvas ref={canvasRef} />

        <div className="hud-top">
          <div className="hud-round">
            {live.phase === "loading" && "LOADING COACH… (FIRST TIME ~15MB)"}
            {live.phase === "countdown" && "GET READY"}
            {live.phase === "round" && (source === "upload" ? "ANALYZING" : `ROUND ${live.round} / ${live.roundsTotal}`)}
            {live.phase === "rest" && `REST · NEXT: ROUND ${live.round + 1}`}
            {live.phase === "paused" && "PAUSED"}
            {live.phase === "finishing" && "SCORING…"}
          </div>
          <div className={`hud-timer num ${live.phase === "rest" ? "rest" : ""}`}>
            {live.phase === "countdown" ? Math.ceil(live.remainingS) : fmt(live.remainingS)}
          </div>
        </div>
        {live.notice && <div className="hud-notice">{live.notice}</div>}
        {live.phase === "round" && m?.lastCombo && m.secondsSinceLastPunch < 1.2 && (
          <div className="hud-combo num">{m.lastCombo}</div>
        )}
      </div>

      {inSession && (
        <>
          <div className="hud-cards">
            <div className="hud-card">
              <div className="hud-k">SPEED</div>
              <div className="hud-v num">{speed.toFixed(0)}<small>mph</small></div>
              <div className="hud-s">max {m ? m.maxSpeedMph.toFixed(0) : 0}</div>
            </div>
            <div className="hud-card">
              <div className="hud-k">PUNCHES</div>
              <div className="hud-v num">{m?.punchCount ?? 0}</div>
              <div className="hud-s">{m?.lastPunch ? PUNCH_LABEL[m.lastPunch.type] : "—"}</div>
            </div>
            <div className="hud-card">
              <div className="hud-k">GUARD</div>
              <div className={`hud-v num ${guard === "UP" ? "good" : guard === "DOWN" ? "bad" : "warn"}`}>{guard}</div>
              <div className="hud-s">
                L {m?.guardUp.left ? "↑" : "↓"} · R {m?.guardUp.right ? "↑" : "↓"}
              </div>
            </div>
            <div className="hud-card">
              <div className="hud-k">ELBOW</div>
              <div className="hud-v num">{m ? Math.round(Math.max(m.elbowAngle.left, m.elbowAngle.right)) : 0}°</div>
              <div className="hud-s">L {m ? Math.round(m.elbowAngle.left) : 0}° · R {m ? Math.round(m.elbowAngle.right) : 0}°</div>
            </div>
          </div>
          <div className="live-controls">
            {live.phase !== "loading" && live.phase !== "finishing" && (
              <button className="btn btn-ghost" onClick={togglePause}>
                {live.phase === "paused" ? "▶ Resume" : "❚❚ Pause"}
              </button>
            )}
            <button className="btn btn-primary" onClick={finish} disabled={live.phase === "loading" || live.phase === "finishing"}>
              ■ End &amp; score
            </button>
          </div>
        </>
      )}
    </div>
  );
}
