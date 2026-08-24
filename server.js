import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadFishConfig } from "./lib/config.js";
import { ask, askResilient, buildPersona } from "./lib/brain.js";
import { speak } from "./lib/tts.js";
import { parseAction } from "./lib/action.js";
import { loadRegistry } from "./lib/registry.js";
import { describeFailure } from "./lib/outcome.js";
import { run as runBuild } from "./lib/builder.js";
import {
  loadStore, saveStore, getProject, touchProject, recordArtifact, applyMemoryTag,
} from "./lib/memory.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const BUILDS = join(HERE, "builds"); // one folder per build, created by lib/builder.js
const BUILDS_URL = "/builds/";
const PORT = Number(process.env.PORT) || 3210;
const WG_IP = "192.168.82.1";

// Only these two spellings of "this machine" are served, and only these two are
// allowed to open the socket. Both lists are built from PORT so moving the
// server does not quietly disable the checks below.
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`,
  `0.0.0.0:${PORT}`,
  `[::1]:${PORT}`,
  `${WG_IP}:${PORT}`
]);

const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://0.0.0.0:${PORT}`,
  `http://${WG_IP}:${PORT}`
]);

const cfg = loadFishConfig(); // throws early if Fish key missing

// Read once, at startup. A primitive is a file on disk, so re-reading the folder
// per request would let a half-saved edit break a live conversation. Loading it
// here also turns a typo in someone's brand-new primitive into a startup error
// naming the file, rather than a silence in the middle of a conversation.
const registry = await loadRegistry();

// What earlier runs left behind. One server serves one project, so the whole
// store is keyed by the directory it was started in. Read once here; every
// write below goes through saveStore, which is atomic.
const memoryStore = loadStore();
const PROJECT_KEY = process.cwd();

// The assistant can only ask for a build it has been told exists, so the persona
// is derived from the registry that was just loaded rather than written by hand.
// Without this the chat model runs on the no-builds default and politely refuses
// every build request, which looks like a broken model rather than a miswiring.
// It also carries what is remembered about this project, which is why it is a
// `let`: the prompt is rebuilt whenever memory changes. Without refreshPersona
// the whole memory feature would appear to work and only take effect after a
// restart, with nothing anywhere reporting why. Caveat: a --resume'd CLI session
// keeps the system prompt it started with, so a refreshed persona is guaranteed
// to reach the model on the next cold start rather than on the next turn.
let persona = buildPersona(registry, getProject(memoryStore, PROJECT_KEY));

function refreshPersona() {
  persona = buildPersona(registry, getProject(memoryStore, PROJECT_KEY));
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

// Serving files by path is where a static server gets broken into: "/../lib/x"
// and its percent-encoded twin both mean "read something above the folder I am
// allowed to read from". join() walks out of the root quite happily, so the
// resolved path is checked against the root before anything is opened. Returns
// null for anything that escapes, which the caller answers with 403.
function fileWithin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent escape
  }
  if (decoded.includes("\0")) return null; // fs throws on these rather than reporting them
  const full = resolve(join(root, decoded));
  return full === root || full.startsWith(root + sep) ? full : null;
}

// Listening on 127.0.0.1 keeps other machines out; it does not keep other NAMES
// out. Anyone can point a hostname they own at 127.0.0.1, and a page served from
// that name would then be talking to this server from inside the reader's own
// browser — reading public/ and builds/ across what the browser believes is a
// same-origin boundary. The Host header carries the name that was asked for, so
// checking it is what closes that door.
function hostAllowed(host) {
  return typeof host === "string" && ALLOWED_HOSTS.has(host.toLowerCase());
}

const server = createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host)) {
    log(`http refused host=${JSON.stringify(req.headers.host ?? null)}`);
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  const urlPath = (req.url ?? "/").split("?")[0];
  // Two roots, one containment rule: the app's own files, and the read-only
  // artifacts a build wrote, so a finished page can be opened in the browser.
  const isBuild = urlPath.startsWith(BUILDS_URL);
  const root = isBuild ? BUILDS : PUBLIC;
  const rel = isBuild
    ? urlPath.slice(BUILDS_URL.length - 1) // keep the leading slash
    : urlPath === "/" ? "/index.html" : urlPath;

  const file = fileWithin(root, rel);
  if (!file) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const buf = await readFile(file);
    const headers = { "Content-Type": MIME[extname(file)] || "application/octet-stream" };
    if (isBuild) {
      // A built page is model-written HTML with model-written inline script,
      // served from the same origin as this app. `sandbox allow-scripts` drops
      // it into an opaque origin: the page still renders and its script still
      // runs, but it can no longer reach back into this origin to open the
      // control socket or read what another build wrote.
      headers["Content-Security-Policy"] = "sandbox allow-scripts";
    }
    res.writeHead(200, headers);
    res.end(buf);
  } catch { res.writeHead(404); res.end("not found"); }
});

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

