// The roster: what Claude Code sessions exist on this machine right now.
//
// `claude agents --json` is the whole mechanism. It prints every live session —
// interactive terminals included, not just the ones Dante started — and it
// explicitly does not require a TTY, so it is a plain child process of the same
// shape lib/builder.js already spawns.
//
// Split the way the rest of lib/ is split: parseRoster and describeRoster are
// pure and carry all the interesting decisions, listAgents is a thin impure
// runner with an injectable `opts.bin` so the tests can point it at a fake CLI
// written to disk. Nothing here throws. A roster Dante cannot read costs it
// the roster for one turn; it must never cost it the turn.

import { spawn } from "node:child_process";
import { basename, sep } from "node:path";

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

// The one ceiling for every view of the roster: the wire, the panel, and the
// numbered lines the model is told. Fifteen sessions is the point past which
// nobody can hold the machine in their head regardless of whether the list is
// spoken or read off a screen -- and a numbered line is sayable at a length a
// prose sentence never was, which is what let this move from five to fifteen.
// (lib/recall.js keeps its own, smaller MAX_SPOKEN for *finished* sessions,
// which are still read out as a prose sentence rather than numbered lines.)
export const MAX_LISTED = 15;

// A session name is a label, not a sentence, and it is read out loud.
export const MAX_NAME_CHARS = 60;

// The same character class lib/memory.js:37 strips, redeclared here for the
// same reason it is redeclared there: this module has its own reasons to
// change. Session names come from whoever started the session — including a
// model that named itself — and this text is spoken and, in Phase C, posted to
// Slack. Control characters could forge structure; bidi overrides could reverse
// how a name reads on screen.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Whitespace collapsed before the unprintables are stripped: a newline is both,
// and stripping it first would fuse the words on either side of it together.
function cleanLabel(value, maxChars = MAX_NAME_CHARS) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
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
// exists, and dropping it would make Dante confidently wrong about what is
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
  return parseListing(stdout) ?? [];
}

// The same parse, but able to say "that was not a listing at all" — null for
// output that could not be read, an array (possibly empty) for output that
// could. listAgents needs the distinction and callers of parseRoster do not:
// "nothing is running" and "I could not find out" are the same non-answer to a
// pure function, and opposite answers to someone asking out loud.
function parseListing(stdout) {
  if (typeof stdout !== "string") return null;

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Includes the empty string, which is what a CLI that is not installed
    // leaves on stdout.
    return null;
  }
  if (!Array.isArray(parsed)) return null;

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

// Extended through fifteen: MAX_LISTED sessions numbered means a hidden count
// past that, or the miss refusal in lib/confirm.js's findTarget, can now name
// a number as large as the ceiling itself rather than falling back to a
// digit read aloud.
const COUNT_WORDS = [
  "no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen",
];

