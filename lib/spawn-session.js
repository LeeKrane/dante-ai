// Starting a real Claude Code session, detached, in one of your repositories.
//
// This is the first thing in the codebase that starts a session Dante does not
// then own. It runs under your settings, your permissions, your hooks and your
// MCP servers — the same session you would have started by typing `claude` in
// that directory, because that is what was asked for. lib/builder.js is not
// touched and not reused: a build is sandboxed by a deny list and a session
// deliberately is not, and merging the two would put deny-list machinery on a
// path that has none.
//
// The split is the usual one. buildStartArgs is pure and holds every decision
// about what reaches the command line; startSession is the thin impure caller.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { MAX_BRIEF_CHARS, cleanBrief } from "./interview.js";
import { positiveMs, runCli } from "./run-cli.js";
import { asPid, listAgents, matchStarted } from "./agents.js";

// A spoken task is a sentence or two. The cap is not tidiness: this string is
// authored by a model, in a tag, from speech, and it ends up as a command-line
// argument.
export const MAX_TASK_CHARS = 600;

// Re-export so callers of spawn-session need not know where it lives.
export { MAX_BRIEF_CHARS };

// An appended system prompt comes from a session kind in this repository rather
// than from anything spoken, so the cap here is a backstop against a kind with
// a runaway template, not a trust boundary.
const MAX_PROMPT_CHARS = 8000;

// A session's answer to a follow-up is read out loud, so it is clipped to
// something someone would sit through. The session itself is not limited by
// this; only what is repeated back is.
export const MAX_REPLY_CHARS = 700;

// How long a session gets to fail before it is reported as started. A `--bg`
// session returns almost immediately; what this window catches is the CLI
// refusing outright — an unknown flag, a bad model name, a login that expired.
export const STARTUP_MS = 2500;

// Same class lib/memory.js and lib/agents.js strip, redeclared for the same
// reason. Control characters in an argv token can forge structure in anything
// that later renders the command, and bidi overrides make a task read one way
// on screen and another to the process.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Flags that would remove every guardrail from a session started by voice.
//
// Voice is a lossy channel. A misheard sentence must never be able to produce
// one of these, so no code path builds them and this list is checked against
// the finished argv as well. If you want that mode you type it in a terminal,
// where you can see what you asked for.
const FORBIDDEN = [/^--dangerously/i, /^--permission-mode$/i, /^bypasspermissions$/i];

// Whitespace is collapsed BEFORE the unprintables are stripped, and the order
// is the whole point: a newline is both, and stripping it first fuses the words
// on either side into "fix the teststhen push". Collapsing first turns it into
// the space it was standing in for, and the strip then takes what is left.
function clean(value, maxChars) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

// A value that could be read as a flag is refused rather than escaped. Nothing
// here is a shell — spawn takes an argv array, so there is no quoting to get
// wrong — but a model-authored value beginning with "-" would still be read by
// the CLI as an option, and that is the whole class of problem to shut.
function safeValue(value, maxChars) {
  const cleaned = clean(value, maxChars);
  return cleaned && !cleaned.startsWith("-") ? cleaned : "";
}

// The CLI wants a uuid for --session-id, and Dante assigns it rather than
// scraping it back out of the output later. Checked rather than trusted: the
// caller is expected to hand over what newSessionId() produced.
//
// It still gets passed to a `--bg` start even though the CLI (2.1.258)
// ignores it there and mints its own id instead -- warning on stderr rather
// than refusing, so this is not something buildStartArgs can detect or work
// around. The flag stays on the command line on the chance a future CLI
// honours it again; parseStartedId below is what actually recovers the id in
// the meantime.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newSessionId() {
  return randomUUID();
}

