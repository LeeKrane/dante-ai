import { applyResults, interimOf, isFatalSpeechError, mergeTranscript } from "./stt-policy.js";
import { getVisibilityToggle, hiddenPanelHints } from "./visibility-policy.js";
import { createBuildHud } from "./build-hud.js";
import { createAppendQueue } from "./clip-stream.js";
import { normalizeProgress, progressRowText, pushProgressEntry } from "./progress-policy.js";
import { panelIsVisible, rowsFromRoster } from "./roster-panel.js";
import {
  canStartListening,
  clearAnnouncements,
  handoffAfterPreempt,
  queueAnnouncement,
  shouldShowCancel,
  stateAfterClip,
  takeAnnouncement,
} from "./playback-policy.js";
import {
  clampVolume,
  parseStoredVolume,
  formatVolumePercent,
  isMuted,
  nextMuteState,
  volumeButtonAction,
  MIN_VOLUME,
  MAX_VOLUME,
  DEFAULT_VOLUME,
  VOLUME_STEP,
} from "./volume-policy.js";
import { centsForPitch, rateForPitch } from "./pitch-policy.js";

// ---- DOM ----
const statusEl = document.getElementById("status");
const capEl = document.getElementById("caption");
const micBtn = document.getElementById("mic");
const cancelBtn = document.getElementById("cancel");
const canvas = document.getElementById("orb");
const ctx = canvas.getContext("2d");
const dbgEl = document.getElementById("dbg");
const audioEl = document.getElementById("clip");
const volumeEl = document.getElementById("volume");
const volBtn = document.getElementById("vol-btn");
const volRange = document.getElementById("vol-range");
const volLabel = document.getElementById("vol-label");
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
  console.log(`[dante] ${message}`);
}

// ---- Build progress readout ----
// What may be shown, and how much of it, lives in progress-policy.js so it can
// be unit-tested; this half is only the DOM. The buffer holds normalized entries
// rather than strings, because a build that runs in steps sends boundaries as
// well as lines and the two render differently.
const progressBuffer = [];

// Every row is written with textContent, never HTML: this text was produced by
// the model running the build, and progress-policy.js stripping the control
// characters out of it is only half the defence.
function renderProgress() {
  if (!progEl) return;
  progEl.textContent = "";
  for (const entry of progressBuffer) {
    const row = document.createElement("div");
    row.textContent = progressRowText(entry);
    progEl.appendChild(row);
  }
  progEl.classList.toggle("hidden", progressBuffer.length === 0);
}

function pushProgress(line) {
  const entry = normalizeProgress(line);
  if (!entry) return;
  pushProgressEntry(progressBuffer, entry);
  renderProgress();
  // The same thing, cut into the record around the orb: the HUD is the only place
  // it is visible while a build is running (see build-hud-live in index.html). A
  // boundary goes in through its own entry point, because the record marks it
  // differently — it is the orchestrator speaking, not the build.
  if (entry.kind === "step") buildHud.step(entry);
  else buildHud.event(entry.text, entry.step);
  dbg(`build: ${progressRowText(entry).trim()}`);
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
  // Settling into idle is the other way the floor comes free -- a turn that
  // ended without a clip, an error, a cancelled build.
  if (nextState === "idle") pumpAnnouncements();
}
function setCaption(text, who) { capEl.textContent = text; capEl.dataset.who = who || ""; }

// Shows a finished build in a NEW TAB. Navigating this tab instead would tear
// down the WebSocket, the audio context and the whole conversation, so the app
// must never point itself at the artifact.
function openArtifact(url) {
  // An empty url would resolve to the app's own address and open a second copy
  // of Dante, so it is rejected before it reaches the URL parser.
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
    // A hidden button that is merely invisible still answers the keyboard.
    refreshCancel();
  }
  else if (target === "diagnostics" && dbgEl) dbgEl.classList.toggle("hidden");
  else if (target === "sessions") {
    sessionsOpen = !sessionsOpen;
    renderSessions();
  }
  renderKeys();
}

// ---- Audio (hoisted so the orb loop can read the live analyser) ----
let audioCtx;
let analyser = null;
let freqBins = null;
let timeBins = null;
// The clip currently audible, and the state it was going to hand the orb to.
// Kept because a source node cannot be stopped without a reference to it, which
// is the whole reason Dante used to be impossible to interrupt.
let playbackSource = null;
let playbackHandoff = null;
// The clip being received off the wire, which is not always the clip being
// heard: without MediaSource nothing is audible until the last chunk has landed.
let incoming = null;