export function countWord(n) {
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
//
// A cwd INSIDE a workspace counts too, not only one equal to it, because
// Dante's own sessions move there: verb=start's EnterWorktree lands a session
// under <repo>/.claude/worktrees/<name>, and visibleSessions already treats
// that as inside the repo (it uses this same `within` check). Naming it by the
// directory's own basename instead of the workspace's alias is how "tell
// jarvis-10 ..." broke - the session was read aloud as
// "repo-persistence: jarvis-10-...", the model copied that whole string into
// the tag's unquoted name=, and it no longer matched anything on the roster.
// When two aliased workspaces nest, the longest matching root wins, the same
// way a more specific path should always beat a shorter one that also matches.
export function aliasFor(cwd, aliases) {
  if (typeof cwd !== "string" || cwd === "") return "";
  if (isPlainObject(aliases)) {
    let best = null;
    for (const [alias, path] of Object.entries(aliases)) {
      if (typeof path !== "string" || !within(cwd, path)) continue;
      if (!best || path.length > best.path.length) best = { alias, path };
    }
    if (best) return cleanLabel(best.alias, 40);
  }
  return cleanLabel(basename(cwd), 40);
}

// orderRoster(roster, { aliases, order }) -> [{ ...record, alias, number }]
//
// One canonical order, computed once, so the wire (rosterForClient), the panel
// and the numbered lines the model is told (describeRoster) can never disagree
// about what "session three" means -- three different call sites reading the
// roster in three different orders is exactly how that would happen.
//
// Global rather than per-repository, on purpose, even though a session's own
// name used to carry a per-repo counter: "session three" is something Jesse
// says about the panel he is looking at, and the panel is one list with one
// repository above another, not several lists each starting over at one.
//
// Oldest first inside a repository, not newest: numbers must only move when
// something they refer to actually stops, never on every poll tick just
// because a new session appeared. Newest-first would renumber every existing
// session the moment one more started, which is exactly the property that
// makes "session three" worth saying twice in a row.
//
// `aliases` is the alias-to-path map (lib/memory.js's workspacePaths); `order`
// is the alias list in the order they should appear (lib/memory.js's
// workspacesForClient, main first, then alphabetical). A session whose alias
// is not in `order` -- a stale one, or one added after `order` was read --
// still gets a number, just after every named repository's sessions: a hidden
// sixteenth session must still resolve by number even though the panel never
// draws it (rosterForClient slices the numbered list afterward, not before).
export function orderRoster(roster, { aliases, order } = {}) {
  const list = Array.isArray(roster) ? roster : [];
  // De-duplicated: `order` comes from workspacesForClient's own alias list,
  // which is already unique, but a caller that built one by hand (a test, or
  // a future one) could repeat an alias -- and a repeated bucket key would
  // walk the same sessions into `ordered` twice, numbering one of them twice
  // over.
  const known = [...new Set(toStringList(order))];

  const buckets = new Map(known.map((alias) => [alias, []]));
  const leftover = [];

  for (const record of list) {
    // Same posture visibleSessions takes on its own roster: a record that is
    // not a plain object (null, a string, whatever a hand-built test roster
    // or a stray CLI line produced) is not a session to number, and reading
    // `.cwd` off one that is null or undefined would throw rather than skip.
    if (!isPlainObject(record)) continue;
    const alias = aliasFor(record.cwd, aliases);
    const tagged = { ...record, alias };
    if (buckets.has(alias)) buckets.get(alias).push(tagged);
    else leftover.push(tagged);
  }

  // Oldest first; a missing startedAt sorts last within its own bucket rather
  // than first, the same posture ownRunning takes -- an unknown age is not
  // evidence of being the oldest. sessionId is the tiebreak so two sessions
  // that started in the same millisecond still get a stable, repeatable order
  // rather than one that depends on whatever order the CLI happened to print
  // them in this tick.
  const byStartedThenId = (a, b) => {
    const at = Number.isFinite(a.startedAt) ? a.startedAt : Infinity;
    const bt = Number.isFinite(b.startedAt) ? b.startedAt : Infinity;
    if (at !== bt) return at - bt;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  };

  const ordered = [];
  for (const alias of known) ordered.push(...buckets.get(alias).sort(byStartedThenId));
  ordered.push(...leftover.sort(byStartedThenId));

  return ordered.map((record, i) => ({ ...record, number: i + 1 }));
}

// describeRoster(roster, now) -> numbered lines, ready to be read as machine
// state, one session per line, joined by "\n".
//
// `roster` is expected to already be orderRoster's own output: numbered,
// canonically ordered, each record carrying its `alias`. This function no
// longer computes either -- it used to (see `label`, removed along with the
// old sentence format this replaced), but a session's number and repository
// are now facts about its position in the one shared order, decided once in
// lib/agents.js's orderRoster and carried on the record, not something a
// second function should be free to recompute differently.
//
// A number is what lets a person say "session three" and a spoken sentence of
// up to five names could never carry that meaning -- a prose sentence forgets
// which clause was which the moment it is spoken. Numbered lines do not need
// that trim: a machine-state block is read by the model, not read aloud, so
// the whole roster (up to MAX_LISTED) is worth sending even though nobody
// would ever say fifteen session names out loud in one breath.
//
// Voice-only in a different sense than the old sentence was: never a uuid,
// never a pid, never a path. `now` is a parameter rather than a Date.now()
// call so the line is deterministic under test.
export function describeRoster(roster, now = Date.now()) {
  const list = Array.isArray(roster) ? roster : [];
  if (list.length === 0) return "Nothing is running.";

  const shown = list.slice(0, MAX_LISTED);
  const lines = shown.map((record) => {
    const number = Number.isInteger(record.number) ? record.number : "?";
    const name = cleanLabel(record.name) || "an unnamed session";
    const alias = typeof record.alias === "string" ? record.alias : "";
    const where = alias ? ` in ${alias}` : "";
    const word = activity(record);
    // Elapsed time only where it is a fact someone is waiting on. Telling
    // someone an idle session has been idle for three hours is noise; telling
    // them a working one is four minutes in is the answer to their question.
    const since = word === "working" || word === "blocked" ? elapsed(record.startedAt, now) : "";
    return since ? `${number}: ${name}${where}, ${word}, ${since}` : `${number}: ${name}${where}, ${word}`;
  });

  const hidden = list.length - shown.length;
  if (hidden > 0) lines.push(`(${countWord(hidden)} more not shown)`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Finding one session in the roster
// ---------------------------------------------------------------------------

// Names arrive by voice, through a model, through a tag. "Jarvis 3" and
// "jarvis-3" and "JARVIS-3-review" are all the same request, and none of them
// is worth refusing over punctuation.
function normalizeName(value) {
  return cleanLabel(value, 100).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// matchSessions(roster, query) -> every session that could be the one meant.
//
// Returns a list rather than a best guess, because the two failure modes need
// different sentences: nothing matched is "I do not know a session called
// that", and several matched is "which one" — and silently picking the first of
// several is how "stop jarvis one" stops the wrong process.
//
// An exact name wins outright. Only when nothing matches exactly does this fall
// back to a prefix, so "jarvis-3" finds "jarvis-3-review" without also making
// an exactly-named session ambiguous with a longer one.
export function matchSessions(roster, query) {
  const wanted = normalizeName(query);
  if (!wanted) return [];

  const list = Array.isArray(roster) ? roster : [];
  const named = list.filter((record) => record.name);

  const exact = named.filter((record) => normalizeName(record.name) === wanted);
  if (exact.length > 0) return exact;

  const prefixed = named.filter((record) => normalizeName(record.name).startsWith(`${wanted}-`));
  if (prefixed.length > 0) return prefixed;

  // Last tier: the query carries a repository name in front of the session's
  // own name -- however that combination arrived, said that way out loud or
  // read off a numbered line where the alias and the name sit side by side
  // ("3: Empty Session in jarvis"). The whole name has to be the tail, so this
  // cannot match on a shared word.
  return named.filter((record) => wanted.endsWith(`-${normalizeName(record.name)}`));
}

// ---------------------------------------------------------------------------
// Whose business is it
// ---------------------------------------------------------------------------

// `claude agents --json` lists EVERY session on this machine, and treating that
// as the roster was a mistake. Other tools spawn sessions -- a claude-mem skill
// keeps one in ~/.claude-mem/observer-sessions -- and Dante spawns its own: the
// warm brain in lib/brain.js and a builder per build. Narrating those is noise;
// being able to STOP them is a bug with a process on the end of it.
//
// So the roster is filtered down to Dante's business, which is two rules:
// sessions in a repository you named out loud, minus Dante's own children.

// True when `path` is the root itself or somewhere underneath it. The same rule
// resolveWorkspacePath uses, and for the same reason: a plain startsWith would
// put /home/me/jarvis-notes inside /home/me/jarvis.
function within(path, root) {
  if (typeof path !== "string" || typeof root !== "string" || !path || !root) return false;
  const base = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return path === base || path.startsWith(base + sep);
}

function toStringSet(value) {
  const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  return new Set(list.filter((item) => typeof item === "string" && item));
}

function toStringList(value) {
  return (Array.isArray(value) ? value : []).filter((item) => typeof item === "string" && item);
}

// visibleSessions(roster, { roots, hideIds, hideRoots }) -> the sessions Dante
// may see, and therefore the only ones it can name, tell, count or stop.
//
// A whitelist rather than a blacklist, on purpose: the next tool to start
// spawning sessions in the background should be invisible on the day it is
// installed, not on the day someone notices it in a spoken roster.
//
// `roots` are the workspaces already in memory -- the same list that gives a
// session its alias and tells verb=start where it may spawn. One concept, not
// two. `hideIds` is exact, because "never offer to stop my own brain" is not a
// thing to do by name matching. `hideRoots` covers what has no id Dante knows
// but does have a known directory, which is every build.
export function visibleSessions(roster, opts = {}) {
  if (!Array.isArray(roster)) return [];

  const roots = toStringList(opts.roots);
  const hideRoots = toStringList(opts.hideRoots);
  const hideIds = toStringSet(opts.hideIds);

  return roster.filter((record) => {
    const cwd = typeof record?.cwd === "string" ? record.cwd : "";
    // A session that cannot be attributed to a directory cannot be attributed
    // to a repository either, so it is nobody's business here.
    if (!cwd) return false;
    if (hideIds.has(record.sessionId)) return false;
    if (hideRoots.some((root) => within(cwd, root))) return false;
    return roots.some((root) => within(cwd, root));
  });
}

// ownRunning(roster, remembered) -> { running, oldestIdle }
//
// How many of the sessions on the roster Dante itself started, and the name of
// the oldest of those that is idle.
//
// The count exists to bound how many unattended sessions Dante has running
// with nobody watching them. Counting every background session on the machine
// instead was a real bug: a Claude Code background job is indistinguishable
// from one Dante started, so a machine in ordinary use sat at four of five
// before Dante had done anything, every start was refused, and the refusal
// then named somebody else's session as the obvious thing to stop.
//
// `remembered` is the store's own record of what it started (getSessions in
// lib/memory.js). Intersecting it with the live roster is what makes this exact
// in both directions: a session started in a terminal never counts, and one
// Dante started that has since died does not either.
export function ownRunning(roster, remembered) {
  const list = Array.isArray(roster) ? roster : [];
  const known = isPlainObject(remembered) ? remembered : {};
  // Object.hasOwn, not `in`: the store is JSON off disk, and a key called
  // "constructor" must not report every session as one of Dante's own.
  const mine = list.filter(
    (record) => typeof record?.sessionId === "string" && Object.hasOwn(known, record.sessionId),
  );

  const idle = mine
    .filter((record) => !isWorking(record))
    // Oldest first, and a session with no start time sorts last rather than
    // first -- an unknown age is not evidence of being the stalest one.
    .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));

  return { running: mine.length, oldestIdle: idle.find((record) => record.name)?.name ?? null };
}

// ---------------------------------------------------------------------------
// What changed since last time
// ---------------------------------------------------------------------------

// How often the roster is re-read. Fast enough that "it just finished" is true
// when it is said, slow enough that a child process every tick is not a cost
// anyone notices.
export const POLL_MS = 5000;

// How stale a cached roster may be before a turn re-reads it rather than using
// it. Deliberately above POLL_MS: under a healthy poller the cache is at most one
// interval plus one successful listing old, since a tick starting at POLL_MS
// resolves, win or lose, within LIST_TIMEOUT_MS, so a turn spawns a child only
// when the poller has stalled, never succeeded, or setInterval drift pushed it
// past that bound. The old value put a `claude agents --json` boot on the
// critical path of ~40% of spoken turns, leashed at 3 s, before the model was
// asked — and this roster also feeds the session ceiling and stop/tell
// resolution.
export const MAX_ROSTER_AGE_MS = POLL_MS + LIST_TIMEOUT_MS;

// Whether a session is doing something, reduced to the one bit everything else
// keys off. `state` is the more specific field and wins where present; `status`
// is the fallback for the interactive sessions that carry no state.
//
// "blocked" counts as working on purpose: a session waiting on a permission
// prompt is not free to take a follow-up, and treating it as idle is exactly
// how Stage 27 would fork a session instead of joining it.
export function isWorking(record) {
  if (record.state === "working" || record.state === "blocked") return true;
  if (record.state === "done") return false;
  return record.status === "busy";
}

// diffRoster(previous, next) -> [{ kind, session }]
//
// `kind` is "gone" (the session ended), "started" (one appeared that Dante may
// not have started itself), "idle" (it stopped working — the event everything
// in Phase C waits for) or "busy" (it picked something up).
//
// A null `previous` means there is no baseline yet, and returns nothing. The
// first poll after startup must not announce six sessions that were already
// running before anyone asked — and a failed listing arriving as null must
// never be read as "everything ended at once".
export function diffRoster(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return [];

  const before = new Map(previous.map((record) => [record.sessionId, record]));
  const after = new Map(next.map((record) => [record.sessionId, record]));
  const events = [];

  // Endings first, and in the order they were last seen: what ended is the more
  // interesting half of any tick, and the half someone is waiting to hear.
  for (const record of previous) {
    if (!after.has(record.sessionId)) events.push({ kind: "gone", session: record });
  }

  for (const record of next) {
    const was = before.get(record.sessionId);
    if (!was) {
      events.push({ kind: "started", session: record });
      continue;
    }
    const wasWorking = isWorking(was);
    const nowWorking = isWorking(record);
    if (wasWorking !== nowWorking) {
      events.push({ kind: nowWorking ? "busy" : "idle", session: record });
    }
  }

  return events;
}

// The roster records for sessionIds that are idle right now, in roster order.
// A queued follow-up is re-checked against this every tick rather than only
// the tick a session crosses into idle, so idleAmong asks "is it idle" fresh
// each time instead of relying on a transition it might have missed.
export function idleAmong(roster, sessionIds) {
  if (!Array.isArray(roster)) return [];
  // Symmetric with the roster guard above: a caller passes a Set in practice,
  // but anything else -- undefined, a number, a plain object -- is nothing
  // queued rather than a crash. `new Set` on a non-iterable throws.
  const ids = sessionIds instanceof Set ? sessionIds : new Set(Array.isArray(sessionIds) ? sessionIds : []);
  return roster.filter((record) => !isWorking(record) && ids.has(record.sessionId));
}

// ---------------------------------------------------------------------------
// Impure: asking the CLI
// ---------------------------------------------------------------------------

// listAgents(opts) -> Promise<roster | null>. Never rejects.
//
// `opts.bin` points the spawn at a fake CLI under test, the same seam
// lib/builder.js exposes. `opts.cwd` narrows the listing to one repository via
// the CLI's own --cwd.
//
// The two empty answers are deliberately different values. An ARRAY means the
// CLI answered: an empty one is the fact that nothing is running, which is a
// real answer to a real question. NULL means it did not answer — missing,
// slow, crashing, or printing something that is not a listing — and the caller
// must go on without a roster rather than tell someone nothing is running when
// six sessions are.
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
      resolvePromise(null);
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
      finish(null);
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

    child.on("error", () => finish(null));
    child.on("close", (code) => {
      // A non-zero exit means the CLI itself is unhappy — an unknown subcommand
      // on an older version, most likely. Whatever it printed is not a roster.
      finish(code === 0 && !truncated ? parseListing(out) : null);
    });
  });
}


