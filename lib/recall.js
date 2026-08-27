// Which sessions can be read right now.
//
// Everything else here is about sessions that are RUNNING: the roster names
// them, verb=tell speaks to them, verb=stop signals them. The moment one ends it
// falls off `claude agents --json` and becomes unnameable -- which is exactly
// when the interesting question gets asked, because the interesting question is
// "what came of it" and nobody is standing at the terminal to read the answer.
//
// So this module answers "which session", and lib/transcript.js does the
// reading. The rule both obey is that THE TRANSCRIPT ON DISK IS THE ONLY
// SOURCE. Reading a session here means reading the file Claude Code itself
// keeps, which is the same thing you would see by opening that session in a
// terminal and scrolling back. Nothing is copied, summarized ahead of time, or
// kept anywhere else, and the consequence is the one that matters: delete a
// session and it stops being readable, immediately and completely, with nothing
// left behind to answer in its place.
//
// That is why the list below is a filter over things that already exist -- the
// live roster, the store's record of what jarvis started, the files on disk --
// and never a list this module maintains.
//
// The whitelist applies here too. A repository dropped from memory must stop
// being readable, or "jarvis only sees the repositories you named out loud" is
// true of live sessions and quietly false of finished ones.

import { basename, sep } from "node:path";

import { hasTranscript } from "./transcript.js";

// The same ceiling describeRoster uses, for the same reason: a spoken list past
// five names is a list nobody is holding in their head anyway.
export const MAX_SPOKEN = 5;

export const MAX_NAME_CHARS = 60;

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

function cleanLabel(value, maxChars = MAX_NAME_CHARS) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// True when `path` is the root itself or somewhere underneath it. Copied in
// spirit from visibleSessions in lib/agents.js and deliberately the same rule: a
// plain startsWith would put /home/me/jarvis-notes inside /home/me/jarvis, and
// the whitelist would have a hole in it that nobody would ever notice.
function within(path, root) {
  if (typeof path !== "string" || typeof root !== "string" || !path || !root) return false;
  const base = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return path === base || path.startsWith(base + sep);
}

function toStringList(value) {
  return (Array.isArray(value) ? value : []).filter((item) => typeof item === "string" && item);
}

