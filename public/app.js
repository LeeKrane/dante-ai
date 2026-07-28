import { isFatalSpeechError } from "./stt-policy.js";
import { getVisibilityToggle } from "./visibility-policy.js";

// ---- DOM ----
const statusEl = document.getElementById("status");
const capEl = document.getElementById("caption");
const micBtn = document.getElementById("mic");
const canvas = document.getElementById("orb");
const ctx = canvas.getContext("2d");
const dbgEl = document.getElementById("dbg");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const dbgLines = [];
function dbg(message) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  dbgLines.push(`${time}  ${message}`);
  if (dbgLines.length > 16) dbgLines.shift();
  if (dbgEl) dbgEl.textContent = dbgLines.join("\n");
  console.log(`[jarvis] ${message}`);
}

// ---- State ----
let state = "idle"; // idle | listening | thinking | speaking
let level = 0;      // 0..1 smoothed amplitude driving the orb
let listening = false;
function setState(nextState) {
  state = nextState;
  statusEl.textContent = nextState;
  dbg(`state → ${nextState}`);
}
function setCaption(text, who) { capEl.textContent = text; capEl.dataset.who = who || ""; }

function toggleVisibility(target) {
  if (target === "caption") capEl.classList.toggle("hidden");
  else if (target === "interface") document.body.classList.toggle("interface-hidden");
  else if (target === "diagnostics" && dbgEl) dbgEl.classList.toggle("hidden");
}

// ---- Audio (hoisted so the orb loop can read the live analyser) ----
let audioCtx;
let analyser = null;
let freqBins = null;
let timeBins = null;

// ---- WebSocket ----
const ws = new WebSocket(`ws://${location.host}`);
ws.onopen = () => dbg("ws: connected");
ws.onclose = () => {
  dbg("ws: closed");
  setCaption("connection closed — restart the server and refresh", "error");
};
ws.onerror = () => dbg("ws: error");
ws.onmessage = async (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.type === "state") setState(msg.value);
  else if (msg.type === "reply_text") {
    setCaption(msg.text, "jarvis");
    dbg(`reply: ${msg.text}`);
  }
  else if (msg.type === "debug") {
    const timing = msg.ms ? ` (${msg.ms}ms)` : "";
    dbg(`srv ${msg.stage || ""}: ${msg.msg || ""}${timing}`);
  }
  else if (msg.type === "error") {
    setCaption("⚠ " + msg.message, "error");
    dbg(`srv ERROR: ${msg.message}`);
    level = 0;
    setState("idle");
  }
  else if (msg.type === "audio") {
    dbg(`audio: ~${Math.round((msg.data.length * 3) / 4 / 1024)}kb received`);
    try {
      await playAudio(msg.data);
    } catch (e) {
      setCaption("⚠ audio: " + (e.message || e), "error");
      dbg(`audio decode failed: ${e.message || e}`);
      level = 0;
      setState("idle");
    }
  }
};

// ---- Speech-to-text (Chrome Web Speech API, free) ----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let holding = false;   // physical button/Space held — this drives the green
let finalText = "";

if (SR) {
  rec = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.onstart = () => dbg("stt: started");
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript + " ";
      else interim += r[0].transcript;
    }
    const shown = (finalText + interim).trim();
    if (shown) {
      setCaption(shown, "you");
      dbg(`stt heard: "${shown}"`);
    }
  };
  rec.onerror = (e) => {
    const error = (e && e.error) || "unknown";
    dbg(`stt error: ${error}`);
    if (isFatalSpeechError(error)) {
      holding = false;
      listening = false;
      micBtn.classList.remove("pressed");
      setCaption("microphone blocked — allow it in the browser's site settings", "error");
      setState("idle");
    }
  };
  rec.onend = () => {
    listening = false;
    if (holding) {
      try {
        rec.start();
        listening = true;
        dbg("stt: auto-resumed (still holding)");
      } catch (error) {
        dbg(`stt resume deferred: ${error.message}`);
      }
      return;
    }
    const text = finalText.trim();
    finalText = "";
    if (text) {
      dbg(`release → sending "${text}"`);
      setState("thinking");
      ws.send(JSON.stringify({ type: "say", text }));
    } else {
      dbg("release → nothing captured");
      setCaption("No transcript captured — hold the button while speaking. Speech recognition works best in Google Chrome.", "error");
      if (state === "listening") setState("idle");
    }
  };
} else {
  setCaption("This browser has no speech recognition — open the app in Google Chrome.", "error");
  dbg("no Web Speech API in this browser");
}

