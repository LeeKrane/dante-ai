// The roster: what Claude Code sessions exist on this machine right now.
//
// `claude agents --json` is the whole mechanism. It prints every live session —
// interactive terminals included, not just the ones jarvis started — and it
// explicitly does not require a TTY, so it is a plain child process of the same
// shape lib/builder.js already spawns.
//
// Split the way the rest of lib/ is split: parseRoster and describeRoster are
// pure and carry all the interesting decisions, listAgents is a thin impure
// runner with an injectable `opts.bin` so the tests can point it at a fake CLI
// written to disk. Nothing here throws. A roster jarvis cannot read costs it
// the roster for one turn; it must never cost it the turn.

import { spawn } from "node:child_process";
import { basename } from "node:path";

// A listing sits on the critical path of a spoken turn, so it gets a short
// leash. Past this the turn goes ahead without a roster, which is the correct
// trade: knowing what is running is a nicety, answering is not.
export const LIST_TIMEOUT_MS = 3000;

// How long a listing that ignored SIGTERM gets before it is killed outright.
// A `claude agents --json` that will not die still holds its stdout pipe open
// in this process, and an unclosed pipe is a handle the event loop counts — so
// a polite-only kill leaves the server unable to exit. Same two-step
// lib/builder.js uses on a timed-out build, and for the same reason.
export const KILL_GRACE_MS = 250;

// The CLI's output is small — a few hundred bytes per session — so anything
// past this is a runaway rather than a big roster, and reading it to the end
// would be a memory leak triggered by a misbehaving child process.
export const MAX_STDOUT_BYTES = 1 << 20;

// Ten sessions recited aloud is a hostage situation. Past this the line says
// "and four more" and stops.
export const MAX_SPOKEN = 5;

// A session name is a label, not a sentence, and it is read out loud.
export const MAX_NAME_CHARS = 60;

