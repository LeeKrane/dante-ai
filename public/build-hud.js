// ---- Build HUD: "the groove" ----
//
// A build can run for five minutes and report nothing at all. The screen still
// has to look alive, and — more importantly — it must never imply progress it
// cannot know. Every honest-looking progress bar is a lie: nothing here knows
// how far along the build is, so nothing here is allowed to look like it does.
//
// The central mechanic is a spiral the build cuts for itself around the orb:
//
//     r(t) = gR0 + gA * (1 - e^(-t / TAU))
//
// It is asymptotic. It approaches the outer radius and never reaches it, so it
// cannot arrive, cannot close, and cannot desync from a build that finishes in
// forty seconds or runs for ten minutes. What DOES change is the spacing between
// turns, which collapses as the radial rate decays — second 20 and second 200
// look genuinely different without either one claiming anything.
//
// Colour is the whole honesty contract, and the legend states it on screen:
//   cyan  — ambient. Generated. Means nothing.
//   amber — a line the build actually reported.
//   white — the orchestrator, not the model: a boundary between two steps.
//   red   — the build failed.
//
// Silence is content, not absence: every two seconds without a reported line
// cuts a hatch into the record, and the hatches lengthen the longer the quiet
// runs. A build that reports nothing for four minutes draws four minutes of
// visible, accumulating quiet.
//
// The module owns nothing outside #build-hud. It starts a rAF loop on start(),
// and stop() cancels it and drops every listener, so repeated builds never
// accumulate loops.

import { stepPosition } from "./progress-policy.js";

const RECORD_CAP = 40000; // ~26 min of samples; a runaway build must not eat RAM

// Palette.
const CYAN = [79, 216, 255];
const AMBER = [255, 179, 92];
const WHITE = [224, 244, 255];
const FAULT = [255, 154, 138]; // matches the app's own error colour

// Groove shape.
const TAU = 180;            // radial time constant (s) — the asymptote, in seconds
const REV_BASE = 34;        // fastest revolution period (s)
const REV_MAX = REV_BASE * 4;
const SPACING_MIN = 5;      // px between turns; tighter than this reads as a painted disc
const STEP = 0.04;          // integration step (s) — fixed, so geometry is framerate-independent
const STEP_GUARD = 400;     // max catch-up steps per frame (a backgrounded tab returns with a huge dt)
const CLEAR = 18;           // px of vertical clearance between the orb and the innermost turn

// Reported-line behaviour.
const QUIET_STEP = 2;       // one silence hatch per 2s of quiet
const QUIET_FULL = 95;      // quiet (s) at which a hatch reaches full length
const SCAR_ARC = 130;       // px of arc a reported line bends the groove for
const SCAR_ARC_STEP = SCAR_ARC * 1.8; // a step boundary bends it for longer, so the record visibly sections

