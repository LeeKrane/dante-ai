// Running the Claude CLI as a child and waiting for its answer.
//
// Three verbs spawn the CLI and wait: a follow-up (`tellSession`), a roster
// listing (`listAgents`) and a stop (`stopViaDaemon`). They used to carry three
// copies of the same forty lines -- spawn with stdin closed, drain both pipes
// so the child never blocks on a full one, settle exactly once, arm a deadline
// that asks politely and then insists -- and a fix to that skeleton had to be
// found and applied three times. This is the one copy. What differs between
// the callers is the argv they build and what they make of the result, and
// that is all a caller does now.
//
// lib/builder.js has its own runner and keeps it: a build streams progress
// and writes a log while it runs, which is a different shape of waiting.

import { spawn } from "node:child_process";

// How long a child that ignored SIGTERM gets before it is killed outright. A
// child that will not die still holds its stdout pipe open in this process,
// and an unclosed pipe is a handle the event loop counts -- so a polite-only
// kill leaves the server unable to exit. Same two-step lib/builder.js uses on
// a timed-out build, and for the same reason.
export const KILL_GRACE_MS = 250;

// How much of either pipe is kept. A wedged child printing forever must not be
// read to the end.
const MAX_STDOUT_BYTES = 1 << 20;
const MAX_STDERR_BYTES = 500;

// runCli(bin, args, opts) -> Promise<{ status, code, stdout, stderr, truncated }>.
// Never rejects.
//
// `status` is one of:
//   "exited"      the child ran to the end; `code` is its exit code (or null
//                 when a signal ended it), `stdout` and `stderr` are what it
//                 printed up to the caps.
//   "timed-out"   the deadline passed first. The child was sent SIGTERM and,
//                 `killGraceMs` later, SIGKILL; neither is waited for, because
//                 the answer is already decided.
//   "not-started" spawn itself failed -- no such binary, most often.
//
// `truncated` is set when stdout passed `maxStdout`; what is in `stdout` is
// then the prefix that fit, and a caller that needs the whole thing (a JSON
// listing) must treat it as no answer rather than half of one.
//
// `opts.cwd` is where the child runs; `opts.timeoutMs` the deadline (none
// when omitted -- every caller here passes one);
// `opts.killGraceMs` the gap between the two signals (zero or less means the
// default, not "at once"); `opts.maxStdout` and `opts.maxStderr` the caps. stdin is always closed rather than inherited: a
// CLI left holding the parent's stdin waits for input that is never coming.
export function runCli(bin, args, opts = {}) {
  const maxStdout = positiveMs(opts.maxStdout, MAX_STDOUT_BYTES);
  const maxStderr = Number.isFinite(opts.maxStderr) && opts.maxStderr >= 0 ? opts.maxStderr : MAX_STDERR_BYTES;

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(bin, args, {
        ...(typeof opts.cwd === "string" && opts.cwd !== "" ? { cwd: opts.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // spawn throws synchronously on a few argument shapes rather than
      // emitting "error", and a throw out of here would take down a turn.
      resolvePromise({ status: "not-started", code: null, stdout: "", stderr: "", truncated: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const finish = (status, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolvePromise({ status, code, stdout, stderr, truncated });
    };

    const timeoutMs = positiveMs(opts.timeoutMs, null);
    const deadline = timeoutMs === null ? null : setTimeout(() => {
      // SIGTERM, not SIGKILL: the CLI gets to clean up after itself.
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone, which is the outcome we were asking for anyway.
      }
      const hardKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Exited on its own between the two signals.
        }
      }, positiveMs(opts.killGraceMs, KILL_GRACE_MS));
      hardKill.unref?.();
      finish("timed-out", null);
    }, timeoutMs);
    // Never hold the process open just to schedule the abandonment of a child.
    deadline?.unref?.();

    child.stdout.on("data", (chunk) => {
      if (truncated) return;
      stdout += chunk;
      if (stdout.length > maxStdout) {
        truncated = true;
        stdout = stdout.slice(0, maxStdout);
      }
    });
    // Read even when nothing is kept: left unread, a pipe fills and the child
    // blocks forever on a warning nobody wanted.
    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxStderr) stderr += chunk;
    });

    child.on("error", () => finish("not-started", null));
    child.on("close", (code) => finish("exited", code));
  });
}

// A caller-supplied duration (or byte count), or the default when it is
// missing, zero, negative or not a number at all. Every timeout, poll interval
// and cap in the modules that spawn the CLI is read this way, and reading them
// the same way in one place is what keeps a zero or a NaN from ever becoming
// "wait forever".
export function positiveMs(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