// buildStartArgs(spec) -> argv, or null when the request is not startable.
//
// Null rather than a throw, because every reason to refuse is a sentence to say
// out loud — "I need to know which repository", "there was no task in that" —
// and a caller that has to catch to find out is a caller that will forget.
//
// `spec` is { name, sessionId, task, brief?, systemPrompt?, model?, effort? }.
export function buildStartArgs(spec = {}) {
  const name = safeValue(spec.name, 60);
  const task = clean(spec.task, MAX_TASK_CHARS);
  const sessionId = typeof spec.sessionId === "string" ? spec.sessionId : "";

  // A session with no task is a session with nothing to do, and one with no
  // name cannot be referred to again by voice — which is the entire point.
  if (!name || !task || !UUID.test(sessionId)) return null;

  const args = ["--bg", "-n", name, "--session-id", sessionId];

  const model = safeValue(spec.model, 60);
  if (model) args.push("--model", model);

  const effort = safeValue(spec.effort, 20);
  if (effort) args.push("--effort", effort);

  const systemPrompt = clean(spec.systemPrompt, MAX_PROMPT_CHARS);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  // The task is the session's name and what is spoken back to the person; the
  // brief is what the session actually reads. When there is a
  // brief, it is the prompt and the task is only the label. cleanBrief, not
  // clean: the task stays one line because it is a name and gets spoken, but
  // the brief is a document and its line breaks are its sections (Goal,
  // Where, Constraints, Done when). It still sits after the `--` terminator
  // below, so no line of it can be read as an option. FORBIDDEN's patterns
  // below are anchored with `^` and no `m` flag, so a multi-line brief is
  // checked against its first line only -- that is enough, because the brief
  // is one argv element after `--` and spawn is called with no shell, so
  // nothing later in it can ever become a token of its own the way a second
  // line could if this were a shell command string. Do not add the `m` flag:
  // that would make FORBIDDEN match a pattern on any line, and refuse a
  // perfectly ordinary brief that happens to quote or mention
  // "--permission-mode" as one of its lines rather than as its first argument.
  const brief = cleanBrief(spec.brief, MAX_BRIEF_CHARS);

  // A slash command, when there is one, is the whole prompt and nothing else
  // is: "/review high" followed by a brief would hand the brief to the skill
  // as more arguments, not to the session as instructions. It is one line by
  // construction (clean, not cleanBrief) for the same reason, and it arrives
  // here already vetted by lib/commands.js -- this only refuses the shape,
  // a line that does not start with a slash, since a command that lost its
  // slash on the way would be run as an ordinary sentence about a command.
  const command = clean(spec.command, MAX_TASK_CHARS);
  if (typeof spec.command === "string" && spec.command.trim() && !command.startsWith("/")) return null;

  // The prompt goes after the options terminator, always. Without it a task
  // that happens to start with a dash — or one a model wrote to look like a
  // flag — would be read as an option rather than as the thing to do.
  args.push("--", command || brief || task);

  // Belt and braces. Nothing above can produce one of these, and this is what
  // makes that a fact rather than an intention.
  if (args.some((arg) => FORBIDDEN.some((pattern) => pattern.test(arg)))) return null;

  return args;
}

// ---------------------------------------------------------------------------
// Reading the id back off stdout
// ---------------------------------------------------------------------------