// ---- Volume (a GainNode shared by both playback paths) ----
//
// Local to this browser and this machine, and separate from the `volume` a
// person can set in ~/.config/fish-audio/speak.json: that one asks Fish to
// synthesize a louder clip, once, for everyone who ever hears it; this one
// turns a knob on the way from the speakers on this one machine, and it is the
// only way to go louder than the clip Fish actually sent. Wrapped in try/catch
// throughout because a private tab or a browser with storage disabled throws on
// touching localStorage at all, and a volume button must not be able to break
// the rest of the page over that.
const VOLUME_KEY = "dante-volume";
let volume = loadVolume();
function loadVolume() {
  try { return parseStoredVolume(localStorage.getItem(VOLUME_KEY)); }
  catch { return clampVolume(1); }
}
let gainNode = null;

// The level to bring back on unmute, kept in a key of its own rather than
// folded into VOLUME_KEY: the two need to survive independently of each
// other across a reload, since mute is derived from `volume` alone and a
// reload happening mid-mute must not lose what the fader was at before it.
const PREMUTE_KEY = "jarvis-volume-premute";
let premuteRestore = loadPremute();
function loadPremute() {
  try { return parseStoredVolume(localStorage.getItem(PREMUTE_KEY)); }
  catch { return DEFAULT_VOLUME; }
}
function savePremute(v) {
  try { localStorage.setItem(PREMUTE_KEY, String(v)); } catch { /* storage unavailable */ }
}

// Created once the AudioContext exists and reused by both the streamed and the
// buffered playback path, so turning the knob mid-clip is heard immediately
// either way rather than only on the next reply.
function ensureGain() {
  if (gainNode) return gainNode;
  gainNode = audioCtx.createGain();
  gainNode.gain.value = volume;
  gainNode.connect(audioCtx.destination);
  return gainNode;
}

function renderVolume() {
  if (volLabel) volLabel.textContent = formatVolumePercent(volume);
  // Only touched when it does not already match: dragging is `input` firing on
  // every pointer move, and writing `.value` back mid-drag on some browsers
  // resets the pointer's grab offset and makes the thumb stutter.
  if (volRange && volRange.value !== String(volume)) volRange.value = String(volume);
  // Mute is derived from `volume`, not tracked separately, so dragging the
  // fader all the way down shows the muted icon for free -- this runs on
  // every render, not just the ones the mute button itself causes.
  const muted = isMuted(volume);
  volumeEl?.classList.toggle("muted", muted);
  if (volBtn) {
    volBtn.setAttribute("aria-pressed", String(muted));
    volBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  }
}

function setVolume(v) {
  volume = clampVolume(v);
  if (gainNode) gainNode.gain.value = volume;
  try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* storage unavailable */ }
  // The one bit of this that is genuinely hard to eyeball: whether the fader
  // reached the node at all. Visible in the diagnostics panel (key `d`) without
  // needing a clip in flight to hear the difference.
  dbg(`volume ${formatVolumePercent(volume)}${gainNode ? "" : " (no clip has played yet — applied on the next one)"}`);
  renderVolume();
}

if (volRange) {
  volRange.min = String(MIN_VOLUME);
  volRange.max = String(MAX_VOLUME);
  volRange.step = String(VOLUME_STEP);
}
volRange?.addEventListener("input", () => setVolume(Number(volRange.value)));