// Every voice the assistant has goes through here, so a build question and a
// build result sound like the same character as a chat reply: caption first,
// then the audio the browser plays.
// `nextState` is where the orb should land once this clip finishes playing.
// Without it the client falls back to idle. It exists because a spoken line can
// hand off to a state rather than end a turn: the build confirmation is followed
// by the HUD, and sending `working` alongside the audio would race playback --
// the clip's own end would then fire idle and tear the HUD down mid-build.
async function say(send, text, nextState) {
  send({ type: "reply_text", text });
  const t = Date.now();
  const audio = await speak(text, cfg);
  const ms = Date.now() - t;
  log(`tts ok ${ms}ms ${audio.length}b`);
  send({ type: "debug", stage: "tts", ms, msg: `fish ${audio.length} bytes` });
  send({ type: "state", value: "speaking" });
  send({ type: "audio", format: cfg.format, data: audio.toString("base64"), nextState });
}

// Two things the assistant has to say in one breath sound like conversation;
// two separate clips with a synthesis gap between them sound like a machine
// reading a list. Used to fuse an acknowledgement onto the question that
// follows it.
function joinSpoken(...parts) {
  return parts.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean).join(" ");
}

// A primitive name arrives from the chat model, and an unknown one gets read
// aloud and written to the log. Keep it short and printable so a garbled tag
// cannot forge a log line or hand the voice a page of noise to pronounce.
const MAX_NAME = 40;
function readableName(text) {
  const clean = String(text).replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  return clean.slice(0, MAX_NAME);
}

// ---------------------------------------------------------------------------
// Build dispatch
// ---------------------------------------------------------------------------

// A build is a model with file-writing tools on, so the ceiling has to count
// every build on this machine rather than every build in one tab. Held at module
// scope for that reason: two open tabs are two sockets, and a per-socket guard
// would let each of them start one.
const MAX_BUILDS = 1;
let running = 0;

const slotFree = () => running < MAX_BUILDS;

// Check and claim in the same tick. Anything awaited between the two would let a
// second socket see the slot that a first one is already on its way to taking.
function claimSlot() {
  if (!slotFree()) return false;
  running++;
  return true;
}

function releaseSlot() {
  running = Math.max(0, running - 1);
}

const BUSY_LINE = "One build at a time, sir. Ask me again once this one lands.";

// "Unanswered" is generous on purpose. A tag can arrive as `subject=` with an
// empty value, and building a landing page about nothing is a worse outcome
// than one more spoken question.
function firstUnanswered(primitive, params) {
  return primitive.questions.find(
    (q) => typeof params[q.key] !== "string" || params[q.key].trim() === "",
  );
}

// Entry point from a chat turn that carried an action tag. `preamble` is what
// the model already said out loud about the request; it is fused onto whatever
// comes next so the turn is one utterance instead of two. The corrective paths
// below drop it deliberately -- an acknowledgement contradicts the correction.
async function dispatchAction(send, conv, action, preamble = "") {
  log(`action primitive=${JSON.stringify(action.primitive)} params=${JSON.stringify(action.params)}`);

  const primitive = registry.get(action.primitive);
  if (!primitive) {
    // A model can invent a primitive that was never installed. That is a thing
    // to say in character, not a thing to crash on.
    const name = readableName(action.primitive);
    log(`action unknown primitive=${JSON.stringify(action.primitive)}`);
    await say(send, name
      ? `I don't know how to build a ${name} yet, sir.`
      : "I'm not sure what you'd like me to build, sir.");
    return;
  }

  // Said early so nobody sits through a round of questions only to be turned
  // away at the end. The slot is not claimed here — the claim happens at the
  // moment the build actually starts, which is the only place it is safe.
  if (!slotFree()) {
    log(`build deferred primitive=${primitive.id} (one already running)`);
    await say(send, BUSY_LINE);
    return;
  }

  await advance(send, conv, primitive, { ...action.params }, preamble);
}