// ---------------------------------------------------------------------------
// Impure: watching the roster
// ---------------------------------------------------------------------------

// createRosterPoller(opts) -> { start, stop, read, current }
//
// One place that knows what is running, shared by everything that needs it.
// The turn reads it (cheaply, from cache); the ticks are what notice a session
// finishing while nobody is looking, which is what makes reporting work when
// the browser is closed.
//
// `opts.list` is the seam — the tests pass a function instead of spawning
// anything. `opts.onEvents(events, roster)` is called only when something
// actually changed — what changed. `opts.onRoster(roster)` is called on every
// successful tick regardless — what is currently true — because a queued
// follow-up needs re-checking against idle as a standing state, not an edge
// crossed once. Anything either callback throws is swallowed: a bad listener
// must not stop the poller that the queue and the reporting both depend on.
export function createRosterPoller(opts = {}) {
  const list = typeof opts.list === "function" ? opts.list : listAgents;
  const intervalMs =
    Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : POLL_MS;
  const maxAgeMs =
    Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs >= 0 ? opts.maxAgeMs : MAX_ROSTER_AGE_MS;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  // The one seam. Filtering here rather than at each call site is what makes
  // "hidden" mean hidden: the roster line in a turn, diffRoster's events,
  // matchSessions, queue delivery and the session ceiling all read what this
  // returns, so a session Dante may not see cannot be named, told, counted or
  // stopped by anything downstream.
  //
  // A function rather than a list, because both halves move at runtime: a
  // workspace named mid-conversation must widen it on the next tick, with no
  // restart.
  const filter = typeof opts.filter === "function" ? opts.filter : null;

  let roster = null;
  let takenAt = 0;
  let inFlight = null;
  let timer = null;

  async function tick() {
    // One listing at a time. A slow CLI plus a fixed interval is how a poller
    // ends up with three child processes racing to set the same baseline, and
    // the loser's stale answer would read as a diff.
    if (inFlight) return inFlight;

    inFlight = (async () => {
      let next = null;
      try {
        next = await list();
      } catch {
        // listAgents does not reject, but an injected one might, and a poller
        // that dies on its first bad tick is worse than one that misses it.
        next = null;
      }
      // null is "could not ask", not "nothing is running". Keeping the previous
      // baseline is what stops a CLI hiccup announcing that every session ended.
      if (Array.isArray(next) && filter) {
        try {
          const filtered = filter(next);
          next = Array.isArray(filtered) ? filtered : [];
        } catch {
          // A filter that throws must not be read as "nothing is running", which
          // would announce every session as gone. Treat it as a failed listing.
          next = null;
        }
      }
      if (Array.isArray(next)) {
        const events = diffRoster(roster, next);
        roster = next;
        takenAt = now();
        // Fires on every successful tick, changed or not: idle is a state a
        // queued follow-up must be re-checked against, not an edge crossed
        // once, since a queue can gain an entry — or survive a restart —
        // without the roster itself moving.
        if (typeof opts.onRoster === "function") {
          try {
            opts.onRoster(roster);
          } catch {
            // Same contract as onEvents below: a bad listener must not stop
            // the poller.
          }
        }
        if (events.length > 0 && typeof opts.onEvents === "function") {
          try {
            opts.onEvents(events, next);
          } catch {
            // A listener that throws is a bug in the listener. The queue and the
            // reporting both hang off this timer; it keeps going.
          }
        }
      }
      inFlight = null;
      return roster;
    })();

    return inFlight;
  }

  return {
    start() {
      if (timer) return;
      // Unreferenced, so a running poller never keeps the process alive on its
      // own — the server is held open by its socket, and nothing else should be.
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      // The first tick establishes the baseline rather than reporting on it:
      // diffRoster against a null previous is deliberately empty.
      tick();
      return this;
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    // What was last seen, without asking. null until the first successful tick.
    current() {
      return roster;
    },

    // What is running, fresh enough to say out loud. Uses the cache when it is
    // young and re-reads when it is not, so a turn costs a child process only
    // when it lands between ticks.
    //
    // opts.maxAgeMs overrides the poller's own bound for this call only.
    // server.js uses it on the way into a stop after a proposal wait, because
    // a stop resolves a name against a real process, and with the default age
    // now above POLL_MS that call would otherwise get the same cache the
    // proposal was built from.
    async read(opts = {}) {
      const bound =
        Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs >= 0 ? opts.maxAgeMs : maxAgeMs;
      // Strictly less than, so a maxAgeMs of 0 means "always re-read" rather
      // than "reuse anything taken this millisecond".
      if (roster && now() - takenAt < bound) return roster;
      return tick();
    },
  };
}