// The fader's visibility is driven entirely by #volume.open (CSS above), not
// by :hover — a plain :hover rule drops the instant the pointer leaves, and
// the whole point here is that it doesn't: leaving the button (or the dead
// space on the way to the track, or the track mid-drag) starts a timer rather
// than closing immediately, so a slightly wobbly mouse never slams the fader
// shut under the cursor.
let volCloseTimer = null;
function openVolume() {
  clearTimeout(volCloseTimer);
  volumeEl?.classList.add("open");
}
function scheduleCloseVolume() {
  clearTimeout(volCloseTimer);
  volCloseTimer = setTimeout(() => volumeEl?.classList.remove("open"), 250);
}
function closeVolumeNow() {
  clearTimeout(volCloseTimer);
  volumeEl?.classList.remove("open");
}
// mouseenter/mouseleave (unlike mouseover/mouseout) don't fire when the
// pointer merely crosses from the button to the track or back — both live
// inside #volume — so these only fire on the real boundary of the component.
volumeEl?.addEventListener("mouseenter", openVolume);
volumeEl?.addEventListener("mouseleave", scheduleCloseVolume);
// focusin/focusout cover keyboard tabbing to the range input, and touch:
// tapping the range thumb focuses it same as a click would.
volumeEl?.addEventListener("focusin", openVolume);
volumeEl?.addEventListener("focusout", scheduleCloseVolume);
// On a hover-capable device mouseenter has already opened the fader by the
// time this click lands, so the click has nothing left to reveal and always
// means mute -- see volume-policy.js for the decision itself. Without hover
// the first tap has to open the fader outright, the way mouseenter would
// have; a second tap, with the fader already open, reaches for mute too.
volBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const hoverCapable = window.matchMedia?.("(hover: hover)").matches ?? true;
  const faderOpen = volumeEl?.classList.contains("open") ?? false;
  if (volumeButtonAction({ hoverCapable, faderOpen }) === "open") {
    openVolume();
    return;
  }
  const next = nextMuteState(volume, premuteRestore);
  premuteRestore = next.restore;
  savePremute(premuteRestore);
  // Through setVolume(), same as the fader itself, so the gain node, the
  // label, the slider and storage all update through the one path they
  // already go through -- mute is just another point on the same volume.
  setVolume(next.volume);
});
document.addEventListener("click", closeVolumeNow);
renderVolume();

// ---- WebSocket ----
const ws = new WebSocket(`ws://${location.host}`);
// A socket the server refused never opened, which is how an expired session
// shows up here: the page loaded because the cookie was still good when the HTML
// was fetched, and the upgrade was rejected a moment later. Telling someone to
// restart the server would be wrong, so the two closings are distinguished.
let wsOpened = false;
ws.onopen = () => { wsOpened = true; dbg("ws: connected"); };
ws.onclose = () => {
  dbg("ws: closed");
  if (!wsOpened) {
    // replace(), so the orb is not one Back away from a page that cannot work.
    location.replace("/login.html");
    return;
  }
  // A build in flight now has no way to report its ending, so the HUD is retired
  // rather than left cutting a record nothing will ever finish.
  buildHud.finish();
  // Same reasoning for a clip: it is streamed, so the end of it is a message like
  // any other and a socket that closes mid-clip would leave the element waiting
  // for bytes forever, with the orb speaking and the Stop button still offered.
  stopPlayback();
  setCaption("connection closed — restart the server and refresh", "error");
};
ws.onerror = () => dbg("ws: error");
ws.onmessage = async (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.type === "state") setState(msg.value);
  else if (msg.type === "reply_text") {
    setCaption(msg.text, "dante");
    dbg(`reply: ${msg.text}`);
  }
  else if (msg.type === "progress") pushProgress(msg.line);
  else if (msg.type === "announce") receiveAnnouncement(msg);
  else if (msg.type === "clear_announcements") receiveClearAnnouncements();
  else if (msg.type === "roster") {
    roster = Array.isArray(msg.sessions) ? msg.sessions : [];
    watchSessions();
  }
  else if (msg.type === "ask") {
    // A build needs a detail Dante doesn't have yet; the question is spoken as
    // well, so the caption just mirrors it.
    setCaption(msg.text, "dante");
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
  // A clip arrives in three parts because Fish sends it in pieces: the header
  // that says one is coming, the pieces, and the word that there are no more.
  // Every one of them carries the clip's id, and a piece whose id is not the one
  // being received is dropped — the server commits to a whole clip once it has
  // sent a byte of it, so a clip cut off mid-sentence keeps arriving after the
  // one that replaced it has started.
  else if (msg.type === "audio_start") {
    try {
      await startClip(msg);
    } catch (e) {
      setCaption("⚠ audio: " + (e.message || e), "error");
      dbg(`audio start failed: ${e.message || e}`);
      level = 0;
      setState("idle");
    }
  }
  else if (msg.type === "audio_chunk") pushClipChunk(msg);
  else if (msg.type === "audio_end") {
    try {
      await endClip(msg);
    } catch (e) {
      setCaption("⚠ audio: " + (e.message || e), "error");
      dbg(`audio decode failed: ${e.message || e}`);
      level = 0;
      setState("idle");
    }
  }
};