// Strips every escape sequence a real terminal-writing CLI might emit, not
// only the colour codes the "backgrounded" line happens to use today: SGR
// codes (colour), the wider CSI vocabulary (cursor moves, clears — a busy
// build has been seen to emit a "hide cursor" before its first line), and OSC
// sequences (a terminal title, say), which end on BEL or ST rather than on a
// letter and so need their own alternative in the pattern.
const ANSI = /\x1b\[[\d;?]*[ -\/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

// The one id shape, shared with daemonId() (below) rather than redeclared
// there: a value beginning with anything else could not become either a
// `claude stop <id>` argument, or this one, safely, and the two functions
// disagreeing about what counts would be a bug neither test file could catch
// on its own. One constant makes that agreement a fact instead of an
// intention.
const ID_SHAPE = /^[A-Za-z0-9][\w.-]{0,99}$/;

// parseStartedId(stdout) -> id, or null when there was nothing to read.
//
// `claude --bg` prints exactly one line of confirmation before exiting --
// "backgrounded · <id> · <name>", colour codes around the id -- and that
// line is the only place the daemon's id is ever produced, because --bg
// ignores --session-id (see the comment on UUID above). Later lines name the
// same id again ("claude stop <id>    stop this session"), which is why this
// only ever reads the first line that opens with "backgrounded" rather than
// the first id-shaped token anywhere in the output.
//
// The separator is a middle dot today, but it is punctuation around a
// value, not part of the contract, so it is not matched literally: every
// character that is not a letter, digit, underscore, dot or hyphen is
// flattened to a space first. Dots and hyphens are left alone because they
// are legal *inside* both the id and the name ("dante-probe-1"), and
// flattening them would break "dante-probe-1" into three tokens instead of
// one.
export function parseStartedId(stdout) {
  if (typeof stdout !== "string") return null;
  const stripped = stdout.replace(ANSI, "");

  for (const rawLine of stripped.split("\n")) {
    const tokens = rawLine.replace(/[^\w.\s-]/g, " ").trim().split(/\s+/);
    if (tokens[0] !== "backgrounded" || tokens.length < 2) continue;
    // Refused rather than trimmed: a token beginning with "-" would be read
    // as a flag by daemonId's own regex, and quietly stripping the dash
    // would hand back an id that never belonged to this session.
    return ID_SHAPE.test(tokens[1]) ? tokens[1] : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Whether to start one at all
// ---------------------------------------------------------------------------

// Fifteen is a working ceiling rather than a technical one, same as it always
// was -- only the reasoning behind the number moved. The old ceiling of five
// was about a person: past it nobody could hold in their head what was
// running, and a roster read as one prose sentence stopped being sayable. A
// numbered line does not have that problem -- "session eleven" is exactly as
// sayable as "session two" -- so the ceiling now matches MAX_LISTED
// (lib/agents.js) and is about machine load rather than about naming.
export const MAX_SESSIONS = 15;

// refuseStart(request, context) -> the sentence to say instead, or null to go
// ahead.
//
// Pure, and it returns speech rather than an error code, because every refusal
// here is something a person is waiting to hear. `context.running` is counted
// from the roster rather than from a local tally: a session started in a
// terminal counts against the ceiling too, and one that died does not.
export function refuseStart(request = {}, context = {}) {
  const task = clean(request.task, MAX_TASK_CHARS);
  if (!task) return "I did not catch what that session should do, sir.";

  if (!context.workspace) {
    const known = Object.keys(context.workspaces ?? {});
    const named = clean(request.repo, 40);
    if (!named) {
      return known.length > 0
        ? `Which repository, sir? I know ${known.join(", ")}.`
        : "I do not know where to start that, sir. Tell me where a repository lives first.";
    }
    return known.length > 0
      ? `I do not know a repository called ${named}, sir. I know ${known.join(", ")}.`
      : `I do not know a repository called ${named}, sir.`;
  }

  const max = Number.isInteger(context.max) && context.max > 0 ? context.max : MAX_SESSIONS;
  const running = Number.isInteger(context.running) ? context.running : 0;
  if (running >= max) {
    // Naming the obvious one to stop is the difference between a refusal and a
    // dead end: the next thing the person says is "stop that one, then".
    const idle = clean(context.oldestIdle, 60);
    return idle
      ? `You already have ${max} sessions running, sir. ${idle} is idle if you want it stopped.`
      : `You already have ${max} sessions running, sir.`;
  }

  return null;
}

// startSession(spec, opts) -> Promise<{ ok, name, sessionId, shortId, startedAtMs, error }>.
// Never rejects.
//
// `sessionId` here is still the provisional uuid this call was given -- the
// one --bg ignores -- not the daemon's own id. `shortId` is what
// parseStartedId managed to read off stdout, or null when it could not: the
// CLI printed nothing recognisable, or never got as far as printing anything
// at all. Neither field is the daemon's full id; resolveStartedSession below
// is what turns a shortId into a roster record and that record's real
// sessionId. `startedAtMs` is this process's own clock, read just before
// spawn — the moment the caller should hand to resolveStartedSession as
// `since`, so its name-fallback bound is measured from when this session was
// actually asked for, not from whenever the caller happens to get around to
// resolving it.
//
// `spec.cwd` must already be a resolved workspace directory — see
// resolveWorkspacePath in lib/memory.js, which is where that check lives and
// where it must stay. This function does not second-guess it; it only refuses
// to spawn without one.
//
// It does not wait for the session to do anything. That is the whole point of
// starting one by voice: the confirmation is immediate and the roster is what
// reports progress afterwards.
export function startSession(spec = {}, opts = {}) {
  const args = buildStartArgs(spec);
  if (!args) return Promise.resolve({ ok: false, shortId: null, error: "that request was not startable" });
  if (typeof spec.cwd !== "string" || spec.cwd === "") {
    return Promise.resolve({ ok: false, shortId: null, error: "no workspace to start it in" });
  }

  return new Promise((resolvePromise) => {
    // Read right before the spawn call it describes, not before the argument
    // building above or after anything async below — it is meant to be the
    // moment this session was actually asked for.
    const since = Date.now();
    let child;
    try {
      child = spawn(opts.bin ?? "claude", args, {
        cwd: spec.cwd,
        // stdin closed rather than inherited, for the reason lib/builder.js
        // documents: a CLI holding the parent's stdin waits for input that is
        // never coming.
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group. A Ctrl-C in the terminal running Dante must
        // not reach a session someone started an hour ago and walked away from.
        detached: process.platform !== "win32",
      });
    } catch {
      resolvePromise({ ok: false, shortId: null, startedAtMs: since, error: "the CLI could not be started" });
      return;
    }

    // Decoded as text rather than left as Buffers: a multibyte character (a
    // session named with an emoji, say) can land split across two chunks, and
    // concatenating raw bytes across that split — or capping by byte length
    // instead of character length below — can cut it in half and hand back
    // mojibake instead of refusing or reading it whole. setEncoding makes the
    // stream itself buffer a split multibyte sequence until it is complete,
    // which string concatenation on decoded chunks cannot do after the fact.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // Whatever happened, this process does not wait on the session: it
      // outlives the turn that asked for it, and often the server.
      //
      // The two pipes are unreferenced rather than destroyed. Unreferencing
      // releases the event loop, which is the whole problem: a running child's
      // stdio holds this process open long after the answer is decided.
      // Destroying them closes the read end, and a session still writing to it
      // gets EPIPE and dies -- the opposite of starting one detached.
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      child.unref?.();
      resolvePromise({ name: spec.name, sessionId: spec.sessionId, shortId: null, startedAtMs: since, ...result });
    };

    const deadline = setTimeout(
      // Still alive at the deadline is the ordinary, successful case. Whatever
      // stdout carries by now is everything it is going to say — a `--bg`
      // confirmation is one short line, printed well before this window ever
      // closes — so this is not a race against output still arriving.
      () => finish({ ok: true, shortId: parseStartedId(stdout) }),
      positiveMs(opts.startupMs, STARTUP_MS),
    );
    deadline.unref?.();

    // Both capped the same way: unread pipes fill and the child blocks, so
    // they must be drained regardless, but neither is worth keeping past a
    // few hundred characters — characters now that the streams are decoded
    // above, not bytes, so the cap cannot land mid-character the way a byte
    // cap could. stderr is kept only as far as the first line, which is what
    // a refusal says; stdout only as far as the "backgrounded" line
    // parseStartedId reads, which is the first thing a `--bg` start prints.
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 500) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 500) stderr += chunk;
    });

    child.on("error", () => finish({ ok: false, error: "the CLI could not be started" }));
    child.on("close", (code) => {
      // Exiting inside the startup window means it refused — an unknown flag, a
      // model that does not exist, a login that expired. A session that started
      // properly is still running when the deadline fires.
      if (code === 0) return finish({ ok: true, shortId: parseStartedId(stdout) });
      finish({ ok: false, error: clean(stderr, 200) || `the CLI exited ${code}` });
    });
  });
}