function startListening() {
  if (!rec || holding || state === "thinking" || state === "speaking") return;
  holding = true;
  finalText = "";
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  setState("listening");
  try {
    rec.start();
    listening = true;
  } catch (error) {
    dbg(`stt start deferred: ${error.message}`);
  }
  dbg("hold → listening");
}
function stopListening() {
  micBtn.classList.remove("pressed");
  if (!holding) return;
  holding = false;
  try { rec.stop(); } catch {}
}

// Press on the button; release ANYWHERE (window) so a tiny drag off the button
// doesn't cancel, and there's no pointer-capture lag on release.
micBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); micBtn.classList.add("pressed"); startListening(); });
window.addEventListener("pointerup", stopListening);
window.addEventListener("pointercancel", stopListening);
// Spacebar push-to-talk.
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && !holding) {
    e.preventDefault();
    micBtn.classList.add("pressed");
    startListening();
  } else if (!e.repeat) {
    toggleVisibility(getVisibilityToggle(e.key, holding));
  }
});
window.addEventListener("keyup", (e) => { if (e.code === "Space") { e.preventDefault(); stopListening(); } });

// ---- Playback (analyser drives the reactive orb) ----
async function playAudio(b64) {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const buf = await audioCtx.decodeAudioData(bytes.buffer);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const an = audioCtx.createAnalyser();
  an.fftSize = 512;
  an.smoothingTimeConstant = 0.78;
  src.connect(an); an.connect(audioCtx.destination);
  analyser = an;
  freqBins = new Uint8Array(an.frequencyBinCount);
  timeBins = new Uint8Array(an.fftSize);
  setState("speaking");
  dbg(`playing ${buf.duration.toFixed(1)}s`);
  src.onended = () => {
    analyser = null;
    level = 0;
    dbg("playback ended");
    setState("idle");
  };
  src.start();
}

// ---- Orb ----
const PALETTE = {
  idle:      { hue: 192, sat: 90, glow: 0.30 },
  listening: { hue: 158, sat: 92, glow: 0.50 },
  thinking:  { hue: 38,  sat: 96, glow: 0.55 },
  speaking:  { hue: 196, sat: 96, glow: 0.70 },
};
const PARTICLES = Array.from({ length: reduceMotion ? 0 : 90 }, (_, i) => ({
  a: (i / 90) * Math.PI * 2,
  r: 0.6 + ((i * 97) % 100) / 100 * 0.55,   // deterministic spread, no Math.random at init
  spd: 0.1 + ((i * 53) % 100) / 100 * 0.5,
  sz: 0.6 + ((i * 31) % 100) / 100 * 1.5,
}));

let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
new ResizeObserver(resize).observe(canvas);
resize();

const hsla = (h, s, l, a) => `hsla(${h}, ${s}%, ${l}%, ${a})`;