// The same character class lib/memory.js:37 strips, redeclared here for the
// same reason it is redeclared there: this module has its own reasons to
// change. Session names come from whoever started the session — including a
// model that named itself — and this text is spoken and, in Phase C, posted to
// Slack. Control characters could forge structure; bidi overrides could reverse
// how a name reads on screen.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function cleanLabel(value, maxChars = MAX_NAME_CHARS) {
  if (typeof value !== "string") return "";
  return value.replace(UNPRINTABLE, "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Positive integers only. A pid of 0 means "this process group" to kill(2) and
// a negative one means "the whole group" — both are catastrophic to sign a
// SIGTERM with in Stage 28, so a pid that is not obviously a real process id
// becomes null and the stop path refuses rather than guesses.
function asPid(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

// startedAt arrives as epoch milliseconds, as a number. Verified against a live
// listing — it is NOT an ISO string, and a Date built from one here would
// silently report every session as having started in 1970.
function asEpochMs(value) {
  if (Number.isFinite(value) && value > 0) return value;
  // Tolerated because the CLI could reasonably switch to one: a parseable date
  // string is used, anything else is simply unknown.
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

// parseRoster(stdout) -> [{ sessionId, id, name, cwd, kind, status, state, pid, startedAt }]
//
// Normalises rather than validates, deliberately. A live listing showed how
// much of the record is optional: `id` is absent on interactive sessions,
// `state` is absent on some and reported "blocked" on others (so it is an open
// vocabulary, not the working/done pair it looks like), and one session carried
// no `status` at all. A record missing half its fields is still a session that
// exists, and dropping it would make jarvis confidently wrong about what is
// running.
//
// `sessionId` is the one required field, because it is the handle every later
// stage resumes, queues against and threads Slack by. A record without one
// cannot be acted on, so it is not worth reporting.
//
// Never throws: malformed JSON, a non-array top level, or a CLI that renamed
// every field all degrade to [] — the posture of loadStore in lib/memory.js and
// readSharedSettings in lib/builder.js.
export function parseRoster(stdout) {
  if (typeof stdout !== "string") return [];

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Includes the empty string, which is what a CLI that is not installed
    // leaves on stdout.
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const roster = [];
  const seen = new Set();
  for (const entry of parsed) {
    if (!isPlainObject(entry)) continue;

    const sessionId = cleanLabel(entry.sessionId, 100);
    if (!sessionId) continue;
    // One process per session id is the invariant every later stage leans on:
    // Stage 27 refuses to resume a busy session precisely because two processes
    // on one id is a fork, not a join. A duplicate here would defeat that check
    // before it ran.
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);

    const cwd = cleanLabel(entry.cwd, 4096);
    roster.push({
      sessionId,
      id: cleanLabel(entry.id, 100) || null,
      name: cleanLabel(entry.name) || null,
      cwd: cwd || null,
      kind: cleanLabel(entry.kind, 40) || null,
      status: cleanLabel(entry.status, 40) || null,
      state: cleanLabel(entry.state, 40) || null,
      pid: asPid(entry.pid),
      startedAt: asEpochMs(entry.startedAt),
    });
  }
  return roster;
}

// ---------------------------------------------------------------------------
// Saying it out loud
// ---------------------------------------------------------------------------

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function countWord(n) {
  return COUNT_WORDS[n] ?? String(n);
}

// What the session is doing, in one word someone would actually say. `state` is
// the more specific field and wins where present; `status` is the fallback for
// the interactive sessions that carry no state. An unrecognised value becomes
// "running" rather than being read aloud verbatim: a future CLI value would
// otherwise arrive in the user's ear as jargon.
function activity(record) {
  switch (record.state) {
    case "working":
      return "working";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    default:
      break;
  }
  switch (record.status) {
    case "busy":
      return "working";
    case "idle":
      return "idle";
    default:
      return "running";
  }
}

// Elapsed time, spoken. Rounded hard on purpose — "four minutes in" is what a
// person wants and "4 minutes 12 seconds" is what a dashboard wants.
function elapsed(startedAt, now) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return "";
  const ms = now - startedAt;
  // A clock that went backwards, or a session that claims to start in the
  // future, says nothing useful; it must not say "-3 minutes in".
  if (ms < 0) return "";

  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just started";
  if (minutes === 1) return "a minute in";
  if (minutes < 60) return `${minutes} minutes in`;

  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour in" : `${hours} hours in`;
}

// alias -> path, which is the shape lib/memory.js's `workspaces` holds from
// Stage 23. Inverted here so a session's cwd can be named, with the directory's
// own basename as the fallback for a repo nobody has aliased yet.
function aliasFor(cwd, aliases) {
  if (typeof cwd !== "string" || cwd === "") return "";
  if (isPlainObject(aliases)) {
    for (const [alias, path] of Object.entries(aliases)) {
      if (typeof path === "string" && path === cwd) return cleanLabel(alias, 40);
    }
  }
  return cleanLabel(basename(cwd), 40);
}

// How a single session is referred to out loud. A session named by jarvis
// already starts with its repo alias (jarvis-1-builder-test-fix), so prefixing
// it again would produce "jarvis: jarvis-1". A session started by hand is
// called whatever the terminal called it, which may say nothing about where it
// lives — so the repo goes in front of that one.
function label(record, aliases) {
  const alias = aliasFor(record.cwd, aliases);
  const name = record.name;
  if (!name) return alias || "an unnamed session";
  if (!alias) return name;
  return name.toLowerCase().startsWith(alias.toLowerCase()) ? name : `${alias}: ${name}`;
}

// describeRoster(roster, aliases, now) -> one short line, ready to speak.
//
// Voice-only is the constraint that shapes this: never a uuid, never a pid,
// never a path. `now` is a parameter rather than a Date.now() call so the line
// is deterministic under test — the same reason the rest of lib/ takes
// injectable overrides.
export function describeRoster(roster, aliases = {}, now = Date.now()) {
  const list = Array.isArray(roster) ? roster : [];
  if (list.length === 0) return "Nothing is running.";

  const shown = list.slice(0, MAX_SPOKEN);
  const parts = shown.map((record) => {
    const word = activity(record);
    // Elapsed time only where it is a fact someone is waiting on. Telling
    // someone an idle session has been idle for three hours is noise; telling
    // them a working one is four minutes in is the answer to their question.
    const since = word === "working" || word === "blocked" ? elapsed(record.startedAt, now) : "";
    const named = label(record, aliases);
    return since ? `${named} ${word}, ${since}` : `${named} ${word}`;
  });

  const hidden = list.length - shown.length;
  if (hidden > 0) parts.push(`and ${countWord(hidden)} more`);

  const noun = list.length === 1 ? "session" : "sessions";
  return `${countWord(list.length)} ${noun}: ${parts.join("; ")}`;
}

// ---------------------------------------------------------------------------
// Impure: asking the CLI
// ---------------------------------------------------------------------------

// listAgents(opts) -> Promise<roster>. Never rejects.
//
// `opts.bin` points the spawn at a fake CLI under test, the same seam
// lib/builder.js exposes. `opts.cwd` narrows the listing to one repository via
// the CLI's own --cwd. A CLI that is missing, slow, crashing or printing
// nonsense all produce the same answer: an empty roster.
export function listAgents(opts = {}) {
  const args = ["agents", "--json"];
  if (typeof opts.cwd === "string" && opts.cwd !== "") args.push("--cwd", opts.cwd);
  if (opts.all) args.push("--all");

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(opts.bin ?? "claude", args, {
        // stdin closed rather than inherited: lib/builder.js documents the same
        // gotcha — a CLI left holding the parent's stdin waits several seconds
        // for input that is never coming.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // spawn throws synchronously on a few argument shapes rather than
      // emitting "error", and a throw out of a listing would take down a turn.
      resolvePromise([]);
      return;
    }

    let out = "";
    let truncated = false;
    let settled = false;

    const finish = (roster) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolvePromise(roster);
    };

    const timeoutMs =
      Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : LIST_TIMEOUT_MS;
    const deadline = setTimeout(() => {
      // SIGTERM, not SIGKILL: the CLI gets to clean up after itself. Either way
      // the answer is already decided — a listing this slow is no longer worth
      // waiting for, and the turn behind it is.
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
      }, opts.killGraceMs ?? KILL_GRACE_MS);
      hardKill.unref?.();
      finish([]);
    }, timeoutMs);
    // Never hold the process open just to schedule the abandonment of a listing.
    deadline.unref?.();

    child.stdout.on("data", (chunk) => {
      if (truncated) return;
      out += chunk;
      if (out.length > MAX_STDOUT_BYTES) {
        // Drop what was collected rather than parsing a truncated array: half a
        // roster read as a whole one would report live sessions as gone.
        truncated = true;
        out = "";
      }
    });
    // stderr is drained and discarded. Left unread it fills its pipe buffer and
    // the child blocks forever on a warning nobody wanted.
    child.stderr.on("data", () => {});

    child.on("error", () => finish([]));
    child.on("close", (code) => {
      // A non-zero exit means the CLI itself is unhappy — an unknown subcommand
      // on an older version, most likely. Whatever it printed is not a roster.
      finish(code === 0 && !truncated ? parseRoster(out) : []);
    });
  });
}