// resolveStartedSession({ shortId, name, cwd, since }, opts) -> Promise<{ sessionId, record } | null>.
// Never rejects.
//
// The gap this closes: `claude --bg` prints its confirmation and exits
// almost immediately, but `claude agents --json` is a separate read of the
// daemon's own state, taken by a separate process -- the two are not
// synchronised, so the roster does not necessarily show the new session on
// the very next read. Polling a handful of times, a few hundred milliseconds
// apart, is what lets the daemon catch up without holding the caller's turn
// open for long when it already has.
//
// `cwd` and `since` are passed straight through to matchStarted, which is
// what actually bounds the name fallback — see its own comment for why both
// exist. `opts.deadlineMs` is a second, independent bound on this function:
// `opts.attempts` times `opts.delayMs` is the *intended* wait, but a slow
// `opts.list` (a real CLI under load, not the fixed-delay fake the tests use)
// can stretch each attempt well past `delayMs`, and nothing before this
// caller's own deadline was keeping the total wait bounded. Checked before
// each poll rather than raced against it: a `list` that is merely slow still
// gets to finish and be checked against the roster, rather than being
// abandoned mid-flight only to have the next caller repeat the same slow call.
//
// `opts.list` is the seam the tests use in place of listAgents; it is
// expected to follow listAgents' own contract (an array, or null on failure)
// but is not trusted to -- a rejecting or throwing double still leaves this
// polling rather than crashing the caller.
export async function resolveStartedSession({ shortId, name, cwd, since } = {}, opts = {}) {
  const list = typeof opts.list === "function" ? opts.list : listAgents;
  const attempts = Number.isInteger(opts.attempts) && opts.attempts > 0 ? opts.attempts : 4;
  const delayMs = positiveMs(opts.delayMs, 400);
  const deadline = Date.now() + positiveMs(opts.deadlineMs, 5000);

  for (let attempt = 0; attempt < attempts; attempt++) {
    let roster;
    try {
      roster = await list();
    } catch {
      roster = null;
    }
    const record = matchStarted(roster, { shortId, name, cwd, since });
    // A record whose own sessionId is not a usable string is not something
    // anything downstream could resume, queue against or chain off of — the
    // whole reason this function exists is to hand back that id, so a record
    // without one is not a match, it is nothing found yet.
    if (record && typeof record.sessionId === "string" && record.sessionId) {
      return { sessionId: record.sessionId, record };
    }
    // The first attempt always happens regardless of the deadline — a
    // deadline of zero must still get one real look at the roster — but a
    // second one only if there is time left to spend on it.
    if (attempt >= attempts - 1 || Date.now() >= deadline) break;
    await sleep(delayMs);
  }
  return null;
}