// Ask for the next missing answer, or start the build once nothing is missing.
// One question per turn: the answer arrives as the next thing the person says.
async function advance(send, conv, primitive, params, preamble = "") {
  const question = firstUnanswered(primitive, params);
  if (question) {
    conv.pending = { primitive, params, key: question.key };
    send({ type: "ask", text: question.ask });
    // Spoken as well as sent, because the person is listening rather than
    // reading the screen -- and fused to the acknowledgement so "of course,
    // sir" and the question arrive as one sentence.
    await say(send, joinSpoken(preamble, question.ask));
    return;
  }
  await build(send, primitive, params, preamble);
}

async function build(send, primitive, params, preamble = "") {
  // The real guard. Answering a question takes as long as the person takes, so
  // the check in dispatchAction can be minutes stale by the time a build starts
  // and another tab may have taken the slot in between.
  if (!claimSlot()) {
    log(`build refused primitive=${primitive.id} (one already running)`);
    await say(send, joinSpoken(preamble, BUSY_LINE));
    return;
  }

  let started = Date.now();
  let outcome;
  try {
    // Confirm out loud BEFORE the HUD takes over. Someone who just answered a
    // question needs to hear that the answer landed; a silent jump to the build
    // readout reads as the assistant ignoring them. `nextState` hands the orb to
    // the HUD when this line finishes rather than racing it.
    const kickoff = typeof primitive.startLine === "function"
      ? primitive.startLine(params)
      : "Starting now, sir.";
    await say(send, joinSpoken(preamble, kickoff), "working");

    started = Date.now();
    log(`build start primitive=${primitive.id} params=${JSON.stringify(params)}`);
    outcome = await runBuild(primitive, params, (line) => send({ type: "progress", line }));
  } finally {
    // Released the moment the CLI is done and before a word is spoken about it,
    // so a Fish outage — while announcing the start or while reporting the
    // result — cannot leave the slot claimed and lock the machine out of ever
    // building again.
    releaseSlot();
  }

  const ms = Date.now() - started;
  const dir = basename(outcome.dir);
  log(`build finish primitive=${primitive.id} ok=${outcome.ok} ${ms}ms dir=${dir}`);

  if (outcome.ok) {
    // The basename, never the absolute path: it is the same token the /builds/
    // route uses, and it keeps a home directory out of a file whose contents are
    // read back into a system prompt on every future turn.
    recordArtifact(memoryStore, PROJECT_KEY, {
      primitive: primitive.id,
      dir,
      outputContract: primitive.outputContract,
    });
    saveStore(memoryStore);
    refreshPersona();

    await say(send, primitive.doneLine(params));
    // Served by the /builds/ route above. Encoded because a primitive's output
    // contract is a filename, and filenames are allowed to contain spaces.
    send({ type: "open", url: encodeURI(`${BUILDS_URL}${dir}/${primitive.outputContract}`) });
    // No "idle" here. say() returns once the audio has been SENT, not once it has
    // been heard, and the browser handles each message as it arrives — so an idle
    // sent now lands while the done-line is still playing and drops the orb dead
    // mid-sentence. Playback ending is what returns it to idle.
    return;
  }

  // builder.run() reports an outcome rather than an exit code. A terminal result
  // event that is not an error means the CLI finished its turn cleanly, which is
  // what an exit code of 0 tells describeFailure — and it is the difference
  // between "the build stopped" and the far more useful "the build finished but
  // never wrote index.html".
  const code = outcome.result && outcome.result.is_error !== true ? 0 : undefined;
  const trouble = describeFailure({
    code,
    dir: outcome.dir,
    outputContract: primitive.outputContract,
    result: outcome.result,
    timedOut: outcome.timedOut,
    // Only a chain sets this; a single-shot outcome has no such key, and
    // describeFailure leaves the sentence alone when it is absent.
    failedStep: outcome.failedStep,
  }) || "The build did not finish.";

  await say(send, `${trouble} Nothing is broken, sir. Say the word and I'll try again.`);
  // The log path is the one thing worth reading afterwards, so it goes on screen
  // rather than into the spoken line.
  send({ type: "error", message: outcome.log ? `${trouble} Full log: ${outcome.log}` : trouble });
  send({ type: "state", value: "idle" });
}

