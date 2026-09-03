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

import { positiveMs, runCli } from "./run-cli.js";
import { DEDUPE_MS } from "./hooks.js";
import { basename, sep } from "node:path";

// A listing sits on the critical path of a spoken turn, so it gets a short
// leash. Past this the turn goes ahead without a roster, which is the correct
// trade: knowing what is running is a nicety, answering is not.
export const LIST_TIMEOUT_MS = 3000;

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
// model that named itself — and this text is spoken and, in Phase C, recorded
// in the recap log. Control characters could forge structure; bidi overrides
// could reverse how a name reads on screen.
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
export function asPid(value) {
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
// stage resumes, queues against and records recap events by. A record without
// one cannot be acted on, so it is not worth reporting.
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
// name used to carry a per-repo counter: "session three" is something Krane
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
// is worth refusing over punctuation. `maxChars` defaults to a session
// name's own generous clip (cleanLabel's default is smaller, MAX_NAME_CHARS);
// mentionedSessions passes a much larger ceiling for the haystack it
// searches, which is a whole turn's words rather than one name.
function normalizeName(value, maxChars = 100) {
  return cleanLabel(value, maxChars).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

// A session name is short and normalizeName's default 100-char clip is
// generous for one, but the haystack mentionedSessions searches is a whole
// turn's words, unanswered sentences included -- a rambling opening clause
// can easily push the actual name past char 100, and the default clip would
// silently drop it before the search ever ran. Generous enough that no turn
// anyone actually speaks reaches it.
const MAX_HAYSTACK_CHARS = 4000;

// The longest run of consecutive tokens mentionedSessions will try as one
// candidate name -- a session name is rarely more than a couple of spoken
// words, and letting it grow unbounded would make one long sentence try
// exponentially many substrings for no realistic gain.
const MAX_MENTION_TOKENS = 3;

// mentionedSessions(text, candidates) -> the names of `candidates` a turn's
// words could plausibly be naming. Reuses matchSessions rather than growing
// a second, independently-drifting matcher: the same shorthand every other
// verb accepts ("review" finding a session named "review-2") has to work
// here too, and matchSessions is where that tiering already lives.
//
// The normalized haystack is split into dash-separated tokens, and every
// run of 1 to MAX_MENTION_TOKENS consecutive tokens is tried in turn against
// matchSessions, longest run first at each starting position -- stopping at
// the first length that matches anything, so a full, more specific run
// (e.g. "jarvis-3") is always given the chance to resolve via matchSessions'
// own exact tier before a shorter, more generic prefix of it (e.g. "jarvis")
// is ever tried on its own. Only the EXACT and PREFIX tiers are accepted
// here (checked by hand against the run, since matchSessions itself does not
// say which tier answered); the TAIL tier -- "the query carries a repository
// name in front of the session's own name" -- is deliberately never
// consulted: it exists for a query that IS the whole name plus a leading
// repo word, and trying it against every short run cut from an unrelated
// sentence would over-match on ordinary speech that happens to end in a
// real session name.
export function mentionedSessions(text, candidates) {
  const haystack = normalizeName(text, MAX_HAYSTACK_CHARS);
  if (!haystack) return [];

  const list = Array.isArray(candidates) ? candidates : [];
  const tokens = haystack.split("-").filter(Boolean);
  const found = new Set();

  for (let start = 0; start < tokens.length; start++) {
    const maxLen = Math.min(MAX_MENTION_TOKENS, tokens.length - start);
    for (let len = maxLen; len >= 1; len--) {
      const run = tokens.slice(start, start + len).join("-");
      const matched = matchSessions(list, run).filter((record) => {
        const norm = normalizeName(record?.name);
        return norm === run || norm.startsWith(`${run}-`);
      });
      if (matched.length === 0) continue; // try a shorter run at this same start
      for (const record of matched) found.add(record.name);
      break; // a match at this length wins; do not also try shorter, vaguer runs here
    }
  }
  return [...found];
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
export function within(path, root) {
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

// matchStarted(roster, { shortId, name, cwd, since }) -> record | null
//
// Which roster record a session that was just started turned out to be.
// `shortId` -- read off the CLI's own "backgrounded" confirmation by
// parseStartedId in lib/spawn-session.js -- is the daemon's own id and is
// checked first, and matched exactly: it can belong to at most one record.
//
// `name` is only ever a fallback, for when shortId came back null (stdout
// carried nothing parseStartedId recognised). It is not the primary key
// because it is unique only among sessions that are alive *right now* --
// buildName in server.js reuses the name of one that has since ended, so an
// older, unrelated record can carry the same label as the one just started.
// Newest-by-startedAt among the name's collisions is the least-wrong guess
// available: the session just started is always the most recent to carry it.
//
// The name fallback is bounded two ways, and both matter: a background
// session sharing the slug but running somewhere else entirely — one Dante
// cannot see and was never asked to start — used to become the remembered
// session, which counted against the cap and could fire a chain meant for a
// different process. `cwd` (checked with `within`, the same rule
// visibleSessions uses) confines the guess to the workspace the start was
// actually asked for; `since` (with a small tolerance, because the two clocks
// involved are this machine's own) confines it to sessions that did not exist
// before this start was asked for. A record failing either bound is not "the
// least-wrong guess" any more, just a wrong one — return null so the caller
// keeps polling instead of settling for it early.
export function matchStarted(roster, { shortId, name, cwd, since } = {}) {
  const list = Array.isArray(roster) ? roster : [];

  const id = typeof shortId === "string" ? shortId : "";
  if (id) {
    const byId = list.find((record) => record.id === id);
    if (byId) return byId;
  }

  const label = typeof name === "string" ? name : "";
  if (!label) return null;

  const root = typeof cwd === "string" ? cwd : "";
  // Two seconds of slack, not zero: `since` is read on this process just
  // before spawn, and startedAt comes back off the daemon's own clock, so the
  // two can disagree by a hair even for the very session being waited on.
  const floor = Number.isFinite(since) ? since - 2000 : null;

  return list
    .filter((record) => record.kind === "background" && record.name === label)
    .filter((record) => !root || within(record.cwd, root))
    .filter((record) => floor === null || (record.startedAt ?? -Infinity) >= floor)
    .reduce(
      (newest, record) =>
        !newest || (record.startedAt ?? -Infinity) > (newest.startedAt ?? -Infinity) ? record : newest,
      null,
    );
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
  if (isDone(record)) return false;
  return record.status === "busy";
}

// The one terminal state the listing reports. Not `!isWorking`: an interactive
// session with no state and status idle is not finished, it is a terminal
// someone is sitting at, and its clock must keep running. Written once so a
// future terminal value from the CLI is added in one place rather than three.
export function isDone(record) {
  return isPlainObject(record) && record.state === "done";
}

// ---------------------------------------------------------------------------
// When a session finished
// ---------------------------------------------------------------------------
//
// The listing says when a session started and that it is done, and nothing
// about when it finished -- checked against a live `claude agents --json`: a
// done record carries `startedAt` and `state: "done"` and no end time at all.
// Everything that drew "how long it has been at it" took now minus startedAt,
// so a done session's clock kept counting for as long as it sat on the roster,
// and reloading the page did not help because nothing on the wire said
// otherwise. The tick that first sees a session done is the closest thing to
// a finish time this side of the daemon has, so that tick's clock is kept for
// it, in a map the poller owns, and stamped onto the roster it hands out.
//
// The map is fed from the RAW listing rather than the filtered roster on
// purpose. A session can drop out of the filtered roster for one tick (a
// listing that omitted its cwd, a workspace renamed) and come back; keyed off
// the roster it hands out, the poller would forget the stamp and take it
// again, and a clock on a finished thing moved. Keyed off what the CLI
// reported, it moves only when the CLI says the session is no longer done.

// trackEnded(previous, listing, now) -> Map<sessionId, endedAt>
//
// Pure. A session done in `listing` keeps the time it already had or takes
// `now`; one that is not done, or not listed, is dropped -- a done session that
// is resumed (Stage 27 joins an idle session) is back on a live clock, and
// finishing again takes a fresh time. `previous` may carry times the listing
// has not confirmed yet: a Stop hook lands ahead of the tick that would see
// the session done, and the poller's own seed after a restart comes from the
// memory store. Both are kept iff the listing agrees the session is done.
export function trackEnded(previous, listing, now = Date.now()) {
  const before = previous instanceof Map ? previous : new Map();
  const ended = new Map();
  if (!Array.isArray(listing)) return ended;
  for (const record of listing) {
    if (!isDone(record) || typeof record.sessionId !== "string" || !record.sessionId) continue;
    const kept = before.get(record.sessionId);
    ended.set(record.sessionId, Number.isFinite(kept) ? kept : now);
  }
  return ended;
}

// stampEnded(roster, ended) -> roster, with `endedAt` on every done record the
// map has a time for. Records are handed back untouched otherwise, so a live
// one never carries the key at all.
export function stampEnded(roster, ended) {
  if (!Array.isArray(roster)) return roster;
  const times = ended instanceof Map ? ended : new Map();
  // Nothing done is the common tick, and it should not cost a copy.
  if (times.size === 0) return roster;
  return roster.map((record) => {
    if (!isDone(record)) return record;
    const at = times.get(record.sessionId);
    return Number.isFinite(at) ? { ...record, endedAt: at } : record;
  });
}

// endedAtOf(record) -> the stamp on a done record, or null. The one reading
// of "this record has a finish time", used by the wire and the hook path alike
// so the rule cannot drift between them.
export function endedAtOf(record) {
  return isDone(record) && Number.isFinite(record.endedAt) ? record.endedAt : null;
}

// completedIn(startedAt, endedAt, now) -> how long the session took, in ms,
// or undefined when nobody knows when it started. endedAt is the poller's
// stamp when there is one and `now` when there is not. public/roster-panel.js
// carries a local copy of this rule in rowFromRecord, the way it carries one of
// lib/notify.js's duration format: public/ cannot import from lib/.
export function completedIn(startedAt, endedAt, now = Date.now()) {
  if (!Number.isFinite(startedAt)) return undefined;
  return (Number.isFinite(endedAt) ? endedAt : now) - startedAt;
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
      continue;
    }
    // A finish time that moved on a session that stayed done -- a Stop hook
    // refining the stamp (noteEnded) after the tick that first took it. Not
    // a state change, but the panel is showing the old time, and the roster
    // only goes out on an event.
    const wasAt = endedAtOf(was);
    const nowAt = endedAtOf(record);
    if (wasAt !== null && nowAt !== null && wasAt !== nowAt) {
      events.push({ kind: "finished", session: record });
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
export async function listAgents(opts = {}) {
  const args = ["agents", "--json"];
  if (typeof opts.cwd === "string" && opts.cwd !== "") args.push("--cwd", opts.cwd);
  if (opts.all) args.push("--all");

  const { status, code, stdout, truncated } = await runCli(opts.bin ?? "claude", args, {
    timeoutMs: positiveMs(opts.timeoutMs, LIST_TIMEOUT_MS),
    killGraceMs: opts.killGraceMs,
    // stderr is drained and discarded: a warning nobody wanted is not a roster.
    maxStderr: 0,
  });
  // A non-zero exit means the CLI itself is unhappy -- an unknown subcommand
  // on an older version, most likely -- and whatever it printed is not a
  // roster. Neither is a truncated one: the CLI's output is a few hundred
  // bytes per session, so past the cap is a runaway, and half a roster read as
  // a whole one would report live sessions as gone.
  if (status !== "exited" || code !== 0 || truncated) return null;
  return parseListing(stdout);
}


// ---------------------------------------------------------------------------
// Impure: watching the roster
// ---------------------------------------------------------------------------

// createRosterPoller(opts) -> { start, stop, read, current, fresh, noteEnded, endedAt }
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
  // When each done session was first seen done -- see trackEnded. Survives a
  // session dropping out of the filtered roster, and outlives nothing else:
  // a restart starts it empty unless the server seeds it via noteEnded.
  let ended = new Map();
  let takenAt = 0;
  // Counts successful listings, so fresh() can tell a re-read that worked from
  // one that fell back to the last roster -- takenAt alone cannot, at
  // millisecond resolution, when the previous tick landed the same instant.
  let generation = 0;
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
      if (Array.isArray(next)) {
        // The finish times are kept off the raw listing, before the filter,
        // for the reason trackEnded's comment gives; a failed listing leaves
        // them be.
        ended = trackEnded(ended, next, now());
        if (filter) {
          try {
            const filtered = filter(next);
            next = Array.isArray(filtered) ? filtered : [];
          } catch {
            // A filter that throws must not be read as "nothing is running",
            // which would announce every session as gone. Treat it as a failed
            // listing.
            next = null;
          }
        }
      }
      if (Array.isArray(next)) {
        // After the filter, because orderRoster builds fresh records each tick
        // and the stamp has to land on the records that are actually handed out.
        next = stampEnded(next, ended);
        const events = diffRoster(roster, next);
        roster = next;
        takenAt = now();
        generation += 1;
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

    // A finish time from somewhere other than a tick: the Stop hook, which
    // fires at the moment itself and can beat the tick that would stamp it by
    // up to POLL_MS, and the memory store, which is where a stamp taken before
    // a restart survives. The listing still decides: the time is kept only
    // while it reports the session done (trackEnded), and a Stop for a session
    // that was done, resumed and finished again inside one poll window is
    // exactly what refreshes a stamp the listing alone could never move.
    //
    // Except inside DEDUPE_MS of the stamp it would replace. A hook can fire
    // twice for one exit (lib/hooks.js says why), and a retry is byte-for-byte
    // the first Stop again, so nothing but the gap tells it from a genuine
    // second finish; the completion report already reads that gap as a retry,
    // and so does this, or a clock on a finished thing would move on every
    // retry. A re-finish that quick keeps the earlier time, which is still a
    // constant. Returns the time now in force. Takes effect on the roster
    // from the next tick; this is not a tick.
    noteEnded(sessionId, at) {
      if (typeof sessionId !== "string" || !sessionId || !Number.isFinite(at)) return null;
      const had = ended.get(sessionId);
      if (Number.isFinite(had) && at - had < DEDUPE_MS) return had;
      ended.set(sessionId, at);
      return at;
    },

    // The time in force for one session, or null. Read straight off the map
    // rather than off current(): a SessionEnd can land on a tick whose roster
    // the filter happened to drop the session from, and the map is what
    // survives that (trackEnded's comment says why it is kept off the filter).
    endedAt(sessionId) {
      const at = typeof sessionId === "string" ? ended.get(sessionId) : undefined;
      return Number.isFinite(at) ? at : null;
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

    // A roster taken now, or null if it could not be. read() keeps the last
    // roster when a listing fails, which is right for a panel and wrong for a
    // verdict: a stop checked against a roster from before the stop would
    // report the session still there. A tick already in flight is waited out
    // first for the same reason -- it started before whatever the caller just
    // did, so its answer is not evidence about it.
    async fresh() {
      if (inFlight) await inFlight;
      const seen = generation;
      const result = await tick();
      return generation > seen ? result : null;
    },
  };
}