let smooth = 0;
function drawOrb(now) {
  const t = now / 1000;
  const p = PALETTE[state] || PALETTE.idle;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) * 0.24;

  // Target amplitude per state, smoothed for a living feel.
  let target;
  if (state === "speaking" && analyser) {
    analyser.getByteTimeDomainData(timeBins);
    let sum = 0;
    for (let i = 0; i < timeBins.length; i++) { const v = (timeBins[i] - 128) / 128; sum += v * v; }
    target = Math.min(1, Math.sqrt(sum / timeBins.length) * 3.4);
    analyser.getByteFrequencyData(freqBins);
  } else if (state === "thinking") target = 0.34 + Math.sin(t * 3) * 0.12;
  else if (state === "listening") target = 0.30 + Math.sin(t * 5) * 0.14;
  else target = 0.12 + Math.sin(t * 1.2) * 0.05; // idle breathing
  smooth += (target - smooth) * 0.18;
  level = smooth;

  // Fully transparent except the orb, so the page's own radial background
  // shows through seamlessly (no canvas-rectangle halo).
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // Outer bloom. Capped to fade fully inside the canvas so its rectangle
  // never clips into a visible square halo.
  const bloomR = Math.min(Math.min(W, H) * 0.44, R * (2.2 + level));
  const bloom = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, bloomR);
  bloom.addColorStop(0, hsla(p.hue, p.sat, 58, p.glow * (0.5 + level * 0.6)));
  bloom.addColorStop(1, hsla(p.hue, p.sat, 50, 0));
  ctx.fillStyle = bloom;
  ctx.beginPath(); ctx.arc(cx, cy, bloomR, 0, Math.PI * 2); ctx.fill();

  const spin = reduceMotion ? 0 : t * (state === "thinking" ? 0.9 : 0.25);

  // Reactive spectrum ring while speaking; procedural rings otherwise.
  if (state === "speaking" && freqBins) {
    const N = 72;
    for (let i = 0; i < N; i++) {
      const mag = freqBins[2 + Math.floor((i / N) * 60)] / 255;
      const len = R * (0.16 + mag * 0.95);
      const ang = spin + (i / N) * Math.PI * 2;
      const inner = R * 1.06;
      ctx.strokeStyle = hsla(p.hue, p.sat, 62, 0.35 + mag * 0.5);
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * inner, cy + Math.sin(ang) * inner);
      ctx.lineTo(cx + Math.cos(ang) * (inner + len), cy + Math.sin(ang) * (inner + len));
      ctx.stroke();
    }
  } else {
    const arcs = state === "thinking" ? 3 : 2;
    for (let k = 0; k < arcs; k++) {
      const rr = R * (1.14 + k * 0.16) + Math.sin(t * 2 + k) * 3;
      ctx.strokeStyle = hsla(p.hue, p.sat, 60, 0.18 + level * 0.22 - k * 0.04);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      if (state === "thinking") {
        const start = spin * (k % 2 ? -1 : 1) + k;
        ctx.arc(cx, cy, rr, start, start + Math.PI * (0.6 + 0.2 * k));
      } else {
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
  }

  // Orbiting particles.
  for (const pt of PARTICLES) {
    pt.a += pt.spd * 0.01 * (state === "thinking" ? 2.2 : 1);
    const rr = R * pt.r * (1 + level * 0.15);
    ctx.fillStyle = hsla(p.hue, p.sat, 75, 0.22 + level * 0.3);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(pt.a) * rr, cy + Math.sin(pt.a) * rr, pt.sz, 0, Math.PI * 2);
    ctx.fill();
  }

  // Molten core.
  const coreR = R * (0.7 + level * 0.5);
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  core.addColorStop(0, hsla(p.hue, 100, 96, 0.95));
  core.addColorStop(0.35, hsla(p.hue, p.sat, 66, 0.85));
  core.addColorStop(1, hsla(p.hue, p.sat, 45, 0));
  ctx.fillStyle = core;
  ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();

  // Arc-reactor iris: two counter-rotating triangles.
  if (!reduceMotion) {
    ctx.strokeStyle = hsla(p.hue, p.sat, 82, 0.45);
    ctx.lineWidth = 1.4;
    const ir = R * 0.34;
    for (let s = 0; s < 2; s++) {
      const rot = t * (s ? -0.6 : 0.6) + s;
      ctx.beginPath();
      for (let v = 0; v <= 3; v++) {
        const a = rot + (v / 3) * Math.PI * 2;
        const x = cx + Math.cos(a) * ir, y = cy + Math.sin(a) * ir;
        v === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  ctx.restore();

  // Crisp rim.
  ctx.strokeStyle = hsla(p.hue, p.sat, 80, 0.5 + level * 0.3);
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

  requestAnimationFrame(drawOrb);
}
requestAnimationFrame(drawOrb);