// ---------------------------------------------------------------------------
// End-of-session summary
// ---------------------------------------------------------------------------

// Its own bookkeeping voice, deliberately not the JARVIS persona: the spoken
// rules -- forty words, no lists, address Jesse as sir -- would shape a note
// nobody is ever going to hear into something shorter and vaguer than the next
// session needs.
const SUMMARY_PERSONA =
  "You are keeping notes in a voice assistant's memory file, for your own use in a later " +
  "session. In two or three plain sentences, record what this conversation was about and what " +
  "is worth carrying forward: what was built, what was asked for, what was decided. Write it " +
  "as notes, not as speech. No greeting, no persona, no markdown, no questions.";

// Below this a conversation is "what's the weather" and a summary is worse than
// nothing -- it would overwrite a real one from earlier in the day.
const SUMMARY_MIN_TURNS = 3;

// Module scope, not per-socket: a page that reloads in a loop would otherwise
// start a summary process per reload, each one a real CLI invocation.
let summarizing = false;

// Fire and forget by design. Nothing is awaited, nothing is sent to the socket
// (it is closing or gone), and every error is swallowed into the log -- a failed
// note is not worth a visible failure, and there is nobody left to tell.
function summarizeOnClose(sessionId, turns) {
  if (!sessionId || turns < SUMMARY_MIN_TURNS || summarizing) return;
  summarizing = true;

  ask("Summarize this conversation for your own notes.", sessionId, { persona: SUMMARY_PERSONA })
    .then(({ reply }) => {
      if (!reply) return;
      // The session id this call returns is deliberately thrown away. Storing it
      // would put "Summarize this conversation for your own notes" at the head
      // of whatever gets resumed next.
      touchProject(memoryStore, PROJECT_KEY, { summary: reply });
      saveStore(memoryStore);
      refreshPersona();
      log(`memory summary saved (${reply.length} chars)`);
    })
    .catch((e) => log("memory summary skipped:", e.message || e))
    .finally(() => { summarizing = false; });
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

// A WebSocket is exempt from the same-origin policy: any page, in any tab, can
// open a socket to a port on this machine and start talking. With no check on
// who opened it, a page the reader merely visits could start a build here — a
// model with file-writing tools, on their machine, with no click and nothing
// visible — and read the whole conversation back, absolute paths included.
// Origin is the one header a page cannot forge, because the browser sets it, so
// it is the check. A MISSING Origin is refused as well: a browser always sends
// one, so its absence means the request did not come from a page at all.
function originAllowed(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.has(origin.toLowerCase());
}

const wss = new WebSocketServer({
  noServer: true, // the upgrade is accepted below, after the origin is checked
  // The default ceiling is 100MB per message, and a message's text is handed to
  // a subprocess. Speech is short; this is far more room than a sentence needs.
  maxPayload: 64 * 1024,
});

server.on("upgrade", (req, socket, head) => {
  if (!originAllowed(req.headers.origin)) {
    log(`ws refused origin=${JSON.stringify(req.headers.origin ?? null)}`);
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

const sessions = new Map(); // ws -> sessionId

wss.on("connection", (ws) => {
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  // Per-tab state, held in this connection's closure rather than a global map,
  // so it cannot outlive the socket. `pending` is the question waiting on an
  // answer. The one-build-at-a-time guard is deliberately NOT here: it counts
  // builds on the machine, and two tabs are two of these closures.
  const conv = { pending: null, turns: 0 };

  // Read fresh from the store rather than from a boot-time snapshot: a second
  // tab opened mid-conversation has to join the session that is current now, not
  // the one that existed when the server started.
  const remembered = getProject(memoryStore, PROJECT_KEY)?.sessionId;
  if (remembered) sessions.set(ws, remembered);

  log("client connected");
  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== "say" || !msg.text?.trim()) return;
    log("say:", JSON.stringify(msg.text));
    send({ type: "debug", stage: "stt", msg: `heard "${msg.text}"` });
    try {
      // An outstanding question owns the next thing said: it is an answer, not a
      // new turn, so it goes to the build rather than to the chat model.
      if (conv.pending) {
        const { primitive, params, key } = conv.pending;
        conv.pending = null;
        const answer = msg.text.trim();
        log(`answer ${primitive.id} ${key}=${JSON.stringify(answer)}`);
        send({ type: "debug", stage: "ask", msg: `${key} = "${answer}"` });
        await advance(send, conv, primitive, { ...params, [key]: answer });
        return;
      }

      send({ type: "state", value: "thinking" });
      const tb = Date.now();
      // askResilient, not ask: a remembered session id can have expired since it
      // was written, and the first turn after a page load is exactly where that
      // shows up. It retries once from cold rather than failing the turn.
      const { reply: spoken, sessionId, recovered } =
        await askResilient(msg.text, sessions.get(ws), { persona });
      const bms = Date.now() - tb;
      if (recovered) log("brain recovered from an unresumable session id");
      sessions.set(ws, sessionId);
      conv.turns += 1;
      // Persisted every turn, because this id is what the next page load resumes
      // from -- and after a recovery it is what replaces the dead one.
      touchProject(memoryStore, PROJECT_KEY, { sessionId });
      saveStore(memoryStore);
      // The model may append machine-readable tags: one asking for a build, one
      // recording a standing preference. Split them off first -- a tag is for
      // dispatch, never for the voice.
      const { reply, action, memory } = parseAction(spoken);

      // Applied before dispatch, with nothing awaited in between: "make it dark
      // from now on and build me a landing page" has to have the preference on
      // disk before the build starts reading it. The two tags are independent;
      // both apply. applyMemoryTag does its own sanitizing and capping, so what
      // it returns is only what actually survived.
      if (memory) {
        const saved = applyMemoryTag(memoryStore, PROJECT_KEY, memory);
        if (saved) {
          saveStore(memoryStore);
          refreshPersona();
          log(`memory set ${JSON.stringify(saved)}`);
        }
      }
      log(`brain ok ${bms}ms session=${sessionId} reply=${JSON.stringify(reply)}` +
          (action ? ` action=${JSON.stringify(action.primitive)}` : ""));
      send({ type: "debug", stage: "brain", ms: bms, msg: `claude: "${reply}"` });
      // With a build to dispatch, the reply is not spoken on its own: it is
      // handed down as a preamble and fused onto the question (or the kickoff)
      // so the whole turn is one utterance. Speaking it here would add a second
      // clip and a synthesis gap to every build request.
      if (action) {
        await dispatchAction(send, conv, action, reply);
      } else if (reply) {
        await say(send, reply);
      } else {
        log("brain returned no speakable text");
      }
    } catch (e) {
      // Narrowed to sessionExhausted on purpose: a dead session must not survive
      // as a stored id, or the next tab resumes it and fails the same way. Any
      // other failure -- a Fish outage, say -- must not cost the conversation
      // its context.
      if (e.sessionExhausted) {
        sessions.delete(ws);
        touchProject(memoryStore, PROJECT_KEY, { sessionId: null });
        saveStore(memoryStore);
      }
      log("ERROR:", e.message || e);
      send({ type: "debug", stage: "error", msg: String(e.message || e) });
      send({ type: "error", message: String(e.message || e) });
      send({ type: "state", value: "idle" });
    }
  });
  ws.on("close", () => {
    // Read before the delete: this map is the only handle on the id, and the
    // summary below still needs it.
    const sessionId = sessions.get(ws);
    sessions.delete(ws);
    conv.pending = null;
    // A build already running is left to finish: it has been paid for and its
    // artifact still lands on disk. Nothing here points back at this socket
    // afterwards, and send() is a no-op once the socket is gone, so a progress
    // update arriving late has nowhere to go rather than something to break.
    log("client disconnected");
    summarizeOnClose(sessionId, conv.turns);
  });
});

// A port already in use is the single most common way starting this fails, and
// an unhandled EADDRINUSE prints a stack trace that says nothing about what to
// do next.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use — stop the other server or run PORT=${PORT + 1} node server.js`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});

// Loopback only. This process runs a model with file-writing tools on and then
// serves what it wrote, which is not something to expose to the local network.
server.listen(PORT, "0.0.0.0", () => {
  const ids = [...registry.keys()];
  console.log(`Jarvis on http://0.0.0.0:${PORT}`);
  console.log(`primitives: ${ids.length ? ids.join(", ") : "none"}`);
});
