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

// A spoken task is a sentence or two. The cap is not tidiness: this string is
// authored by a model, in a tag, from speech, and it ends up as a command-line
// argument.
export const MAX_TASK_CHARS = 600;

// Re-export so callers of spawn-session need not know where it lives.
export { MAX_BRIEF_CHARS };

// An appended system prompt comes from a session kind in this repository rather
// than from anything spoken, so the cap here is a backstop against a kind with
// a runaway template, not a trust boundary.
export const MAX_PROMPT_CHARS = 8000;

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

  // The task is the session's name, its Slack line and what is spoken back to
  // the person; the brief is what the session actually reads. When there is a
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

  // The prompt goes after the options terminator, always. Without it a task
  // that happens to start with a dash — or one a model wrote to look like a
  // flag — would be read as an option rather than as the thing to do.
  args.push("--", brief || task);

  // Belt and braces. Nothing above can produce one of these, and this is what
  // makes that a fact rather than an intention.
  if (args.some((arg) => FORBIDDEN.some((pattern) => pattern.test(arg)))) return null;

  return args;
}

// ---------------------------------------------------------------------------
// Whether to start one at all
// ---------------------------------------------------------------------------

// Five is a working ceiling rather than a technical one. Past it nobody can
// hold in their head what is running, and the roster line stops being sayable.
export const MAX_SESSIONS = 5;

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

// startSession(spec, opts) -> Promise<{ ok, name, sessionId, error }>. Never rejects.
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
  if (!args) return Promise.resolve({ ok: false, error: "that request was not startable" });
  if (typeof spec.cwd !== "string" || spec.cwd === "") {
    return Promise.resolve({ ok: false, error: "no workspace to start it in" });
  }

  return new Promise((resolvePromise) => {
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
      resolvePromise({ ok: false, error: "the CLI could not be started" });
      return;
    }

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
      resolvePromise({ name: spec.name, sessionId: spec.sessionId, ...result });
    };

    const deadline = setTimeout(
      // Still alive at the deadline is the ordinary, successful case.
      () => finish({ ok: true }),
      Number.isFinite(opts.startupMs) && opts.startupMs > 0 ? opts.startupMs : STARTUP_MS,
    );
    deadline.unref?.();

    // Drained and discarded: unread pipes fill and the child blocks. stderr is
    // kept only as far as the first line, which is what a refusal says.
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 500) stderr += chunk;
    });

    child.on("error", () => finish({ ok: false, error: "the CLI could not be started" }));
    child.on("close", (code) => {
      // Exiting inside the startup window means it refused — an unknown flag, a
      // model that does not exist, a login that expired. A session that started
      // properly is still running when the deadline fires.
      if (code === 0) return finish({ ok: true });
      finish({ ok: false, error: clean(stderr, 200) || `the CLI exited ${code}` });
    });
  });
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
export function tellSession(spec = {}, opts = {}) {
  const args = buildTellArgs(spec);
  if (!args) return Promise.resolve({ ok: false, error: "there was nothing to pass on" });
  if (typeof spec.cwd !== "string" || spec.cwd === "") {
    return Promise.resolve({ ok: false, error: "I do not know where that session is running" });
  }

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(opts.bin ?? "claude", args, {
        cwd: spec.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolvePromise({ ok: false, error: "the CLI could not be started" });
      return;
    }

    let out = "";
    let err = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolvePromise(result);
    };

    const deadline = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      // SIGKILL after a grace, for the reason listAgents documents: a child
      // that ignores SIGTERM still holds its stdio pipes in this process.
      const hardKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Exited between the two signals.
        }
      }, 250);
      hardKill.unref?.();
      finish({ ok: false, error: "that session did not answer in time" });
    }, Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : TELL_TIMEOUT_MS);
    deadline.unref?.();

    child.stdout.on("data", (chunk) => {
      // A wedged session printing forever must not be read to the end.
      if (out.length < 1 << 20) out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (err.length < 500) err += chunk;
    });

    child.on("error", () => finish({ ok: false, error: "the CLI could not be started" }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, error: clean(err, 200) || `that session refused, exit ${code}` });
        return;
      }
      try {
        const reply = clean(String(JSON.parse(out).result ?? ""), MAX_REPLY_CHARS);
        // Exit 0 with nothing to say is a session that took the message and
        // said nothing, which is worth reporting as taken rather than as failed.
        finish({ ok: true, reply });
      } catch {
        finish({ ok: false, error: "that session answered with something I could not read" });
      }
    });
  });
}

// createInFlight() -> { run(key, fn) }
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
  };
}


// ---------------------------------------------------------------------------
// Stopping one
// ---------------------------------------------------------------------------

// How long a session gets to shut down before this reports that it would not.
// It is not a kill deadline: nothing here escalates.
export const STOP_TIMEOUT_MS = 8000;
const STOP_POLL_MS = 200;

function sleep(ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });
}

// stopSession(record, opts) -> Promise<{ ok, alreadyGone?, error? }>. Never rejects.
//
// SIGTERM, and only ever SIGTERM. A session mid-write should be allowed to
// finish the write: it is holding a real file in a real repository, and the
// difference between a polite stop and a hard one is a half-written source file
// that nobody asked for. If it ignores the signal, that is reported and left
// alone — killing it is a decision for whoever can see what it was doing.
//
// `record` is a roster entry, so the pid came from the CLI rather than from
// anything spoken. `opts.kill` is the seam the tests use.
export async function stopSession(record = {}, opts = {}) {
  const pid = record.pid;
  // Positive integers only, checked again here even though parseRoster already
  // does: kill(2) reads 0 as "my own process group" and a negative pid as "that
  // whole group", and this is the one function that would act on it.
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: "I do not have a process id for that session" };
  }

  const kill = typeof opts.kill === "function" ? opts.kill : (target, signal) => process.kill(target, signal);
  const gone = () => {
    try {
      // Signal 0 sends nothing and only asks whether the process is still there.
      kill(pid, 0);
      return false;
    } catch (err) {
      return err?.code === "ESRCH";
    }
  };

  try {
    kill(pid, "SIGTERM");
  } catch (err) {
    // Already gone is the outcome that was wanted, however it got there.
    if (err?.code === "ESRCH") return { ok: true, alreadyGone: true };
    return { ok: false, error: "I was not allowed to stop that session" };
  }

  // Confirmed before it is reported. Saying "stopped" of a process that is
  // still writing files is the one answer here that would be actively
  // misleading.
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : STOP_TIMEOUT_MS;
  const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : STOP_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (gone()) return { ok: true };
    await sleep(pollMs);
  }

  return gone() ? { ok: true } : { ok: false, error: "it is still running" };
}
