import { isFatalSpeechError } from "./stt-policy.js";
import { getVisibilityToggle } from "./visibility-policy.js";
import { createBuildHud } from "./build-hud.js";

// ---- DOM ----
const statusEl = document.getElementById("status");
const capEl = document.getElementById("caption");
const micBtn = document.getElementById("mic");
const canvas = document.getElementById("orb");
const ctx = canvas.getContext("2d");
const dbgEl = document.getElementById("dbg");
const progEl = document.getElementById("progress");
const artifactEl = document.getElementById("artifact");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The build HUD is measured against the real orb element rather than the middle
// of the window, because the orb is laid out above the caption. #hud is watched
// too: a caption that wraps to a second line moves the orb.
const buildHud = createBuildHud({
  orbEl: canvas,
  layoutEls: [canvas, document.getElementById("hud")],
});

const dbgLines = [];
function dbg(message) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  dbgLines.push(`${time}  ${message}`);
  if (dbgLines.length > 16) dbgLines.shift();
  if (dbgEl) dbgEl.textContent = dbgLines.join("\n");
  console.log(`[jarvis] ${message}`);
}

// ---- Build progress readout ----
// A build can run for minutes and emit hundreds of steps. Only the last few are
// worth showing: enough to prove something is happening, not so much that the
// HUD turns into a log file.
const PROGRESS_MAX = 5;
const progressBuffer = [];