// recallableSessions(remembered, roster, opts) -> records, newest first.
//
// `remembered` is the store's own record of what jarvis started (getSessions in
// lib/memory.js). `roster` is the live listing, ALREADY filtered by
// visibleSessions -- or null when the listing failed, which is a different thing
// from an empty one and is carried through as such.
//
// Each record comes back as:
//   { sessionId, name, cwd, task, at, running }
//
// `running` is a tri-state and that is the point. `true` and `false` are facts;
// `null` means the listing failed and jarvis genuinely does not know. A read is
// harmless either way -- unlike stop, nothing here signals a process -- so an
// unknown state costs a hedge in the sentence rather than a refusal.
export function recallableSessions(remembered, roster, opts = {}) {
  const known = isPlainObject(remembered) ? remembered : {};
  const roots = toStringList(opts.roots);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const exists = typeof opts.exists === "function" ? opts.exists : hasTranscript;

  // null is "I could not ask", and it must not be read as "nothing is running":
  // that would report every session jarvis started today as finished.
  const live = Array.isArray(roster) ? roster : null;
  const liveById = new Map(
    (live ?? [])
      .filter((record) => typeof record?.sessionId === "string" && record.sessionId)
      .map((record) => [record.sessionId, record]),
  );

  const records = new Map();

  // Object.hasOwn territory: the store is JSON off disk, so it is walked by its
  // own keys rather than indexed by a string that might be "constructor".
  for (const [sessionId, entry] of Object.entries(known)) {
    if (!isPlainObject(entry)) continue;
    const at = Number.isFinite(entry.at) ? entry.at : null;
    // An undated record is kept: it is a real session jarvis started, and
    // refusing to read it because the timestamp is missing would be a worse
    // answer than reading it.

    const alive = liveById.get(sessionId);
    const cwd = typeof alive?.cwd === "string" && alive.cwd ? alive.cwd : entry.cwd;
    records.set(sessionId, {
      sessionId,
      // The live name wins where there is one: a session can be renamed after
      // it starts, and the roster is what the person just heard read out.
      name: cleanLabel(alive?.name ?? entry.name),
      cwd: typeof cwd === "string" ? cwd : "",
      task: typeof entry.task === "string" ? entry.task : "",
      at,
      running: live === null ? null : liveById.has(sessionId),
    });
  }

  // Sessions jarvis did not start but can see: a terminal in a whitelisted
  // repository, half an hour into something. It has a transcript and a name, and
  // "what has that one been doing" is the same question with the same answer.
  for (const record of live ?? []) {
    const sessionId = record?.sessionId;
    if (typeof sessionId !== "string" || !sessionId || records.has(sessionId)) continue;
    records.set(sessionId, {
      sessionId,
      name: cleanLabel(record.name),
      cwd: typeof record.cwd === "string" ? record.cwd : "",
      task: "",
      at: Number.isFinite(record.startedAt) ? record.startedAt : null,
      running: true,
    });
  }

  return [...records.values()]
    // The whitelist, applied here and not only at start time. A repository
    // dropped from memory stops being readable on the next turn, which is what
    // makes "only the repositories you named" true of finished sessions too.
    .filter((record) => record.cwd && roots.some((root) => within(record.cwd, root)))
    // A session with no name cannot be asked for by name, and every path into
    // this list is a name someone said.
    .filter((record) => record.name)
    // The stat that actually decides readability, run last because it is the
    // only expensive check here and the two above already dropped whatever was
    // never a candidate. This is the boundary the whole module exists to draw:
    // a deleted session has no transcript on disk, so it fails here and falls
    // out of the list with nothing cached anywhere to answer in its place.
    .filter((record) => exists(record.cwd, record.sessionId, opts))
    // Newest first: "the one I just started" is the overwhelmingly likely
    // referent, and an undated record sorts last rather than first.
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
}

// alias -> path inverted, so a session's directory can be named. Same fallback
// as lib/agents.js: the directory's own basename for a repo nobody has aliased.
function aliasFor(cwd, aliases) {
  if (typeof cwd !== "string" || cwd === "") return "";
  if (isPlainObject(aliases)) {
    for (const [alias, path] of Object.entries(aliases)) {
      if (typeof path === "string" && path === cwd) return cleanLabel(alias, 40);
    }
  }
  return cleanLabel(basename(cwd), 40);
}

// How long ago it finished, spoken. Rounded hard, for the reason elapsed() in
// lib/agents.js is: "an hour ago" is what a person wants to hear.
function ago(at, now) {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return "";
  const ms = now - at;
  // A clock that went backwards must not say "in -3 minutes".
  if (ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "a minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour ago" : `${hours} hours ago`;
}

// describeFinished(records, aliases, now) -> one short line for the turn, or ""
// when there is nothing worth a line.
//
// Only the finished ones. The running ones already have a line of their own
// (describeRoster), and naming a session twice in one turn is how a model ends
// up believing there are two of it.
//
// This exists so the model can hear a name it would otherwise have no way to
// know: a finished session is on no roster, so without this "what did jarvis
// three produce" is a question about something the model has never been told
// about.
export function describeFinished(records, aliases = {}, now = Date.now()) {
  const list = (Array.isArray(records) ? records : []).filter((record) => record?.running === false);
  if (list.length === 0) return "";

  const shown = list.slice(0, MAX_SPOKEN);
  const parts = shown.map((record) => {
    const alias = aliasFor(record.cwd, aliases);
    // A session jarvis named already starts with its repo alias
    // (jarvis-1-builder-test-fix); prefixing it again reads as "jarvis: jarvis-1".
    const named = !alias || record.name.toLowerCase().startsWith(alias.toLowerCase())
      ? record.name
      : `${alias}: ${record.name}`;
    const when = ago(record.at, now);
    return when ? `${named} (${when})` : named;
  });

  const hidden = list.length - shown.length;
  if (hidden > 0) parts.push(`and ${hidden} more`);

  return `Finished, still readable: ${parts.join("; ")}`;
}