// ---------------------------------------------------------------------------
// Telling a running session something
// ---------------------------------------------------------------------------

// How long a follow-up gets to come back before it is abandoned. Generous,
// because the session is doing real work with real tools, and short enough that
// a wedged one does not hold a turn forever.
export const TELL_TIMEOUT_MS = 120_000;

// buildTellArgs(spec) -> argv, or null.
//
// `claude -p --resume <id> --output-format json -- "<text>"` — the cold path
// lib/brain.js already uses, pointed at somebody else's session.
//
// GOTCHA, and it is the reason Stage 27 exists at all: resuming a session that
// is currently working is not a join. Two processes on one session id is the
// race askResilient and conv.settled exist to prevent inside Dante, and it is
// worse across processes. Nothing here can check that — the roster is what
// knows — so the caller must, and does.
export function buildTellArgs(spec = {}) {
  const sessionId = typeof spec.sessionId === "string" ? spec.sessionId : "";
  // A follow-up may now carry a brief, and truncating it at a sentence would
  // deliver half an instruction. cleanBrief rather than clean for the same
  // reason buildStartArgs uses it: a brief's line breaks are its sections,
  // not filler to be flattened away.
  const text = cleanBrief(spec.text, MAX_BRIEF_CHARS);
  if (!UUID.test(sessionId) || !text) return null;

  // --output-format json rather than stream-json: there is nothing to stream to.
  // Nobody is watching a follow-up happen; only the answer is wanted.
  const args = ["-p", "--resume", sessionId, "--output-format", "json", "--", text];

  if (args.some((arg) => FORBIDDEN.some((pattern) => pattern.test(arg)))) return null;
  return args;
}

// tellSession(spec, opts) -> Promise<{ ok, reply, error }>. Never rejects.
//
// Unlike startSession this one waits: the point of a follow-up is the answer.
// `spec.cwd` is the session's own working directory, which is where a resume
// has to run from.
export async function tellSession(spec = {}, opts = {}) {
  const args = buildTellArgs(spec);
  if (!args) return { ok: false, error: "there was nothing to pass on" };
  if (typeof spec.cwd !== "string" || spec.cwd === "") {
    return { ok: false, error: "I do not know where that session is running" };
  }

  const { status, code, stdout, stderr } = await runCli(opts.bin ?? "claude", args, {
    cwd: spec.cwd,
    timeoutMs: positiveMs(opts.timeoutMs, TELL_TIMEOUT_MS),
  });
  if (status === "not-started") return { ok: false, error: "the CLI could not be started" };
  if (status === "timed-out") return { ok: false, error: "that session did not answer in time" };
  if (code !== 0) {
    return { ok: false, error: spokenStderr(stderr) || (code === null ? "that session was killed before it answered" : `that session refused, exit ${code}`) };
  }
  try {
    const reply = clean(String(JSON.parse(stdout).result ?? ""), MAX_REPLY_CHARS);
    // Exit 0 with nothing to say is a session that took the message and said
    // nothing, which is worth reporting as taken rather than as failed.
    return { ok: true, reply };
  } catch {
    return { ok: false, error: "that session answered with something I could not read" };
  }
}