// ---- What is running ----
//
// The roster the server already keeps, painted into a panel of its own,
// closed with `s` -- same idea as diagnostics on `d`, in the opposite corner.
// It arrives whenever it changes rather than on a timer, and the elapsed
// times are ticked locally -- a session's age changes every second and none
// of that is worth a message.
//
// Only sessions Dante may see reach here: the server filters to the
// repositories that were named out loud before any of this is sent.
const sessionsEl = document.getElementById("sessions");
let roster = [];
let sessionsOpen = true;

function renderSessions() {
  if (!sessionsEl) return;
  sessionsEl.classList.toggle("hidden", !panelIsVisible(sessionsOpen));
  const rows = rowsFromRoster(roster);
  if (rows.length === 0) {
    const none = document.createElement("div");
    none.className = "none";
    none.textContent = "nothing running";
    sessionsEl.replaceChildren(none);
    return;
  }
  // Rebuilt wholesale rather than diffed: eight rows of text is not a thing
  // worth reconciling, and a stale row would describe a session that has ended.
  sessionsEl.replaceChildren(...rows.map((row) => {
    const line = document.createElement("div");
    line.className = `sess ${row.condition}`;
    // textContent throughout: a session name is written by whoever started the
    // session, which is not always Dante.
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.where ? `${row.where}/${row.name}` : row.name;
    const cond = document.createElement("span");
    cond.className = "cond";
    cond.textContent = row.condition;
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = row.elapsed;
    line.append(name, cond, when);
    return line;
  }));
}

// One timer for the whole panel, and only while there is something in it: the
// only thing that changes between roster messages is how long each has been
// running.
let sessionsTimer = null;
function watchSessions() {
  renderSessions();
  if (roster.length > 0 && sessionsTimer === null) {
    sessionsTimer = setInterval(renderSessions, 1000);
  } else if (roster.length === 0 && sessionsTimer !== null) {
    clearInterval(sessionsTimer);
    sessionsTimer = null;
  }
}

// ---- What is off ----
//
// One line under the controls naming every panel that is currently hidden,
// key first, so the four keys (`t`, `h`, `d`, `s`) never need remembering.
// Empty and hidden once everything is on.
const keysEl = document.getElementById("keys");

function panelsVisible() {
  return {
    caption: !capEl.classList.contains("hidden"),
    interface: !document.body.classList.contains("interface-hidden"),
    diagnostics: Boolean(dbgEl) && !dbgEl.classList.contains("hidden"),
    sessions: panelIsVisible(sessionsOpen),
  };
}

function renderKeys() {
  if (!keysEl) return;
  const hints = hiddenPanelHints(panelsVisible());
  keysEl.classList.toggle("hidden", hints.length === 0);
  keysEl.replaceChildren(...hints.flatMap((hint, i) => {
    const kbd = document.createElement("kbd");
    kbd.textContent = hint.key;
    const label = document.createTextNode(` ${hint.label}`);
    return i === 0 ? [kbd, label] : [document.createTextNode(" · "), kbd, label];
  }));
}

renderSessions();
renderKeys();

// ---- Announcements ----
//
// Lines nobody asked for: a session finished, a session wants something. Slack
// always has them, durably, so speaking one is a convenience and a convenience
// does not get to interrupt. They queue here and are spoken only when the floor
// is genuinely free -- the policy is in playback-policy.js, where it can be
// tested.
//
// The text is the server's; the timing is ours, because the floor is a client
// fact. The mic being open, a clip being audible and a question waiting on an
// answer are all things only this page knows.
let announcements = [];

// `at` is stamped on arrival rather than taken from the server, so staleness is
// measured on one clock -- the one the person is standing next to.
function receiveAnnouncement(msg) {
  announcements = queueAnnouncement(announcements, { id: msg.id, text: msg.text, at: Date.now() });
  dbg(`announcement queued: ${msg.text}`);
  pumpAnnouncements();
}

// A recap ("what happened while I was out") just said everything in this
// queue out loud, in one paragraph -- so leaving it here would repeat every
// one of them the next time the floor comes free. The server clears its own
// pending map in the same breath; this is this page's half of it.
function receiveClearAnnouncements() {
  const { queue, dropped } = clearAnnouncements(announcements);
  announcements = queue;
  if (dropped > 0) dbg(`${dropped} announcement(s) cleared by a recap`);
}

