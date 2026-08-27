// Sessions `claude agents --json` never mentions: a plain `claude` typed into
// a terminal. lib/agents.js's listing is a CLI subcommand, and 2.1.247's
// subcommand omits the foreground case entirely -- verified against a live
// machine sitting at an interactive session the listing did not print. What
// every live session DOES write, foreground or background, is a state file at
// ~/.claude/sessions/<pid>.json -- the exact file lib/peer.js's
// readPeerAddress() already reads to find a session's messaging socket. This
// module reads the same files for a different reason: discovery of what
// exists, not delivery into it.
//
// A pre-warmed `claude bg-spare` process writes one of these too, and its cwd
// is not the giveaway it might look like: a live one observed on this machine
// sat in /home/krane/development/jarvis, a real workspace root already on
// Dante's whitelist, under a jobId-derived name that reads as a legitimate
// session. Nothing about where it lives or what it is called disqualifies
// it -- only `state.spare` says what it actually is, so that is the one
// thing checked before it can become a roster row.
//
// Split the way lib/peer.js and lib/agents.js both are: parseStateFile is
// pure and holds the validation; listSessionFiles and processAlive are the
// thin impure edges, each with an injectable override so the tests never
// have to spawn or wait on a real process.

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The shape a session id takes everywhere else in this codebase, redeclared
// rather than imported -- lib/peer.js's own comment on its copy of this
// pattern is the reason: this module has its own reasons to change, and a
// shared import would couple two files that should be free to diverge.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The same character class lib/agents.js strips from a roster label,
// redeclared here for the reason its own comment gives for redeclaring it
// rather than importing it: this module has its own reasons to change. A
// terminal session's name is typed by whoever started it -- or derived by the
// CLI -- and this text is spoken and, in Phase C, posted to Slack. Control
// characters could forge structure; bidi overrides could reverse how a name
// reads on screen.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// A session name is a label, not a sentence, and it is read out loud.
export const MAX_NAME_CHARS = 60;