// createInFlight() -> { run(key, fn), has(key), ids() }
//
// A guard against two `--resume` children racing the same session id: the
// exact race buildTellArgs's own comment names, but across ticks rather than
// within one. A drain that gets re-checked every poll tick can otherwise
// start a second tellSession for a session whose first call is still inside
// TELL_TIMEOUT_MS (120s -- 24 poll ticks at the default interval), which is
// two processes writing to one session id at once. `run` refuses rather than
// queues: the caller re-checks on its own next tick, so there is nothing to
// lose by skipping this one.
export function createInFlight() {
  const keys = new Set();
  return {
    async run(key, fn) {
      if (keys.has(key)) return false;
      keys.add(key);
      try {
        await fn();
        return true;
      } finally {
        keys.delete(key);
      }
    },
    // has(key) -> whether a run for this key is still unresolved. server.js
    // needs this for its own reason, not this module's: a queue table
    // (lib/memory.js's takeQueued) is deleted from the instant a drain
    // starts, so by the very next poll tick the queue no longer names a
    // session that a drain is nonetheless still busy delivering to. `has`
    // is the only thing left that still knows that.
    has(key) {
      return keys.has(key);
    },
    // ids() -> every key currently in flight. For unioning into a caller's
    // own set (server.js's onRoster skip set) rather than checking keys one
    // at a time.
    ids() {
      return [...keys];
    },
  };
}


// ---------------------------------------------------------------------------
// Stopping one
// ---------------------------------------------------------------------------

// How long a whole stop gets -- asking the daemon and then watching the worker
// leave, on one budget -- before this reports that it would not. It is not a
// kill deadline for the session: nothing here ever escalates on the session.
// The one thing that is killed on expiry is the `claude stop` client below,
// which is a messenger, not the session.
const STOP_TIMEOUT_MS = 8000;
const STOP_POLL_MS = 200;

// Referenced, deliberately: the answer to a stop is worth holding the process
// open for. Unreferenced, a poll with nothing else alive lets the event loop
// drain mid-wait, and the stop resolves to nobody -- the test runner reports
// that as a cancelled test, and a shutting-down server would report nothing.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// stopSession(record, opts) -> Promise<{ ok, via, alreadyGone?, error? }>. Never rejects.
//
// Two ways to ask, and the roster decides which. `via` says which one was
// used, so a stop that came back wrong can be read off the log rather than
// re-derived from a process table.
//
// A background session -- the only kind Dante starts -- is owned by the
// Claude Code daemon, not by its pid. The daemon holds a lease on it and reads
// a worker that dies as a crash to recover from: about ten seconds later it
// resumes the same transcript in a fresh worker, under a new pid. That is
// exactly what a SIGTERM stop did on 2026-09-01: the pid was gone within a
// second, "stopped" was said, and the same session was back on the roster and
// working before the sentence had finished. Only `claude stop <id>` settles
// the lease, so for a background session that is what is asked -- and the
// worker is still polled afterwards, because "stopped" is only ever said of a
// process that has actually left.
//
// A background record the CLI listed without a usable id is refused rather
// than signalled: the lease is there whether or not the id came through, and
// SIGTERM would be the resume-after-ten-seconds again, sounding like success.
//
// An interactive session in somebody's terminal has no lease to settle, and
// SIGTERM is the right ask. SIGTERM, and only ever
// SIGTERM: a session mid-write should be allowed to finish the write. It is
// holding a real file in a real repository, and the difference between a
// polite stop and a hard one is a half-written source file that nobody asked
// for. If it ignores the signal, that is reported and left alone -- killing it
// is a decision for whoever can see what it was doing.
//
// `record` is a roster entry, so the pid and the id both came from the CLI
// rather than from anything spoken. `opts.kill` and `opts.bin` are the seams
// the tests use.
export async function stopSession(record = {}, opts = {}) {
  const kill = typeof opts.kill === "function" ? opts.kill : (target, signal) => process.kill(target, signal);
  // Checked again here even though parseRoster already does: kill(2) reads 0
  // as "my own process group" and a negative pid as "that whole group", and
  // this is the one function that would act on it.
  const pid = asPid(record.pid);
  const gone = () => {
    if (pid === null) return true;
    try {
      // Signal 0 sends nothing and only asks whether the process is still there.
      kill(pid, 0);
      return false;
    } catch (err) {
      return err?.code === "ESRCH";
    }
  };

  // One budget for the whole stop. The daemon ask and the wait for the worker
  // to leave share it, so a slow answer followed by a slow exit cannot add up
  // to twice what the caller allowed.
  const deadline = Date.now() + positiveMs(opts.timeoutMs, STOP_TIMEOUT_MS);
  const pollMs = positiveMs(opts.pollMs, STOP_POLL_MS);

  if (record?.kind === "background") {
    const id = daemonId(record);
    if (!id) return { ok: false, via: "daemon", error: "I do not have an id to stop that session by" };
    // Checked before the ask, not after: once the daemon has answered, a
    // worker that is gone is what was asked for, not evidence it was already
    // finished.
    const alreadyGone = pid !== null && gone();
    const asked = await stopViaDaemon(id, {
      bin: opts.bin,
      timeoutMs: Math.max(1, deadline - Date.now()),
      killGraceMs: opts.killGraceMs,
    });
    // No falling through to SIGTERM on a refusal. The daemon has said no, and
    // signalling the worker anyway would land in exactly the resume-after-ten-
    // seconds that this path exists to avoid -- while sounding like a success.
    if (!asked.ok) return { ok: false, via: "daemon", error: asked.error };
    if (alreadyGone) return { ok: true, via: "daemon", alreadyGone: true };
    return { ...(await waitGone(gone, deadline, pollMs)), via: "daemon" };
  }

  if (pid === null) {
    return { ok: false, via: "signal", error: "I do not have a process id for that session" };
  }

  try {
    kill(pid, "SIGTERM");
  } catch (err) {
    // Already gone is the outcome that was wanted, however it got there.
    if (err?.code === "ESRCH") return { ok: true, via: "signal", alreadyGone: true };
    return { ok: false, via: "signal", error: "I was not allowed to stop that session" };
  }

  return { ...(await waitGone(gone, deadline, pollMs)), via: "signal" };
}