// Retirement.
const GRACE_MS = 800;       // how long an ended build has to report HOW it ended
const HOLD_MS = 5200;       // the finished record holds while the done-line is spoken
const FADE_MS = 900;

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const TWO_PI = Math.PI * 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mmss = (s) =>
  `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, "0")}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

// Text arriving here was written by the model running the build, so it is
// untrusted on its way to the screen. It only ever reaches canvas fillText or
// textContent (never HTML), and it is stripped and capped so a control character
// cannot forge a line and a 4KB path cannot run off the screen.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
function plain(text, max) {
  const clean = String(text ?? "").replace(UNPRINTABLE, "").trim();
  const chars = [...clean];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "\u2026" : clean;
}

// A reported filename is the tease for the reveal, so it is promoted out of the
// passing log and into a field that stays on screen for the rest of the build.
const WRITE_LINE = /^(?:Writing|Editing)\s+(.+)$/;

// Seeded value noise. The groove's texture is addressed by ARC LENGTH rather
// than by wall time, so the shape depends on how far the stylus has travelled
// and never on how often the screen refreshes: the record looks identical at
// 30fps and at 120fps.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seeded = mulberry32(0x5eed17);
const table = (n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = seeded(); return a; };
const T1 = table(2048), T2 = table(2048), T3 = table(2048);
function vnoise(t, x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const a = t[((i % 2048) + 2048) % 2048], b = t[(((i + 1) % 2048) + 2048) % 2048];
  return a + (b - a) * u;
}
const fbm = (x) => vnoise(T1, x) * 0.54 + vnoise(T2, x * 2.07 + 11.3) * 0.29 + vnoise(T3, x * 4.19 + 57.1) * 0.17;
const bipolar = (x) => fbm(x) * 2 - 1;

// A HUD that cannot render is better than a crash: every entry point becomes a
// no-op so app.js never needs a null check around it.
function inertHud() {
  const noop = () => {};
  return { start: noop, event: noop, step: noop, succeeded: noop, failed: noop, finish: noop, setChromeHidden: noop, isActive: () => false };
}

export function createBuildHud(options = {}) {
  const root = document.getElementById("build-hud");
  const recordCanvas = document.getElementById("bh-record");
  const liveCanvas = document.getElementById("bh-live");
  if (!root || !recordCanvas || !liveCanvas) return inertHud();

  const rec = recordCanvas.getContext("2d");
  const live = liveCanvas.getContext("2d");
  if (!rec || !live) return inertHud();

  const orbEl = options.orbEl || null;
  const layoutEls = (options.layoutEls || []).filter(Boolean);

  const el = {
    requestRow: document.getElementById("bh-request-row"),
    request: document.getElementById("bh-request"),
    detailRow: document.getElementById("bh-detail-row"),
    detail: document.getElementById("bh-detail"),
    stepRow: document.getElementById("bh-step-row"),
    step: document.getElementById("bh-step"),
    legStep: document.getElementById("bh-leg-step"),
    legMark: document.getElementById("bh-leg-mark"),
    fileRow: document.getElementById("bh-file-row"),
    file: document.getElementById("bh-file"),
    clock: document.getElementById("bh-clock"),
    completion: document.getElementById("bh-completion"),
    quietKey: document.getElementById("bh-quiet-key"),
    quiet: document.getElementById("bh-quiet"),
    stateText: document.getElementById("bh-state-text"),
    topLeft: document.getElementById("bh-tl"),
    topRight: document.getElementById("bh-tr"),
    bottomLeft: document.getElementById("bh-bl"),
  };

  // The readouts change at most once a second, so guarding the write keeps the
  // only per-frame DOM traffic down to nothing at all on most frames.
  function setText(node, value) {
    if (!node || node.__shown === value) return;
    node.__shown = value;
    node.textContent = value;
  }

  // ---- run state ----
  let phase = "gone";        // "cutting" | "settling" | "gone"
  let outcome = null;        // null | "ok" | "fail"
  let raf = 0;
  let observer = null;
  let motionQuery = null;
  let onMotionChange = null;
  let reduce = false;
  let chromeHidden = false;

  let startedAt = 0, endedAt = 0, lastFrame = 0, lastDraw = 0;
  let vt = 0;                // seconds since dispatch
  let cutVt = 0;             // integrator cursor
  let frozenVt = 0;          // clock value once the build ended
  let lastEventVt = -1;      // -1 until the build reports its first line
  let nextQuietVt = QUIET_STEP;
  let arcLen = 0, theta = 0;
  let prevPoint = null, prevBase = null;
  let calm = 1, carrierBurst = -1e9;
  let filePinned = false;

  const record = [];   // {rn, th, a, w, hot, tick}
  const scars = [];    // {rn, th, arc, span, tone}
  const labels = [];   // {rn, th, text, stamp, tone, born, side, slot}
  const shocks = [];   // {at, amp}
  const filaments = [];
  const particles = [];

  // ---- geometry ----
  let W = 0, H = 0, DPR = 1, cx = 0, cy = 0, span = 0;
  let keepR = 0, ky = 0.6, gR0 = 0, gA = 0, collarR = 0, collarMax = 0;
  let carrierY = 96, labelTop = 140, labelBottom = 400, labelGutter = 24, slotCount = 4;
  let filmCanvas = null, filmCtx = null;
  let spriteCyan = null, spriteAmber = null, spriteWhite = null;

  function sprite(size, colour) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const h = size / 2;
    const grad = g.createRadialGradient(h, h, 0, h, h, h);
    grad.addColorStop(0, rgba(colour, 1));
    grad.addColorStop(0.3, rgba(colour, 0.42));
    grad.addColorStop(0.62, rgba(colour, 0.1));
    grad.addColorStop(1, rgba(colour, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  function sizeCanvas(canvas, g) {
    canvas.width = Math.max(1, Math.round(W * DPR));
    canvas.height = Math.max(1, Math.round(H * DPR));
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // Everything is measured from the REAL orb element rather than assumed to sit
  // at the centre of the window: the orb is laid out above the caption, so the
  // viewport centre is not where it is.
  function measure() {
    W = Math.max(1, window.innerWidth);
    H = Math.max(1, window.innerHeight);
    DPR = Math.min(window.devicePixelRatio || 1, 2);

    const box = orbEl ? orbEl.getBoundingClientRect() : null;
    if (box && box.width > 0) {
      cx = box.left + box.width / 2;
      cy = box.top + box.height / 2;
      span = Math.min(box.width, box.height);
    } else {
      cx = W / 2; cy = H / 2; span = Math.min(W, H) * 0.72;
    }

    // HARD CONSTRAINT: the record never enters this circle. The orb's own canvas
    // draws a rim at 0.24 of its box and a ring stack out to ~0.389 of it, with
    // a bloom capped at 0.44. 0.435 sits outside the structure and inside the
    // last of the glow, and the check below is done in ellipse space so the
    // squashed top and bottom of the spiral clear it too.
    keepR = span * 0.435;
    collarR = keepR;
    collarMax = Math.max(10, span * 0.03);

    const topBlocks = Math.max(
      el.topLeft ? el.topLeft.getBoundingClientRect().bottom : 0,
      el.topRight ? el.topRight.getBoundingClientRect().bottom : 0,
    );
    carrierY = Math.max(84, topBlocks + 20);
    const legendTop = el.bottomLeft ? el.bottomLeft.getBoundingClientRect().top : H;

    // The record may run off the TOP of the viewport — there is no chrome up
    // there and a record that overflows reads as bigger than the viewport.
    // Downwards it is bounded, because the mic button lives at the bottom.
    const floorY = H - clamp(H * 0.14, 96, 170);
    const roomX = Math.max(80, Math.min(cx, W - cx) - 40);
    const roomY = Math.max(60, floorY - cy);

    ky = clamp(roomY / roomX, 0.45, 0.92);
    const rMax = Math.min(roomX, roomY / ky);
    gR0 = (keepR + CLEAR) / ky;          // provable clearance: the ellipse's own minimum
    gA = Math.max(rMax - gR0, 40);       // a floor, so a cramped window still cuts a record

    labelGutter = clamp(W * 0.02, 16, 34);
    labelTop = carrierY + 56;
    labelBottom = Math.min(legendTop, H - 120) - 24;
    slotCount = clamp(Math.floor((labelBottom - labelTop) / 42) + 1, 1, 5);

    sizeCanvas(recordCanvas, rec);
    sizeCanvas(liveCanvas, live);
    rec.lineCap = "round";
    rec.lineJoin = "round";

    buildFilaments();
    replayRecord();
    for (const label of labels) placeLabel(label, true);
  }

  // ---- ambient field ----
  // Filaments are rigid: they are baked once per resize and blitted with a single
  // drawImage per frame rather than re-stroked.
  const FILAMENTS = 30;
  const PARTICLES = 240;

  function buildFilaments() {
    filaments.length = 0;
    const rnd = mulberry32(0xa11ce);
    for (let i = 0; i < FILAMENTS; i++) {
      filaments.push({
        th0: (i / FILAMENTS) * TWO_PI + (rnd() - 0.5) * 0.16,
        sweep: (rnd() < 0.5 ? -1 : 1) * (0.35 + rnd() * 0.55),
        phase: rnd() * 100,
        wobble: 0.5 + rnd() * 1.4,
      });
    }
    if (particles.length === 0) {
      const p = mulberry32(0xbee5);
      for (let i = 0; i < PARTICLES; i++) {
        particles.push({ f: i % FILAMENTS, p: p(), speed: 0.055 + p() * 0.085, offset: (p() - 0.5) * 2, seed: p() * 1000, boost: 0 });
      }
    }
    drawFilaments();
  }

  // p: 0 = off screen, 1 = the keep-out boundary. Nothing in the flux ever gets
  // closer to the orb than the record does.
  function filamentPoint(f, p) {
    const outer = Math.max(W, H) * 0.66;
    const k = 1 - p;
    return { r: keepR + (outer - keepR) * k, th: f.th0 + f.sweep * Math.pow(k, 1.35) };
  }

  function drawFilaments() {
    if (!filmCanvas) { filmCanvas = document.createElement("canvas"); filmCtx = filmCanvas.getContext("2d"); }
    filmCanvas.width = Math.max(1, Math.round(W * DPR));
    filmCanvas.height = Math.max(1, Math.round(H * DPR));
    const g = filmCtx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    const grad = g.createRadialGradient(cx, cy, keepR, cx, cy, Math.max(W, H) * 0.66);
    grad.addColorStop(0, rgba(CYAN, 0.2));
    grad.addColorStop(0.3, rgba(CYAN, 0.1));
    grad.addColorStop(0.62, rgba(CYAN, 0.04));
    grad.addColorStop(1, rgba(CYAN, 0));
    g.strokeStyle = grad;
    g.lineWidth = 1;
    g.lineCap = "round";
    for (const f of filaments) {
      g.beginPath();
      for (let i = 0; i <= 40; i++) {
        const p = i / 40, q = filamentPoint(f, p);
        const th = q.th + (Math.sin(p * 6.2 + f.phase) * (1 - p) * 8 * f.wobble) / Math.max(q.r, 1);
        const x = cx + Math.cos(th) * q.r, y = cy + Math.sin(th) * q.r;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    }
  }

  // ---- the groove ----
  const point = (r, th) => ({ x: cx + Math.cos(th) * r, y: cy + Math.sin(th) * r * ky });

  function radialRate(seconds) {
    return (gA / TAU) * Math.exp(-seconds / TAU);
  }

  // The revolution period stretches as the stylus slows, so the gap between
  // turns never falls below SPACING_MIN. Without this a build past ~5 minutes
  // paints a featureless solid annulus — the exact "the screen is frozen" failure
  // this HUD exists to prevent. The cap keeps the stylus visibly moving.
  function revolutionFor(rate) {
    return clamp(SPACING_MIN / Math.max(rate, 1e-6), REV_BASE, REV_MAX);
  }

  function strokeSegment(a, b, colour, alpha, width) {
    rec.beginPath();
    rec.moveTo(a.x, a.y);
    rec.lineTo(b.x, b.y);
    rec.strokeStyle = rgba(colour, alpha);
    rec.lineWidth = width;
    rec.stroke();
  }

  function strokeHatch(sample) {
    const r = sample.rn * span;
    const inner = point(Math.max(gR0, r - sample.tick), sample.th);
    const outer = point(r + sample.tick, sample.th);
    rec.beginPath();
    rec.moveTo(inner.x, inner.y);
    rec.lineTo(outer.x, outer.y);
    rec.strokeStyle = rgba(AMBER, sample.hatchAlpha);
    rec.lineWidth = 1;
    rec.stroke();
  }

  function replayRecord() {
    rec.clearRect(0, 0, W, H);
    rec.lineCap = "round";
    rec.lineJoin = "round";
    let prev = null;
    for (const sample of record) {
      const p = point(sample.rn * span, sample.th);
      if (prev) strokeSegment(prev, p, sample.hot > 0.02 ? AMBER : CYAN, sample.a, sample.w);
      if (sample.tick > 0) strokeHatch(sample);
      prev = p;
    }
    prevPoint = prev;
  }

  function advance(seconds, activity) {
    const rate = radialRate(seconds);
    const revolution = revolutionFor(rate);
    theta += (STEP / revolution) * TWO_PI;

    const baseR = gR0 + gA * (1 - Math.exp(-seconds / TAU));
    const base = point(baseR, theta);
    if (prevBase) arcLen += Math.hypot(base.x - prevBase.x, base.y - prevBase.y);
    prevBase = base;

    // Texture, addressed by arc length rather than by time. Both terms are kept
    // deliberately low-frequency: detail finer than ~5px of arc on a 1px stroke
    // is the first thing any downscale or compression pass throws away, and it
    // would come back as grey mush next to the orb.
    const sig = bipolar(arcLen / 26) * 0.78 + bipolar(arcLen / 9 + 40) * 0.26;

    // How close the stylus is to a line the build actually reported.
    let hot = 0;
    for (const scar of scars) {
      const d = arcLen - scar.arc;
      // A step boundary carries its own, longer span: the deeper cut is what
      // makes the record read as three sections rather than one continuous take.
      if (d >= 0 && d < (scar.span ?? SCAR_ARC)) hot = Math.max(hot, Math.min(1, d / 6) * Math.exp(-d / 36));
    }

    const spacing = rate * revolution;
    const amp = clamp(spacing * 0.24, 2.5, 10);
    // The scar always bulges OUTWARD. An inward excursion at the innermost turn
    // would eat the clearance the whole keep-out argument rests on.
    const r = Math.max(gR0, baseR + sig * amp * (0.35 + 0.85 * activity) + hot * Math.min(gA * 0.4, 46));
    const alpha = clamp(0.2 + 0.44 * Math.abs(sig) * activity + hot * 0.85, 0.14, 1);
    const width = 1.25 + hot * 1.5;

    // Silence, measured. One hatch per QUIET_STEP of quiet, lengthening the
    // longer the quiet runs, so a build that reports nothing still draws a
    // record that is visibly accumulating something.
    let tick = 0, hatchAlpha = 0;
    if (seconds >= nextQuietVt) {
      nextQuietVt = seconds + QUIET_STEP;
      const quiet = seconds - Math.max(lastEventVt, 0);
      const grow = clamp(quiet / QUIET_FULL, 0, 1);
      tick = 4 + grow * 9;
      hatchAlpha = 0.14 + 0.42 * grow;
    }

    const sample = { rn: r / span, th: theta, a: alpha, w: width, hot, tick, hatchAlpha };
    record.push(sample);
    if (record.length > RECORD_CAP) record.shift();

    const p = point(r, theta);
    if (prevPoint) strokeSegment(prevPoint, p, hot > 0.02 ? AMBER : CYAN, alpha, width);
    if (tick > 0) strokeHatch(sample);
    prevPoint = p;
  }

  // ---- inscribed annotations ----
  // A reported line is anchored to the exact point on the record where it landed
  // and led out to a gutter, so the viewer can see WHERE in the build it
  // happened rather than reading a log detached from the picture.
  function placeLabel(label, keepSlot) {
    const p = point(label.rn * span, label.th);
    label.px = p.x;
    label.py = p.y;
    label.side = p.x > cx ? 1 : -1;
    label.gx = label.side > 0 ? W - labelGutter : labelGutter;

    if (!keepSlot || label.slot == null) {
      // A real per-side column: take the free slot nearest the anchor, and if the
      // column is full, evict the oldest label on that side. Two labels can never
      // land on the same line.
      const taken = new Set();
      for (const other of labels) if (other !== label && other.side === label.side && other.slot != null) taken.add(other.slot);
      let best = -1, bestDist = Infinity;
      for (let slot = 0; slot < slotCount; slot++) {
        if (taken.has(slot)) continue;
        const dist = Math.abs(slotY(slot) - p.y);
        if (dist < bestDist) { bestDist = dist; best = slot; }
      }
      if (best < 0) {
        const oldest = labels.find((other) => other !== label && other.side === label.side);
        best = oldest ? oldest.slot : 0;
        if (oldest) labels.splice(labels.indexOf(oldest), 1);
      }
      label.slot = best;
    }
    label.ey = slotY(label.slot);
  }

  function slotY(slot) {
    if (slotCount <= 1) return labelTop;
    return labelTop + ((labelBottom - labelTop) * slot) / (slotCount - 1);
  }

  // `tone` is the register the label speaks in: "line" is the model reporting
  // what it did, "step" is the orchestrator saying where the build has got to.
  // They are different claims, so they are different colours.
  function addLabel(text, stamp, tone = "line") {
    const r = (gR0 + gA * (1 - Math.exp(-vt / TAU))) + Math.min(gA * 0.4, 46);
    const label = { rn: r / span, th: theta, text, stamp, tone, born: performance.now(), slot: null };
    placeLabel(label, false);
    labels.push(label);
  }

  // A dark halo per glyph. A scrim cannot protect a character that happens to sit
  // over a bright turn of the record; this can, so the text stays legible wherever
  // on the record it lands.
  function haloText(g, text, x, y) {
    g.save();
    g.shadowColor = "rgba(3,8,14,.95)";
    g.shadowBlur = 14;
    g.fillText(text, x, y);
    g.shadowBlur = 4;
    g.fillText(text, x, y);
    g.restore();
  }

  function drawLabels(now) {
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      const age = (now - label.born) / 1000;
      const lead = reduce ? 1 : clamp(1 - Math.pow(2, -age / 0.15), 0, 1);
      const fade = clamp(age / 0.25, 0, 1);
      // Older entries dim so the newest line is always the one being read.
      const rank = labels.length - 1 - i;
      const dim = rank === 0 ? 1 : rank === 1 ? 0.72 : 0.45;
      // A failed build recolours everything: whatever a label said, the run it
      // belongs to did not finish, and the record must not read as if it did.
      const colour = outcome === "fail" ? FAULT : label.tone === "step" ? WHITE : AMBER;

      live.strokeStyle = rgba(colour, 0.4 * fade * dim);
      live.lineWidth = 1;
      live.beginPath();
      live.moveTo(label.px, label.py);
      live.lineTo(label.gx - label.side * 26, label.ey);
      live.stroke();

      live.strokeStyle = rgba(colour, 0.55 * fade * dim);
      live.beginPath();
      live.moveTo(label.gx - label.side * 26, label.ey);
      live.lineTo(label.gx - label.side * 26 + label.side * 26 * lead, label.ey);
      live.stroke();

      if (lead < 0.985) continue;

      live.strokeStyle = rgba(colour, 0.92 * dim);
      live.lineWidth = 1.6;
      live.beginPath();
      live.moveTo(label.gx, label.ey - 4.5);
      live.lineTo(label.gx, label.ey + 4.5);
      live.stroke();

      const shown = reduce ? label.text.length : Math.floor((age - 0.34) / 0.017);
      const n = Math.min(label.text.length, shown);
      if (n <= 0) continue;
      live.textAlign = label.side > 0 ? "right" : "left";
      try { live.letterSpacing = "0.1em"; } catch { /* older engines ignore this */ }
      live.font = `600 13px ${MONO}`;
      live.fillStyle = `rgba(238,248,255,${0.97 * dim})`;
      haloText(live, label.text.slice(0, n), label.gx - label.side * 9, label.ey - 9);
      if (n >= label.text.length) {
        live.font = `600 11.5px ${MONO}`;
        live.fillStyle = `rgba(126,163,181,${0.9 * dim})`;
        haloText(live, label.stamp, label.gx - label.side * 9, label.ey + 17);
      }
      try { live.letterSpacing = "0px"; } catch { /* older engines ignore this */ }
    }
    live.textAlign = "left";
  }

  // ---- readouts ----
  function accentColour() {
    if (outcome === "fail") return "var(--bh-fault)";
    if (outcome === "ok") return "var(--cyan)";
    return "var(--bh-amber)";
  }

  function paintState(text) {
    setText(el.stateText, text);
    if (el.clock) el.clock.style.color = accentColour();
    const dot = root.querySelector(".bh-dot");
    if (dot) dot.style.background = accentColour();
  }

  function updateReadouts() {
    const shown = phase === "cutting" ? vt : frozenVt;
    setText(el.clock, mmss(shown));
    if (phase === "cutting") {
      // With zero reported lines these two numbers are identical, which reads as
      // a bug unless the key says why. So the key says why.
      setText(el.quietKey, lastEventVt < 0 ? "quiet since dispatch" : "quiet since last line");
      setText(el.quiet, mmss(shown - Math.max(lastEventVt, 0)));
    }
  }

  function pinFile(name) {
    const clean = plain(name, 34);
    if (!clean) return;
    setText(el.file, clean);
    el.fileRow?.classList.remove("hidden");
  }

  function noteFileFrom(text) {
    const match = WRITE_LINE.exec(text);
    if (!match) return;
    const name = match[1].trim();
    if (!/\.[a-z0-9]{1,8}$/i.test(name)) return; // not a filename
    const isPage = /\.html?$/i.test(name);
    if (filePinned && !isPage) return;           // the page outranks later scratch files
    filePinned = filePinned || isPage;
    pinFile(name);
  }

  // ---- frame ----
  function frame(now) {
    raf = requestAnimationFrame(frame);

    const dt = Math.min(0.05, (now - lastFrame) / 1000) || 0;
    lastFrame = now;

    if (phase === "cutting") vt = (now - startedAt) / 1000;
    updateReadouts();

    if (phase === "settling") {
      const since = now - endedAt;
      // The build stops "working" a beat BEFORE its outcome is sent (the server
      // speaks the done-line first), so the ending is left blank for a moment
      // rather than flashing "unreported" and then correcting itself.
      if (!outcome && since > GRACE_MS) {
        setText(el.completion, "unreported");
        paintState("ended");
      }
      if (since > HOLD_MS) {
        const k = Math.min(1, (since - HOLD_MS) / FADE_MS);
        root.style.opacity = String(1 - k);
        if (k >= 1) { stop(); return; }
      }
    }

    // Hidden with the rest of the interface (the "h" key), or a reduced-motion
    // viewer: in both cases the state above keeps stepping forward, only the
    // painting stops.
    if (chromeHidden) return;
    const throttle = reduce ? 820 : 0;
    if (throttle && now - lastDraw < throttle) return;
    lastDraw = now;

    // Cut the record first, so a line arriving this frame is anchored to exactly
    // where the stylus is standing.
    if (phase === "cutting") {
      let guard = 0;
      while (cutVt < vt && guard++ < STEP_GUARD) {
        cutVt = Math.min(vt, cutVt + STEP);
        advance(cutVt, activityAt(now));
      }
      if (guard >= STEP_GUARD) cutVt = vt; // a backgrounded tab came back; skip ahead rather than stall
    }

    if (phase !== "cutting") calm += (0.34 - calm) * (reduce ? 0.5 : 0.02);
    const activity = activityAt(now);

    live.clearRect(0, 0, W, H);
    live.drawImage(filmCanvas, 0, 0, W, H);

    drawCollar(now, activity);
    const fronts = drawShocks(now);
    if (!reduce) drawFlux(dt, activity, fronts);
    drawScarRelight();
    drawStylus();
    drawCarrier(now, activity);
    drawLabels(now);
  }

  function activityAt(now) {
    return (0.4 + 0.6 * fbm((now / 1000) * 0.33 + 3.1)) * calm;
  }

  // A fine bristle collar hugging the keep-out boundary: the constant, meaningless
  // "something is being consumed right now" layer. Batched into four alpha
  // buckets so 180 hairlines cost four stroke calls.
  const buckets = [[], [], [], []];
  const bucketAlpha = [0.13, 0.28, 0.48, 0.8];
  function drawCollar(now, activity) {
    const t = now / 1000;
    const count = reduce ? 120 : 180;
    // Reduced motion steps the collar by one whole tick per second rather than
    // re-randomising it, which would strobe.
    const spin = reduce ? Math.floor(t) * (TWO_PI / count) : t * 0.031;
    const phaseT = reduce ? Math.floor(t) : t;
    for (let b = 0; b < 4; b++) buckets[b].length = 0;
    for (let i = 0; i < count; i++) {
      const th = (i / count) * TWO_PI + spin;
      let s = vnoise(T2, i * 0.34 + phaseT * 0.55) * 0.62 + vnoise(T3, i * 0.93 - phaseT * 0.31) * 0.38;
      s = Math.pow(clamp(s, 0, 1), 1.7) * activity;
      const len = 1.5 + collarMax * s;
      const c = Math.cos(th), sn = Math.sin(th);
      buckets[Math.min(3, (s * 4) | 0)].push(cx + c * collarR, cy + sn * collarR, cx + c * (collarR + len), cy + sn * (collarR + len));
    }
    live.lineWidth = 1;
    for (let b = 0; b < 4; b++) {
      const arr = buckets[b];
      if (!arr.length) continue;
      live.beginPath();
      for (let i = 0; i < arr.length; i += 4) { live.moveTo(arr[i], arr[i + 1]); live.lineTo(arr[i + 2], arr[i + 3]); }
      live.strokeStyle = rgba(CYAN, bucketAlpha[b]);
      live.stroke();
    }
  }

  function drawShocks(now) {
    const fronts = [];
    const maxR = Math.max(W, H) * 0.62;
    for (let i = shocks.length - 1; i >= 0; i--) {
      const s = shocks[i];
      const age = (now - s.at) / 1000;
      if (age < 0) continue;
      if (age > 1.9) { shocks.splice(i, 1); continue; }
      const r = keepR + (maxR - keepR) * (1 - Math.pow(2, -age / 0.3));
      fronts.push(r);
      live.beginPath();
      live.arc(cx, cy, r, 0, TWO_PI);
      live.strokeStyle = rgba(outcome === "fail" ? FAULT : AMBER, s.amp * Math.pow(1 - age / 1.9, 2.2) * 0.5);
      live.lineWidth = 1.4;
      live.stroke();
    }
    return fronts;
  }

  function drawFlux(dt, activity, fronts) {
    live.globalCompositeOperation = "lighter";
    for (const p of particles) {
      const f = filaments[p.f];
      if (!f) continue;
      // Real dt, not a hardcoded 1/60: on a 120Hz display the old form ran at half
      // speed and stalled on every dropped frame.
      p.p += p.speed * dt * (0.3 + 1.75 * Math.pow(p.p, 1.55)) * (0.55 + 0.85 * activity);
      if (p.p >= 1) { p.p = 0; p.f = (p.f + 3 + ((p.seed * 7) | 0)) % FILAMENTS; p.boost = 0; }
      const q = filamentPoint(f, p.p);
      const wobble =
        Math.sin(p.p * 6.2 + f.phase) * (1 - p.p) * 8 * f.wobble +
        p.offset * (1 - p.p) * 11 +
        bipolar(p.seed + (lastFrame / 1000) * 0.9 + p.p * 3) * (1 - p.p) * 9;
      const th = q.th + wobble / Math.max(q.r, 1);
      const x = cx + Math.cos(th) * q.r, y = cy + Math.sin(th) * q.r;
      for (let i = 0; i < fronts.length; i++) if (Math.abs(q.r - fronts[i]) < 46) p.boost = 1;
      p.boost *= 0.955;
      const edge = p.p < 0.06 ? p.p / 0.06 : p.p > 0.955 ? (1 - p.p) / 0.045 : 1;
      const alpha = (0.2 + 0.62 * p.p) * edge * (0.55 + 0.6 * activity) + p.boost * 0.6;
      if (alpha <= 0.01) continue;
      const size = (4.5 + 10 * (1 - p.p)) * (1 + p.boost * 0.7);
      live.globalAlpha = Math.min(alpha, 1);
      live.drawImage(p.boost > 0.25 ? spriteAmber : p.p > 0.86 ? spriteWhite : spriteCyan, x - size / 2, y - size / 2, size, size);
    }
    live.globalAlpha = 1;
    live.globalCompositeOperation = "source-over";
  }

  // Past events are re-lit as the stylus comes back round to their bearing, so
  // the record reads as an accumulating history rather than a decaying one.
  function drawScarRelight() {
    if (!scars.length) return;
    for (const scar of scars) {
      let delta = (theta - scar.th) % TWO_PI;
      if (delta < 0) delta += TWO_PI;
      const glow = Math.exp(-delta / 0.3) * 0.55;
      if (glow < 0.02) continue;
      const p = point(scar.rn * span, scar.th);
      live.beginPath();
      live.arc(p.x, p.y, 2.2, 0, TWO_PI);
      // Relit in the colour it was cut in, so a boundary reads as a boundary on
      // the way past as well as when it happened.
      live.fillStyle = rgba(
        outcome === "fail" ? FAULT : scar.tone === "step" ? WHITE : AMBER,
        0.35 + glow,
      );
      live.fill();
    }
  }

  function drawStylus() {
    if (!prevPoint || record.length === 0) return;
    if (phase === "cutting") {
      const n = Math.min(record.length, 90);
      if (n > 3) {
        live.beginPath();
        for (let i = record.length - n; i < record.length; i++) {
          const s = record[i], p = point(s.rn * span, s.th);
          if (i === record.length - n) live.moveTo(p.x, p.y); else live.lineTo(p.x, p.y);
        }
        live.strokeStyle = "rgba(210,244,255,.5)";
        live.lineWidth = 1.2;
        live.stroke();
      }
      live.globalCompositeOperation = "lighter";
      live.drawImage(spriteWhite, prevPoint.x - 11, prevPoint.y - 11, 22, 22);
      live.globalCompositeOperation = "source-over";
      live.beginPath();
      live.arc(prevPoint.x, prevPoint.y, 1.7, 0, TWO_PI);
      live.fillStyle = "rgba(242,251,255,.95)";
      live.fill();
      return;
    }

    // The build ended. The stylus lifts, and the record is terminated with a mark
    // that says which way it ended — a failure must never render as a completion.
    if (outcome === "fail") {
      const r = prevPoint;
      const inner = point(Math.max(gR0, span * record[record.length - 1].rn - 26), theta);
      const outer = point(span * record[record.length - 1].rn + 26, theta);
      live.strokeStyle = rgba(FAULT, 0.95);
      live.lineWidth = 2.4;
      live.beginPath();
      live.moveTo(inner.x, inner.y);
      live.lineTo(outer.x, outer.y);
      live.stroke();
      live.beginPath();
      live.arc(r.x, r.y, 5, 0, TWO_PI);
      live.strokeStyle = rgba(FAULT, 0.9);
      live.lineWidth = 1.4;
      live.stroke();
      return;
    }
    live.beginPath();
    live.arc(prevPoint.x, prevPoint.y, 3.4, 0, TWO_PI);
    live.strokeStyle = rgba(outcome === "ok" ? CYAN : WHITE, 0.85);
    live.lineWidth = 1.3;
    live.stroke();
  }

  // The rule across the top of the viewport is a live signal trace rather than a
  // dead hairline, and it flashes on a line the build actually reported.
  function drawCarrier(now, activity) {
    const t = now / 1000;
    const since = t - carrierBurst;
    const amp = (2.6 + 5.2 * activity) * (reduce ? 0.6 : 1);
    live.beginPath();
    live.moveTo(0, carrierY);
    live.lineTo(W, carrierY);
    live.strokeStyle = "rgba(120,200,230,.10)";
    live.lineWidth = 1;
    live.stroke();

    live.beginPath();
    const front = since * 940;
    for (let x = 0; x <= W; x += 6) {
      let a = amp, peak = 0;
      if (since >= 0 && since < 2.4 && !reduce) {
        const d = Math.abs(Math.abs(x - cx) - front);
        peak = Math.exp(-(d * d) / 15488) * Math.max(0, 1 - since / 2.4);
        a *= 1 + 7.5 * peak;
      }
      // Reduced motion drops the time term entirely: the trace is a fixed shape,
      // so it steps with the rest of the HUD instead of re-randomising into noise.
      const drift = reduce ? 0 : t;
      const v = bipolar(x * 0.01 - drift * 1.35) * 0.82 + bipolar(x * 0.031 + drift * 2.6) * 0.26 + (peak > 0.02 ? bipolar(x * 0.31 + t * 30) * peak * 0.9 : 0);
      const y = carrierY + v * a;
      if (x) live.lineTo(x, y); else live.moveTo(x, y);
    }
    const hot = since >= 0 && since < (reduce ? 1.2 : 1.4);
    live.strokeStyle = hot ? rgba(outcome === "fail" ? FAULT : AMBER, 0.75) : rgba(CYAN, 0.46);
    live.lineWidth = 1.2;
    live.stroke();
  }

  // ---- lifecycle ----
  function applyReduce(value) {
    reduce = !!value;
    root.classList.toggle("bh-reduced", reduce);
  }

  function start(request = {}) {
    if (phase !== "gone") stop();

    root.classList.remove("hidden");
    root.style.opacity = "1";
    document.body.classList.add("build-hud-live");

    phase = "cutting";
    outcome = null;
    startedAt = performance.now();
    lastFrame = startedAt;
    lastDraw = 0;
    endedAt = 0;
    vt = 0; cutVt = 0; frozenVt = 0;
    lastEventVt = -1;
    nextQuietVt = QUIET_STEP;
    arcLen = 0; theta = -Math.PI / 2;
    prevPoint = null; prevBase = null;
    calm = 1; carrierBurst = -1e9;
    filePinned = false;
    record.length = 0; scars.length = 0; labels.length = 0; shocks.length = 0;
    for (const p of particles) p.boost = 0;

    // The build request is only shown when it is actually known. Nothing here
    // invents a subject the person did not say.
    const asked = plain(request.request, 52);
    const detail = plain(request.detail, 52);
    setText(el.request, asked);
    el.requestRow?.classList.toggle("hidden", !asked);
    setText(el.detail, detail);
    el.detailRow?.classList.toggle("hidden", !detail);
    el.fileRow?.classList.add("hidden");
    // A chain that ran last time must not leave its last step on screen while a
    // single-shot build runs, which would name a step this build does not have.
    el.stepRow?.classList.add("hidden");
    el.legMark?.classList.add("hidden");
    el.legStep?.classList.add("hidden");
    setText(el.completion, "unmeasured");
    paintState("building");
    setText(el.quietKey, "quiet since dispatch");
    setText(el.quiet, "00:00");
    setText(el.clock, "00:00");

    motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    applyReduce(motionQuery.matches);
    onMotionChange = (e) => applyReduce(e.matches);
    motionQuery.addEventListener("change", onMotionChange);

    if (!spriteCyan) { spriteCyan = sprite(28, CYAN); spriteAmber = sprite(28, AMBER); spriteWhite = sprite(28, WHITE); }

    measure();

    // The orb moves whenever the caption below it wraps to another line, so both
    // are watched rather than just the window.
    observer = new ResizeObserver(measure);
    for (const node of layoutEls) observer.observe(node);
    window.addEventListener("resize", measure);

    raf = requestAnimationFrame(frame);
  }

  // Shared by both kinds of mark: a reported line and a step boundary are both
  // activity, and the quiet counter must not keep climbing through either.
  function cut(depth, amp, tone = "line") {
    lastEventVt = vt;
    nextQuietVt = vt + QUIET_STEP;
    carrierBurst = performance.now() / 1000;
    const now = performance.now();
    shocks.push({ at: now, amp }, { at: now + 130, amp: amp * 0.55 });
    const r = (gR0 + gA * (1 - Math.exp(-vt / TAU))) + Math.min(gA * 0.4, 46);
    scars.push({ arc: arcLen, th: theta, rn: r / span, span: depth, tone });
  }

  // `stepName` is which step reported this line, and is only ever stamped under
  // the label — a build with no steps passes nothing and the stamp is what it
  // has always been.
  function event(line, stepName) {
    if (phase !== "cutting") return;
    const text = plain(line, 44);
    if (!text) return;
    cut(SCAR_ARC, 1);
    const from = plain(stepName, 24);
    addLabel(text, from ? `+${mmss(vt)} \u00b7 ${from}` : `+${mmss(vt)}`);
    noteFileFrom(text);
  }

  // The orchestrator reaching a new step. Not model chatter: nothing about it
  // came from the build session, which is why it is white rather than amber and
  // why the stamp names the position instead of the clock.
  function step(info) {
    if (phase !== "cutting") return;
    const name = plain(info?.step, 28);
    if (!name) return;
    cut(SCAR_ARC_STEP, 1.5, "step");
    const position = stepPosition(info);
    addLabel(name, position ? `step ${position}` : "step", "step");
    setText(el.step, position ? `${name} \u00b7 ${position}` : name);
    el.stepRow?.classList.remove("hidden");
    // The legend is the honesty contract, so the white entry appears exactly
    // when there is something white on screen to explain, and not before.
    el.legMark?.classList.remove("hidden");
    el.legStep?.classList.remove("hidden");
  }

  function settle() {
    if (phase !== "cutting") return;
    phase = "settling";
    frozenVt = vt;
    endedAt = performance.now();
    carrierBurst = endedAt / 1000;
    shocks.push({ at: endedAt, amp: 1.3 }, { at: endedAt + 150, amp: 0.7 }, { at: endedAt + 320, amp: 0.4 });
  }

  function succeeded(url) {
    if (phase === "gone") return;
    outcome = "ok";
    setText(el.completion, "reported done");
    paintState("complete");
    // The artifact URL is authoritative about the filename, which the reported
    // lines only guessed at.
    try {
      const name = new URL(String(url), location.href).pathname.split("/").pop();
      if (name) pinFile(decodeURIComponent(name));
    } catch { /* an unusable url just leaves the reported name in place */ }
    settle();
  }

  function failed() {
    if (phase === "gone") return;
    outcome = "fail";
    setText(el.completion, "did not finish");
    paintState("failed");
    settle();
  }

  // The build stopped working. How it ended may still be in flight — see the
  // grace window in frame().
  function finish() {
    settle();
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    phase = "gone";
    outcome = null;
    if (observer) { observer.disconnect(); observer = null; }
    window.removeEventListener("resize", measure);
    if (motionQuery && onMotionChange) motionQuery.removeEventListener("change", onMotionChange);
    motionQuery = null; onMotionChange = null;
    record.length = 0; scars.length = 0; labels.length = 0; shocks.length = 0;
    prevPoint = null; prevBase = null;
    rec.clearRect(0, 0, W, H);
    live.clearRect(0, 0, W, H);
    root.classList.add("hidden");
    root.style.opacity = "1";
    document.body.classList.remove("build-hud-live");
  }

  return {
    start,
    event,
    step,
    succeeded,
    failed,
    finish,
    setChromeHidden(hidden) { chromeHidden = !!hidden; },
    isActive() { return phase !== "gone"; },
  };
}