// Whitespace collapsed before the unprintables are stripped: a newline is
// both, and stripping it first would fuse the words on either side of it
// together. Copied from lib/agents.js's cleanLabel for the same reason.
function cleanLabel(value, maxChars = MAX_NAME_CHARS) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// startedAt arrives as epoch milliseconds, as a number -- the same shape
// lib/agents.js's asEpochMs verified against a live listing. Tolerating a
// parseable date string too costs nothing and matches the CLI's own field for
// the same value, in case it ever switches representations.
function asEpochMs(value) {
  if (Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

// parseStateFile(text, pid) -> a roster-shaped record, or null.
//
// `pid` is the number carried in the filename, not anything read out of the
// body -- it is the caller's evidence of which process this state file
// belongs to. When the body disagrees (state.pid !== pid) the file is either
// stale, left behind by a pid the OS has since recycled, or tampered, and
// this takes the same posture sendToSession takes toward a mismatched
// sessionId: refuse rather than guess.
//
// Never throws: a non-string text, unparseable JSON, a non-object or array
// top level, and a bad pid all degrade to null, the same posture parseRoster
// in lib/agents.js takes toward a CLI listing it cannot read.
export function parseStateFile(text, pid) {
  if (typeof text !== "string") return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  let state;
  try {
    state = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(state)) return null;

  // A pre-warmed spare's cwd is not evidence either way -- a live one
  // observed here sat in a real, already-whitelisted workspace root under a
  // name that reads as legitimate. `state.spare` is the only field that says
  // what it actually is, so it is the only thing checked -- and checked for
  // truthiness rather than `=== true`, since the CLI's own choice of value
  // for the flag is not this module's business to guess at; only the absence
  // of any value at all is what "not a spare" actually means.
  if (state.spare) return null;

  if (state.pid !== pid) return null;

  const sessionId = typeof state.sessionId === "string" ? state.sessionId : "";
  if (!UUID.test(sessionId)) return null;

  // "bg" is the CLI's own word for what its listing calls "background" --
  // matched here so a hand-started background process reads the same way
  // whichever source told Dante about it. Anything else passes through
  // unchanged rather than being coerced into a vocabulary this module did
  // not observe.
  const kind = state.kind === "bg" ? "background" : cleanLabel(state.kind, 40) || null;

  return {
    sessionId,
    // The CLI's own listing carries `id` on background sessions; a terminal's
    // state file has no equivalent field, so this is always null rather than
    // guessed at.
    id: null,
    name: cleanLabel(state.name) || null,
    cwd: cleanLabel(state.cwd, 4096) || null,
    kind,
    status: cleanLabel(state.status, 40) || null,
    // Only `claude agents --json` reports working/blocked/done. A terminal's
    // state file exposes `status` instead, and inventing a `state` value here
    // would let isWorking and diffRoster in lib/agents.js claim knowledge
    // this module does not actually have.
    state: null,
    pid,
    startedAt: asEpochMs(state.startedAt),
    // The one field on this record with no counterpart in parseListing's own
    // shape. It rides along because lib/spawn-session.js's stopSession reads
    // it back immediately before signing a SIGTERM, as a second, fresher
    // pid-recycle check -- the roster this record came from can be seconds to
    // a minute old by the time a stop actually runs, and the original pid
    // could have exited and been reused by something else in that gap.
    procStart: typeof state.procStart === "string" && state.procStart !== "" ? state.procStart : null,
  };
}

// ---------------------------------------------------------------------------
// Impure: reading the directory
// ---------------------------------------------------------------------------

// listSessionFiles(opts) -> Promise<record[]>. Never throws or rejects.
//
// `opts.home` overrides homedir(), the same seam readPeerAddress in
// lib/peer.js exposes. `opts.alive` overrides processAlive, so the tests
// never have to spawn or wait on a real process to prove a dead pid's file
// gets dropped.
//
// Sync fs calls throughout: a handful of small files in one directory, the
// same trade readPeerAddress already makes.
export async function listSessionFiles(opts = {}) {
  const home = typeof opts.home === "string" && opts.home !== "" ? opts.home : homedir();
  const sessionsDir = join(home, ".claude", "sessions");
  const alive = typeof opts.alive === "function" ? opts.alive : processAlive;

  let entries;
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    // A missing directory is "no sessions yet", not a failure -- the same
    // posture listAgents takes toward a CLI that will not run at all.
    return [];
  }

  const records = [];
  const seen = new Set();
  for (const entryName of entries) {
    // A leading zero (e.g. "007.json") is never a real pid -- kernels do not
    // hand out pid 0, and any process id ever starts with a nonzero digit --
    // so a name shaped like one is excluded rather than parsed into a number
    // that could otherwise collide with a real, differently-spelled pid.
    if (!/^[1-9]\d{0,9}\.json$/.test(entryName)) continue;
    const pid = Number(entryName.slice(0, -".json".length));

    let text;
    try {
      text = readFileSync(join(sessionsDir, entryName), "utf8");
    } catch {
      // Gone between the readdir and the read, or unreadable -- either way
      // not a session this call can report.
      continue;
    }

    const record = parseStateFile(text, pid);
    if (!record) continue;

    // One process per session id is the invariant every later stage leans on:
    // Stage 27 refuses to resume a busy session precisely because two
    // processes on one id is a fork, not a join. A duplicate here would
    // defeat that check before it ran, the same reason parseListing in
    // lib/agents.js dedupes the CLI's own listing.
    if (seen.has(record.sessionId)) continue;
    seen.add(record.sessionId);

    let stillAlive;
    try {
      stillAlive = await alive(record.pid, record.procStart);
    } catch {
      // processAlive itself never throws, but an injected opts.alive might;
      // a session this call cannot confirm is alive must not be reported as
      // one that is.
      stillAlive = false;
    }
    if (stillAlive) records.push(record);
  }

  return records;
}

// processAlive(pid, procStart) -> Promise<boolean>. Never throws.
//
// procStart is /proc/<pid>/stat's own starttime field, carried in the state
// file as a string. Comparing it against a fresh read of the same field is a
// pid-recycle guard: a dead process's pid can be reused by an unrelated one
// before this call runs, and matching only on pid would report that unrelated
// process as the session whose file this is.
//
// On Linux that guard is the ONLY check -- a missing procStart or an
// unreadable /proc/<pid>/stat is reported dead rather than falling back to a
// weaker check, because this pid is what lib/spawn-session.js's stopSession
// signs a SIGTERM with, and a bare kill(pid, 0) cannot tell a live session
// from an unrelated process that happens to hold the same number right now.
// A state file missing the one field that would prove it is the cheapest way
// to force that weaker path, so it must not be rewarded with a pass.
//
// Off Linux there is no /proc to check against, so the bare kill(pid, 0)
// liveness check -- the same one stopSession's own `gone()` uses -- is the
// only thing available, and is used unconditionally there.
export async function processAlive(pid, procStart) {
  if (process.platform === "linux") {
    if (typeof procStart !== "string" || procStart === "") return false;
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm is parenthesised and may itself contain spaces or parens (a
      // process can rename itself to include either), so this splits after
      // the LAST ")" rather than the first -- the only anchor that is safe
      // regardless of what comm contains.
      const idx = text.lastIndexOf(")");
      const fields = text.slice(idx + 1).trim().split(/\s+/);
      // fields[0] here is /proc/[pid]/stat's field 3 (state), because the
      // pid and the parenthesised comm were both consumed by the split
      // above. Field 22 (starttime) is therefore at index 22 - 3 = 19.
      return fields[19] === procStart;
    } catch {
      // Unreadable -- sandboxed, or the pid already reaped between the
      // readdir and this call -- is dead, not a hop down to a weaker check.
      return false;
    }
  }

  try {
    // Signal 0 sends nothing and only asks whether the process exists.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is owned by someone else -- still alive, just
    // not ours to signal further. Any other error (ESRCH, or a pid so
    // malformed the call itself fails) means it is not there.
    return err?.code === "EPERM";
  }
}