// The daemon's own short id from a roster record, or null when there is not
// one it would be safe to pass. Everything the roster carries came from the
// CLI, but the id still has to look like one before it becomes an argument: a
// value beginning with "-" would be read as an option, and a listing is not a
// place to take that on trust.
export function daemonId(record) {
  const id = typeof record?.id === "string" ? record.id : "";
  return ID_SHAPE.test(id) ? id : null;
}

// Confirmed before it is reported. Saying "stopped" of a process that is
// still writing files is the one answer here that would be actively
// misleading.
async function waitGone(gone, deadline, pollMs) {
  while (Date.now() < deadline) {
    if (gone()) return { ok: true };
    await sleep(pollMs);
  }

  return gone() ? { ok: true } : { ok: false, error: "it is still running" };
}

// stopViaDaemon(id, { bin, timeoutMs, killGraceMs }) -> Promise<{ ok, error? }>.
// Never rejects. The durations arrive already resolved by stopSession, which
// owns the one budget they are drawn from.
//
// `claude stop <id>` is the daemon's own verb for this: it settles the lease
// so the session is not resumed, and stops the worker itself. Exit 0 is the
// only success. The CLI is idempotent about a session that has already ended
// (it says "stopped" and exits 0 again), and refuses an id it has never heard
// of on stderr with exit 1 -- which is the sentence worth repeating, because
// it is the one that names what went wrong. On the deadline the runner kills
// the CLI, which is only a client of the daemon, not the session: the worst
// case is a stop that was not delivered, which is what is reported.
async function stopViaDaemon(id, { bin, timeoutMs, killGraceMs }) {
  const { status, code, stderr } = await runCli(bin ?? "claude", ["stop", id], { timeoutMs, killGraceMs });
  if (status === "not-started") return { ok: false, error: "the CLI could not be started" };
  if (status === "timed-out") return { ok: false, error: "the CLI did not answer" };
  if (code === 0) return { ok: true };
  // A null code is a client that died by signal rather than exiting.
  return { ok: false, error: spokenStderr(stderr) || (code === null ? "the CLI was killed before it answered" : `the CLI exited ${code}`) };
}

// What the CLI said on stderr, ready to be spoken inside a sentence of its
// own: one line, capped, and without the full stop the CLI already put on it
// -- lib/verdict.js adds one, and a doubled period is read out as a pause.
function spokenStderr(stderr) {
  return clean(stderr, 200).replace(/[.!?]+$/, "");
}
