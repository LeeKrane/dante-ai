// Cross-session messaging: writing into a running Claude Code session's own
// input stream from outside it — the same channel a person uses when they
// type into that session's terminal while it is mid-turn.
//
// lib/spawn-session.js's tellSession already reaches another session, but
// coldly: it starts a fresh `claude -p --resume` process and waits for one
// answer. This is the other kind of reach. The target session is already
// running, and CLI 2.1.246 exposes a local channel for it (it calls the
// mechanism "uds-messaging"): every live session listens on a unix domain
// socket for newline-delimited JSON frames, and a "now"-priority frame
// interrupts the turn in flight rather than waiting behind it. Verified
// live — a counting session was interrupted mid-count, did the injected
// instruction, and resumed counting, same pid throughout.
//
// None of this is documented by the CLI. It was established empirically
// against a live 2.1.246 and is written down here as fact, the same way
// lib/agents.js's parseRoster is built from what a live `claude agents --json`
// actually printed rather than from a spec.
//
// Split the usual way: everything up to sendToSession is pure and holds the
// interesting decisions (what counts as a real token, a real uuid, a real
// socket path); sendToSession is the thin impure caller, with opts.connect as
// the seam a test points at a real unix socket server instead of a live CLI.

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MAX_BRIEF_CHARS, cleanBrief } from "./interview.js";

// The CLI's own vocabulary for where a frame lands in a session's queue.
// "now" is what makes this module different from tellSession: that one waits
// its turn behind whatever the session is already doing, and this one can cut
// in front of it.
export const PRIORITIES = new Set(["now", "next", "later"]);

// The CLI's own default when priority is absent or unrecognised, so it is the
// default here too — an unrecognised priority should behave exactly as if
// nothing had been said about one.
export const DEFAULT_PRIORITY = "next";

// A message written into this channel used to be a sentence or two -- a
// steered instruction, authored by a model or spoken through one -- and this
// module capped it at MAX_MESSAGE_CHARS, sized like lib/spawn-session.js's
// MAX_TASK_CHARS and lib/slack.js's MAX_TEXT_CHARS: budgets for a sentence,
// unrelated to lib/interview.js's MAX_BRIEF_CHARS on purpose, because nothing
// landing here was ever meant to be a document.
//
// That stopped being true once server.js's dispatchTell started handing this
// channel a session's whole brief on a tell or an interrupt that needed the
// interview: a flattening, 2000-char cap would fuse a brief's Goal/Where/
// Constraints/Done-when sections into one run-on line and cut most of it off.
// So the brief's own cap and cleaner apply here instead -- cleanBrief and
// MAX_BRIEF_CHARS, imported from lib/interview.js -- and this module keeps no
// cap of its own any more. That is safe on the wire: encodeFrames
// JSON.stringifies every frame before it is written to the socket, so a line
// break in the content is an escaped `\n` inside one JSON string, not
// something that could be read as a second frame.

// Generous enough for a real unix socket connect on a live machine; short
// enough that a session with a dead or wedged socket does not hold a turn
// open waiting on it. Same shape as spawn-session's STARTUP_MS and slack's
// POST_TIMEOUT_MS.
export const CONNECT_TIMEOUT_MS = 2000;