// This text is written by the model running the build, so it is untrusted input
// on its way to the screen. It is rendered with textContent (never HTML), and
// control characters are dropped because they can forge extra lines.
function cleanProgressLine(line) {
  return String(line ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

function renderProgress() {
  if (!progEl) return;
  progEl.textContent = "";
  for (const line of progressBuffer) {
    const row = document.createElement("div");
    row.textContent = line;
    progEl.appendChild(row);
  }
  progEl.classList.toggle("hidden", progressBuffer.length === 0);
}

function pushProgress(line) {
  const text = cleanProgressLine(line);
  if (!text) return;
  progressBuffer.push(text);
  while (progressBuffer.length > PROGRESS_MAX) progressBuffer.shift();
  renderProgress();
  // The same line, cut into the record around the orb: the HUD is the only place
  // it is visible while a build is running (see build-hud-live in index.html).
  buildHud.event(text);
  dbg(`build: ${text}`);
}

function clearProgress() {
  if (progressBuffer.length === 0) return;
  progressBuffer.length = 0;
  renderProgress();
}

// ---- What the build was asked for ----
// The server never tells this tab which primitive it dispatched, so the only
// honest description of the build available here is what the person actually
// said. A turn is a "request" unless the server has an outstanding question, in
// which case it is the answer to that question. Nothing is inferred beyond that:
// if there is no request to show, the HUD omits the row rather than invent one.
let requestTurn = "";
const answerTurns = [];
let awaitingAnswer = false;

function noteSpokenTurn(text) {
  if (awaitingAnswer) {
    answerTurns.push(text);
    while (answerTurns.length > 3) answerTurns.shift();
    return;
  }
  requestTurn = text;
  answerTurns.length = 0;
}

function takeBuildRequest() {
  const request = { request: requestTurn, detail: answerTurns.join(" · ") };
  requestTurn = "";
  answerTurns.length = 0;
  awaitingAnswer = false;
  return request;
}

// ---- State ----
let state = "idle"; // idle | listening | thinking | working | speaking
let level = 0;      // 0..1 smoothed amplitude driving the orb
let listening = false;
function setState(nextState) {
  state = nextState;
  statusEl.textContent = nextState;
  if (nextState === "working") {
    // A new build supersedes the last one's leftover link.
    artifactEl?.classList.add("hidden");
    buildHud.start(takeBuildRequest());
  } else {
    // The readout belongs to the build that produced it. Leaving it up after
    // the orb has moved on would describe work that already finished.
    clearProgress();
    // The build's outcome arrives a moment AFTER it stops working (the done-line
    // is spoken first), so the HUD holds the finished record for a few seconds
    // and paints in whichever ending lands — then tears itself down. This is a
    // no-op when no build was running.
    buildHud.finish();
  }
  dbg(`state → ${nextState}`);
}
function setCaption(text, who) { capEl.textContent = text; capEl.dataset.who = who || ""; }

// Shows a finished build in a NEW TAB. Navigating this tab instead would tear
// down the WebSocket, the audio context and the whole conversation, so the app
// must never point itself at the artifact.
function openArtifact(url) {
  // An empty url would resolve to the app's own address and open a second copy
  // of Jarvis, so it is rejected before it reaches the URL parser.
  if (typeof url !== "string" || url.trim() === "") {
    dbg("open: ignored a missing url");
    return;
  }
  let target;
  try {
    target = new URL(url, location.href);
  } catch {
    dbg("open: ignored an unusable url");
    return;
  }
  // The server serves the build itself, so anything off-origin did not come
  // from a build and has no business being opened on the app's behalf.
  if (target.origin !== location.origin) {
    dbg(`open: refused off-origin ${target.origin}`);
    return;
  }
  if (window.open(target.href, "_blank", "noopener")) {
    dbg(`open: ${target.pathname}`);
    return;
  }
  // Browsers block window.open when it isn't the result of a click, and a build
  // finishes minutes after the last one. Offer the link rather than lose the page.
  if (artifactEl) {
    artifactEl.href = target.href;
    artifactEl.classList.remove("hidden");
  }
  dbg(`open: blocked by the browser, link shown (${target.pathname})`);
}

function toggleVisibility(target) {
  if (target === "caption") capEl.classList.toggle("hidden");
  else if (target === "interface") {
    document.body.classList.toggle("interface-hidden");
    // CSS hides the HUD with the rest of the chrome; telling it as well lets it
    // stop painting into a display:none canvas while the build carries on.
    buildHud.setChromeHidden(document.body.classList.contains("interface-hidden"));
  }
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
  // A build in flight now has no way to report its ending, so the HUD is retired
  // rather than left cutting a record nothing will ever finish.
  buildHud.finish();
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
  else if (msg.type === "progress") pushProgress(msg.line);
  else if (msg.type === "ask") {
    // A build needs a detail Jarvis doesn't have yet; the question is spoken as
    // well, so the caption just mirrors it.
    setCaption(msg.text, "jarvis");
    // Whatever is said next answers this question rather than starting a new
    // request, which is how the HUD tells the two apart.
    awaitingAnswer = true;
    dbg(`ask: ${msg.text}`);
  }
  else if (msg.type === "open") {
    // The artifact URL is the only authoritative statement of what the build
    // produced, so it settles both the HUD's outcome and its filename.
    buildHud.succeeded(msg.url);
    openArtifact(msg.url);
  }
  else if (msg.type === "debug") {
    const timing = msg.ms ? ` (${msg.ms}ms)` : "";
    dbg(`srv ${msg.stage || ""}: ${msg.msg || ""}${timing}`);
  }
  else if (msg.type === "error") {
    setCaption("⚠ " + msg.message, "error");
    dbg(`srv ERROR: ${msg.message}`);
    // Before setState, so the HUD knows how this ended by the time it settles. A
    // build that failed must never retire wearing the styling of one that worked.
    buildHud.failed();
    level = 0;
    setState("idle");
  }
  else if (msg.type === "audio") {
    dbg(`audio: ~${Math.round((msg.data.length * 3) / 4 / 1024)}kb received`);
    try {
      await playAudio(msg.data, msg.nextState);
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
      noteSpokenTurn(text);
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
async function playAudio(b64, nextState) {
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
    // A clip can hand the orb to a state instead of ending the turn: the build
    // confirmation lands in "working" so the HUD picks up exactly when the voice
    // stops. Anything without a handoff returns to idle as usual.
    setState(nextState || "idle");
  };
  src.start();
}

// ---- Orb ----
// Cool hues are the conversation (idle, listening, speaking); warm hues are the
// model doing something. Working sits deeper and hotter than thinking's gold so
// the two never read as the same state.
const PALETTE = {
  idle:      { hue: 192, sat: 90, glow: 0.30 },
  listening: { hue: 158, sat: 92, glow: 0.50 },
  thinking:  { hue: 38,  sat: 96, glow: 0.55 },
  working:   { hue: 18,  sat: 90, glow: 0.62 },
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
  else if (state === "working") {
    // A build can run for many minutes, so this has to look alive and patient
    // rather than urgent. Two slow waves whose periods don't divide into each
    // other, so the swell never visibly repeats: it sits fuller than thinking
    // and moves a third as fast.
    target = 0.46 + Math.sin(t * 0.8) * 0.11 + Math.sin(t * 0.31) * 0.07;
  }
  else if (state === "listening") target = 0.30 + Math.sin(t * 5) * 0.14;
  else target = 0.12 + Math.sin(t * 1.2) * 0.05; // idle breathing
  // Heavy easing while working: the orb takes its time arriving anywhere, which
  // is most of what separates sustained effort from an eager pulse.
  smooth += (target - smooth) * (state === "working" ? 0.06 : 0.18);
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

  const spinRate = state === "thinking" ? 0.9 : state === "working" ? 0.14 : 0.25;
  const spin = reduceMotion ? 0 : t * spinRate;

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
    // Thinking and working both draw open, counter-rotating sweeps; idle and
    // listening draw closed rings. Working stacks one more sweep and turns each
    // at its own rate, so the ring stack churns instead of spinning as one piece.
    const sweeping = state === "thinking" || state === "working";
    const arcs = state === "working" ? 4 : sweeping ? 3 : 2;
    for (let k = 0; k < arcs; k++) {
      const rr = R * (1.14 + k * 0.16) + Math.sin(t * 2 + k) * 3;
      ctx.strokeStyle = hsla(p.hue, p.sat, 60, 0.18 + level * 0.22 - k * 0.04);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      if (sweeping) {
        const rate = state === "working" ? 1 + k * 0.45 : 1;
        const start = spin * rate * (k % 2 ? -1 : 1) + k;
        ctx.arc(cx, cy, rr, start, start + Math.PI * (0.6 + 0.2 * k));
      } else {
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
  }

  // Orbiting particles. They race while thinking and drift while working —
  // the same dust, a different tempo.
  const drift = state === "thinking" ? 2.2 : state === "working" ? 0.5 : 1;
  for (const pt of PARTICLES) {
    pt.a += pt.spd * 0.01 * drift;
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

  // Counter-rotating iris: two triangles turning against each other.
  if (!reduceMotion) {
    ctx.strokeStyle = hsla(p.hue, p.sat, 82, 0.45);
    ctx.lineWidth = 1.4;
    const ir = R * 0.34;
    const irisRate = state === "working" ? 0.2 : 0.6;
    for (let s = 0; s < 2; s++) {
      const rot = t * (s ? -irisRate : irisRate) + s;
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