// Called wherever the floor might have just been given up: a clip ending or
// being cancelled, the mic closing, the orb settling. Cheap and idempotent, so
// calling it too often costs nothing and missing a moment costs a silence.
function pumpAnnouncements() {
  const { speak, queue, dropped } = takeAnnouncement(announcements, {
    state,
    holding,
    listening,
    playing: playbackSource,
    awaitingAnswer,
  });
  announcements = queue;
  if (dropped > 0) dbg(`${dropped} announcement(s) dropped as stale`);
  if (!speak) return;
  // The server holds the text and does the speaking; this only says when.
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "announce_ready", id: speak.id }));
}

// ---- Speech-to-text (Chrome Web Speech API, free) ----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let holding = false;   // physical button/Space held — this drives the green
// What earlier recognition sessions of this hold produced, and the finals of the
// session running right now, indexed the way the engine indexes them. They are
// separate because a restart renumbers `results` from 0 — see stt-policy.js.
let committedText = "";
let sessionFinals = [];

if (SR) {
  rec = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.onstart = () => dbg("stt: started");
  rec.onresult = (e) => {
    sessionFinals = applyResults(sessionFinals, e.resultIndex, e.results);
    const shown = mergeTranscript(committedText, sessionFinals, interimOf(e.resultIndex, e.results));
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
      // The restarted session numbers its results from 0, so bank this one's
      // before it does or the next phrase overwrites this one.
      committedText = mergeTranscript(committedText, sessionFinals);
      sessionFinals = [];
      try {
        rec.start();
        listening = true;
        dbg("stt: auto-resumed (still holding)");
      } catch (error) {
        dbg(`stt resume deferred: ${error.message}`);
      }
      return;
    }
    const text = mergeTranscript(committedText, sessionFinals);
    committedText = "";
    sessionFinals = [];
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
  if (!canStartListening(state, holding, Boolean(rec))) return;
  // Whatever is being said is now beside the point. The handoff this clip
  // carried is deliberately DROPPED here: setState("listening") happens two
  // lines down, and applying the handoff first would flip the orb through
  // "working", which starts the build HUD and then tears it down again on the
  // very next setState. The cancel button, which sets nothing afterwards, is
  // where a handoff is honoured.
  stopPlayback();
  holding = true;
  committedText = "";
  sessionFinals = [];
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
  // Not spoken yet: what was just said is on its way to the server, and the
  // orb moves to thinking. This is here for the release that said nothing.
  pumpAnnouncements();
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

// Silence without starting a turn. Unlike the record button this one DOES apply
// the clip's handoff: nothing else is about to set the state, so discarding it
// would strand the HUD of a build that is already running.
cancelBtn?.addEventListener("click", () => {
  const handoff = stopPlayback();
  setState(stateAfterClip(handoff));
  // Space is push-to-talk, and a button still holding focus would try to
  // activate on the same keypress that starts the next sentence.
  cancelBtn.blur();
});

// ---- Playback (analyser drives the reactive orb) ----

// stopPlayback() -> the handoff the cancelled clip was carrying, or null.
//
// `onended` is detached BEFORE stop(), because stop() fires it: left attached,
// the ended path and whoever cancelled would both set the state, and which one
// won would come down to timing. Returns null when nothing is playing, so every
// caller can call it without checking first.
// Shown while a clip is audible and hidden the instant it is not, so the button
// never offers to stop something that has already stopped.
function refreshCancel() {
  cancelBtn?.classList.toggle(
    "hidden",
    !shouldShowCancel(playbackSource, document.body.classList.contains("interface-hidden")),
  );
}

function stopPlayback() {
  // Silence covers what is on its way as well as what is coming out. Without
  // this a clip still arriving would play in full a second later, over whoever
  // cut it off — the case the old whole-buffer path never had, because a clip
  // that had not finished synthesizing had not been sent at all.
  dropIncoming();
  const source = playbackSource;
  if (!source) return null;
  const handoff = playbackHandoff;
  playbackSource = null;
  playbackHandoff = null;
  source.onended = null;
  try { source.stop(); } catch { /* already ended between the check and here */ }
  analyser = null;
  level = 0;
  refreshCancel();
  dbg("playback cancelled");
  return handoff;
}

// mp3 is the only format Fish is asked for and the only one MediaSource takes.
// Anything else falls back to decoding the whole clip, which works for all of them.
const STREAM_MIME = { mp3: "audio/mpeg" };

// createMediaElementSource may be called only ONCE per element for the life of
// the page, and it re-routes the element away from the speakers and into the
// graph. So the element, its source node and its analyser are built once and
// never torn down; the MediaSource behind the element is what is swapped per
// clip. Building this per clip silently kills all audio on the second one.
let mediaGraph = null;
function ensureGraph() {
  if (mediaGraph) return mediaGraph;
  const node = audioCtx.createMediaElementSource(audioEl);
  const an = audioCtx.createAnalyser();
  an.fftSize = 512;
  an.smoothingTimeConstant = 0.78;
  node.connect(an);
  // Through the shared gain node rather than straight to the speakers, so the
  // volume buttons reach a clip already streaming, not just the next one.
  an.connect(ensureGain());
  mediaGraph = { analyser: an };
  return mediaGraph;
}

// What both paths do when a clip stops of its own accord. A clip can hand the
// orb to a state instead of ending the turn: the build confirmation lands in
// "working" so the HUD picks up exactly when the voice stops. Anything without a
// handoff — or with one the orb does not know — returns to idle as usual.
function clipEnded(handoff) {
  playbackSource = null;
  playbackHandoff = null;
  refreshCancel();
  analyser = null;
  level = 0;
  dbg("playback ended");
  setState(stateAfterClip(handoff));
  // The floor was just given up, which is the commonest moment for a queued
  // announcement to become sayable.
  pumpAnnouncements();
}

function dropIncoming() {
  if (!incoming) return;
  if (incoming.queue) incoming.queue.stop();
  incoming = null;
}

// The media element outlives every clip, so its events are routed to whichever
// clip is current rather than re-bound per clip. stopPlayback clears
// playbackSource BEFORE pausing, so a cancelled clip cannot fire its ending on
// behalf of the one replacing it — the same reason it detaches onended first.
audioEl?.addEventListener("ended", () => {
  if (playbackSource?.onended) playbackSource.onended();
});
audioEl?.addEventListener("error", () => {
  // Only a streaming clip owns the element. A decode failure on the buffered
  // path throws where it is awaited and is reported there.
  if (!playbackSource?.media) return;
  dbg(`audio element error: ${audioEl.error?.message || audioEl.error?.code || "unknown"}`);
  playbackSource.onended?.();
});

// endOfStream throws on a MediaSource that is no longer open, which is exactly
// the state a clip cut off mid-sentence leaves behind.
function endStream(media) {
  if (media.readyState !== "open") return;
  try { media.endOfStream(); } catch (e) { dbg(`audio end: ${e.message || e}`); }
}

async function startClip(msg) {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  const mime = STREAM_MIME[msg.format];
  if (!mime || typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(mime)) {
    // No progressive playback in this browser. Collect the clip and decode it
    // whole, which is what this always did. Deliberately does NOT pre-empt or
    // check the button yet: on this path those decisions still belong at the
    // moment sound would actually start, which is a chunk or two from now.
    dropIncoming();
    incoming = { id: msg.id, nextState: msg.nextState, pitch: msg.pitch, chunks: [] };
    dbg(`audio: buffering ${msg.format} whole (no MediaSource)`);
    return;
  }

  // Whatever is audible now is cut off, and whatever was still arriving is
  // abandoned with it. Two clips really can land together — a build's spoken
  // result is deliberately not gated by the conversation, so a done-line and a
  // chat reply can arrive in the same second — and without this both are heard.
  // It returns null when nothing was playing, which is every ordinary turn.
  const handoff = handoffAfterPreempt(stopPlayback(), msg.nextState);

  // The button went down while this clip was being synthesized. Playing it now
  // would talk over the person holding it — but the build it may have dispatched
  // is already running, so the handoff is honoured even though the voice is never
  // heard. Checked before anything is wired up, so nothing is left attached to a
  // clip that will never play.
  if (holding) {
    dbg("audio dropped: the button is held");
    if (handoff) setState(stateAfterClip(handoff));
    return;
  }

  const { analyser: an } = ensureGraph();
  const media = new MediaSource();
  const url = URL.createObjectURL(media);
  const queue = createAppendQueue({
    onEnd: () => endStream(media),
    onError: (e) => { dbg(`audio append failed: ${e.message || e}`); endStream(media); },
  });

  // Duck-typed to match the AudioBufferSourceNode stopPlayback has always been
  // handed: `onended` detachable, `stop()` final, both meaning what they meant
  // before. Keeping that shape is what leaves stopPlayback, the cancel button and
  // the record button untouched by progressive playback.
  const clip = {
    media,
    onended: null,
    stop() {
      queue.stop();
      audioEl.pause();
      // Pausing alone leaves the MediaSource attached, and the next clip needs
      // the element free to take a new one.
      audioEl.removeAttribute("src");
      audioEl.load();
      URL.revokeObjectURL(url);
    },
  };

  media.addEventListener("sourceopen", () => {
    // The URL is a handle to the MediaSource, not the data; it is revoked as soon
    // as the element has taken it, and revoking twice is a no-op.
    URL.revokeObjectURL(url);
    let sink;
    try { sink = media.addSourceBuffer(mime); }
    catch (e) { dbg(`audio: ${e.message || e}`); queue.stop(); return; }
    queue.attach(sink);
  }, { once: true });

  audioEl.src = url;
  incoming = { id: msg.id, queue };
  playbackSource = clip;
  playbackHandoff = handoff;
  clip.onended = () => clipEnded(handoff);
  analyser = an;
  freqBins = new Uint8Array(an.frequencyBinCount);
  timeBins = new Uint8Array(an.fftSize);
  refreshCancel();
  setState("speaking");
  dbg("playing as it arrives");
  // preservesPitch defaults to true in every current browser, which means
  // playbackRate alone would change tempo and NOT pitch. This is the
  // load-bearing line that turns the rate change below into an actual pitch
  // shift, at the cost of tempo moving with it -- the resampling trade-off
  // documented in pitch-policy.js.
  audioEl.preservesPitch = false;
  audioEl.playbackRate = rateForPitch(msg.pitch);
  // Only worth a line when it is actually doing something: the diagnostics log
  // is capped, and a neutral pitch on every single clip would push out the
  // lines that do carry news.
  if (audioEl.playbackRate !== 1) dbg(`pitch: rate ${audioEl.playbackRate.toFixed(3)} (streamed)`);
  // Autoplay is allowed: the record button that started this turn was the
  // gesture. The catch is for the clip being torn down before it ever started.
  audioEl.play().catch((e) => dbg(`audio play: ${e.message || e}`));
}

function pushClipChunk(msg) {
  // An id that is not the one being received belongs to a clip that has been cut
  // off. The server commits to a whole clip the moment it sends the first byte,
  // so its tail keeps arriving after the clip replacing it has started.
  if (!incoming || msg.id !== incoming.id) return;
  const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
  if (incoming.queue) incoming.queue.push(bytes);
  else incoming.chunks.push(bytes);
}

async function endClip(msg) {
  if (!incoming || msg.id !== incoming.id) return;
  const clip = incoming;
  incoming = null;
  if (clip.queue) { clip.queue.finish(); return; }
  await playBuffered(clip.chunks, clip.nextState, clip.pitch);
}

// The fallback, and the path this took for every clip before Fish was asked to
// send as it synthesizes. decodeAudioData needs the complete buffer, which is
// the whole reason MediaSource exists above.
async function playBuffered(chunks, nextState, pitch) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  dbg(`audio: ~${Math.round(total / 1024)}kb received`);
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  if (!total) {
    // Fish answers 200 with an empty body occasionally. decodeAudioData would
    // throw on it and the handoff would be lost with the error, stranding the
    // HUD of a build that is already running.
    dbg("audio: empty clip");
    clipEnded(handoffAfterPreempt(stopPlayback(), nextState));
    return;
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  const buf = await audioCtx.decodeAudioData(bytes.buffer);

  const handoff = handoffAfterPreempt(stopPlayback(), nextState);
  if (holding) {
    dbg("audio dropped: the button is held");
    if (handoff) setState(stateAfterClip(handoff));
    return;
  }

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  // Unlike the streamed path's <audio> element, an AudioBufferSourceNode has a
  // real detune AudioParam -- no preservesPitch workaround needed here.
  src.detune.value = centsForPitch(pitch);
  if (src.detune.value !== 0) dbg(`pitch: detune ${src.detune.value}c (buffered)`);
  const an = audioCtx.createAnalyser();
  an.fftSize = 512;
  an.smoothingTimeConstant = 0.78;
  src.connect(an); an.connect(ensureGain());
  analyser = an;
  freqBins = new Uint8Array(an.frequencyBinCount);
  timeBins = new Uint8Array(an.fftSize);
  playbackSource = src;
  playbackHandoff = handoff;
  refreshCancel();
  setState("speaking");
  dbg(`playing ${buf.duration.toFixed(1)}s`);
  src.onended = () => clipEnded(handoff);
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