// The shape --session-id and --resume already require elsewhere in this
// codebase, redeclared here rather than imported because this module's
// reasons to change are its own.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A peerToken as the CLI writes it: 32 lowercase hex characters.
const TOKEN = /^[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

// buildAuthFrame(token) -> the first line every connection must send, or null.
//
// Null rather than a throw, for the same reason buildStartArgs in
// lib/spawn-session.js documents: every reason this cannot be built is a
// refusal a caller has to act on, not an exception to unwind past.
export function buildAuthFrame(token) {
  return typeof token === "string" && TOKEN.test(token) ? { type: "auth", token } : null;
}

// buildMessageFrame(spec) -> the frame that actually lands in the session, or
// null. `spec` is { sessionId, text, priority?, uuid? }.
export function buildMessageFrame(spec = {}) {
  const sessionId = typeof spec.sessionId === "string" ? spec.sessionId : "";
  if (!UUID.test(sessionId)) return null;

  const text = cleanBrief(spec.text, MAX_BRIEF_CHARS);
  if (!text) return null;

  const priority = PRIORITIES.has(spec.priority) ? spec.priority : DEFAULT_PRIORITY;

  // A caller-supplied uuid is checked, not trusted — it is replaced rather
  // than passed through malformed, the same posture buildStartArgs takes
  // toward a spec.sessionId that isn't one.
  const uuid = typeof spec.uuid === "string" && UUID.test(spec.uuid) ? spec.uuid : randomUUID();

  return { type: "user", session_id: sessionId, message: { content: text }, priority, uuid };
}

// encodeFrames(frames) -> the newline-delimited JSON string the socket wants.
//
// This is the one place that knows the wire format is line-delimited. A null
// or non-object entry is dropped rather than failing the whole batch, because
// callers build a frame list with buildAuthFrame/buildMessageFrame results
// that can themselves be null.
export function encodeFrames(frames) {
  if (!Array.isArray(frames)) return "";
  return frames
    .filter((frame) => frame !== null && typeof frame === "object" && !Array.isArray(frame))
    .map((frame) => `${JSON.stringify(frame)}\n`)
    .join("");
}

// A plain interrupt that says only the new thing tends to read, to the
// session receiving it, as a brand new request rather than a correction to
// the one already running — it stops and answers instead of carrying on.
// Naming that this is a steer rather than a task is what keeps the turn in
// flight intact.
const STEER_SUFFIX = "This is a change of instruction to fold into the work already in progress, not a new task.";

// steerText(text) -> the content string for a "now"-priority interrupt, or ""
// for text that cleans to nothing.
//
// The cap applies to the caller's text alone — it is cleaned and capped
// first, and STEER_SUFFIX is appended after, uncounted. The sentence is what
// makes the interruption legible; capping it away with the rest would defeat
// the reason it's there.
export function steerText(text) {
  const cleaned = cleanBrief(text, MAX_BRIEF_CHARS);
  if (!cleaned) return "";
  // The instruction arrived as speech, and speech does not carry its own full
  // stop. Without one the suffix runs straight on from the last word -- "run
  // the tests This is a change of instruction" -- which reaches the session
  // being steered as a single garbled sentence rather than as two.
  const stopped = /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
  return `${stopped} ${STEER_SUFFIX}`;
}

// planDelivery(verb, text) -> { priority, content }, or null when there is
// nothing to send.
//
// The whole difference between the two verbs, in one pure function, so that
// server.js stays wiring: `tell` waits its turn behind whatever the session is
// already doing, `interrupt` cuts in front of it and says so. Everything else
// about the two paths -- resolving the name, the proposal, the fallback -- is
// identical, and this is the only place that has to know which was asked for.
export function planDelivery(verb, text) {
  const interrupt = typeof verb === "string" && verb.toLowerCase() === "interrupt";
  const content = interrupt ? steerText(text) : cleanBrief(text, MAX_BRIEF_CHARS);
  if (!content) return null;
  return { priority: interrupt ? "now" : DEFAULT_PRIORITY, content };
}

// vetSocketPath(path, pid) -> path, or null.
//
// messagingSocketPath is read out of a JSON file on disk, so nothing about it
// is trusted merely for having come from there — a tampered or stale state
// file would otherwise point Dante's write at an arbitrary unix socket
// anywhere on the machine. What's checked is the CLI's own naming convention
// for the file, not that a socket happens to exist at the path: only a path
// shaped the way the CLI actually lays these out is allowed through.
export function vetSocketPath(path, pid) {
  if (typeof path !== "string" || path === "" || !path.startsWith("/")) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  // The CLI moves a socket aside under this name when the automatic path
  // collides with one already in use.
  const name = basename(path);
  const movedAside = new RegExp(`^${pid}-[0-9a-f]{8}\\.sock$`);
  if (name !== `${pid}.sock` && !movedAside.test(name)) return null;

  // cc-socks-<digits> is the /tmp fallback the CLI uses when XDG_RUNTIME_DIR
  // would make the socket path too long for the platform's limit.
  const parent = basename(dirname(path));
  if (parent !== "cc-socks" && !/^cc-socks-\d+$/.test(parent)) return null;

  return path;
}

// ---------------------------------------------------------------------------
// Finding a session's address
// ---------------------------------------------------------------------------

// readPeerAddress(pid, opts) -> { socketPath, sessionId, token, features }, or
// null. Never throws: a missing state file, an unreadable one, malformed
// JSON, a missing key file, a malformed token, and a socket path that fails
// vetting all degrade to null — the posture loadStore in lib/memory.js and
// parseRoster in lib/agents.js already take toward a file or a listing this
// process does not control.
//
// `opts.home` overrides homedir() and is the test seam.
export async function readPeerAddress(pid, opts = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const home = typeof opts.home === "string" && opts.home !== "" ? opts.home : homedir();
  const sessionsDir = join(home, ".claude", "sessions");

  let state;
  try {
    state = JSON.parse(readFileSync(join(sessionsDir, `${pid}.json`), "utf8"));
  } catch {
    return null;
  }
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;

  const sessionId = typeof state.sessionId === "string" ? state.sessionId : "";
  if (!UUID.test(sessionId)) return null;

  const socketPath = vetSocketPath(state.messagingSocketPath, pid);
  if (!socketPath) return null;

  // There is no field in the state file naming the key file — its filename
  // carries a 64-hex fingerprint the state file doesn't repeat — so it is
  // found by listing the directory and matching the shape rather than read
  // straight off a property.
  let entries;
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  const keyPattern = new RegExp(`^${pid}\\.[0-9a-f]{64}\\.key$`);
  const keyFile = entries.find((entryName) => keyPattern.test(entryName));
  if (!keyFile) return null;

  let key;
  try {
    key = JSON.parse(readFileSync(join(sessionsDir, keyFile), "utf8"));
  } catch {
    return null;
  }
  if (typeof key !== "object" || key === null || Array.isArray(key)) return null;

  // token is a credential — it is the entire authentication for writing into
  // somebody's live session — and it takes the posture lib/slack.js takes
  // toward the Slack bot token: never logged, never crossing the WebSocket to
  // a browser, and never handed to a model in a prompt.
  const token = typeof key.peerToken === "string" ? key.peerToken : "";
  if (!TOKEN.test(token)) return null;

  // The key file also carries procStart, which would let a caller prove this
  // pid has not been recycled since the state file was written. This module
  // deliberately does not use it: sendToSession checks sessionId instead,
  // which comes from the very roster listing (parseRoster) that produced the
  // pid in the first place, so the two are already guaranteed to name the
  // same session by construction — procStart would only be re-deriving a
  // check the caller already gets for free.
  const features =
    Array.isArray(state.peerFeatures) && state.peerFeatures.every((f) => typeof f === "string")
      ? state.peerFeatures
      : [];

  return { socketPath, sessionId, token, features };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

// sendToSession(spec, opts) -> Promise<{ ok, error? }>. Never rejects, for the
// same reason startSession and tellSession don't: every failure here is a
// sentence someone will hear out loud rather than an exception a caller has
// to remember to catch.
//
// `ok: true` means the frames were written to the session's socket and the
// connection closed cleanly — nothing more. The CLI sends no acknowledgement
// for a user frame, so this cannot and does not report that the model read
// the message or acted on it. That gap is the difference between "passed on"
// and "done", and this function only ever claims the former.
export function sendToSession(spec = {}, opts = {}) {
  return readPeerAddress(spec.pid, opts).then(
    (address) => deliverTo(address, spec, opts),
    () => ({ ok: false, error: "that session is not reachable" }),
  );
}

function deliverTo(address, spec, opts) {
  if (!address) return { ok: false, error: "that session is not reachable" };

  // Pids are recycled by the operating system. Without this check a stale or
  // reused pid could deliver a message into a session nobody asked to reach,
  // so the roster's pid and the state file's own session id must agree before
  // anything is written into somebody's live session.
  if (typeof spec.sessionId === "string" && spec.sessionId !== "" && spec.sessionId !== address.sessionId) {
    return { ok: false, error: "that is not the session I meant" };
  }

  const auth = buildAuthFrame(address.token);
  const message = buildMessageFrame({ sessionId: address.sessionId, text: spec.text, priority: spec.priority });
  if (!auth || !message) return { ok: false, error: "there was nothing to pass on" };

  const payload = encodeFrames([auth, message]);
  const doConnect = typeof opts.connect === "function" ? opts.connect : netConnect;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : CONNECT_TIMEOUT_MS;

  return new Promise((resolvePromise) => {
    let settled = false;
    let socket;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolvePromise(result);
    };

    const deadline = setTimeout(() => {
      // The socket is destroyed on timeout rather than left to resolve on its
      // own: a wedged peer must not hold this process's event loop, or the
      // pipe, open past the window the caller was promised.
      socket?.destroy();
      finish({ ok: false, error: "that session did not answer in time" });
    }, timeoutMs);
    deadline.unref?.();

    try {
      socket = doConnect(address.socketPath);
    } catch {
      finish({ ok: false, error: "could not reach that session" });
      return;
    }

    // A connect failure (no such socket, permission denied, nothing
    // listening) surfaces as "error", not as "close" — listening for both is
    // what keeps a bad path from being reported as a clean send.
    socket.on("error", () => finish({ ok: false, error: "could not reach that session" }));
    socket.on("connect", () => socket.end(payload));
    socket.on("close", () => finish({ ok: true }));
  });
}
