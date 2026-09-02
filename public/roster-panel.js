// The sessions panel: what is running, in a corner of its own.
//
// The build HUD beside this one is a canvas groove that a build cuts for
// itself, and it is about one build in one directory. Sessions are the more
// important thing now and they are a different shape: several at once, each
// mostly idle, each interesting for its name, its repository and how long it
// has been at it. That is a list, not a spiral, so it is a list -- the HUD is
// left alone to do the thing it is good at.
//
// One of the pure client modules (the *-policy.js files, clip-stream.js,
// roster-panel.js): browser-safe, no DOM, imported by app.js and the tests.
// app.js paints; every decision that can be a function is one here, where it
// can be tested.

// Matches the server's own MAX_LISTED (lib/agents.js): a dedicated panel has
// room for everything the server ever sends, so the cap is about agreeing
// with the wire shape rather than about trimming for space. A local copy
// rather than an import -- public/ is served straight off disk with no
// bundler, and cannot import from lib/.
export const MAX_ROWS = 15;

// Below this, "0s" flickering on every tick says less than nothing.
const MIN_ELAPSED_MS = 1000;

// A local copy of the duration format lib/notify.js uses. public/ is served
// straight off disk with no bundler, so it cannot import from lib/ -- the same
// constraint that keeps the browser dependency-free. Sixteen lines of agreement
// is cheaper than a build step.
export function elapsedLabel(ms) {
  if (!Number.isFinite(ms) || ms < MIN_ELAPSED_MS) return "";
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// A session's one-word condition. "blocked" is its own word rather than folded
// into working, because it is the one a person can do something about.
function condition(record) {
  if (record.state === "blocked") return "blocked";
  if (record.state === "working") return "working";
  if (record.state === "done") return "done";
  return record.status === "busy" ? "working" : "idle";
}

// The one row shape both rowsFromRoster and groupsFromRoster paint. Split out
// so a repository's rows and a flat list of them are built the same way and
// can never quietly drift apart.
function rowFromRecord(record, now) {
  return {
    id: record.sessionId,
    // A session with no name is still worth a row: something is running, and
    // saying so with a blank name beats leaving a gap in the count.
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : "unnamed",
    where: typeof record.alias === "string" ? record.alias : "",
    // The server numbers the roster once, the same way for the panel and for
    // the model (lib/agents.js's orderRoster) -- a row's own number is that
    // decision, not this panel's, so a click and a spoken "session three" name
    // the same session.
    number: Number.isInteger(record.number) ? record.number : null,
    condition: condition(record),
    // A finished session's clock stops where the server says it finished
    // (endedAt, stamped by the roster poller the tick it first saw the session
    // done); a live one counts on from startedAt against this tick's clock.
    // A local copy of lib/agents.js's completedIn, for the same reason
    // elapsedLabel above is a local copy: public/ cannot import from lib/.
    elapsed: elapsedLabel((Number.isFinite(record.endedAt) ? record.endedAt : now) - record.startedAt),
  };
}

// The roster, filtered to real sessions -- the shared first half of both
// rowsFromRoster and groupsFromRoster, so the one cap (MAX_ROWS) is enforced
// in exactly one place.
//
// Sorted by number rather than left in whatever order the server sent, but
// only defensively: the server already sends the roster in numbered order, and
// this is what keeps the panel correct even so -- a session with no number
// (a wire message from an older server, or a row the caller built by hand for
// a test) sorts last rather than first, the same posture every other missing-
// value sort in this codebase takes.
function liveSorted(roster) {
  const list = Array.isArray(roster) ? roster : [];
  return list
    .filter((record) => record && typeof record.sessionId === "string" && record.sessionId)
    .slice()
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
}

// rowsFromRoster(roster, now) -> what to paint, in numbered order.
export function rowsFromRoster(roster, now = Date.now()) {
  return liveSorted(roster)
    .slice(0, MAX_ROWS)
    .map((record) => rowFromRecord(record, now));
}

// groupsFromRoster(workspaces, roster, now) -> one group per repository, in
// the order the server sent `workspaces` in (main first, see
// lib/memory.js:workspacesForClient), each carrying its sessions as rows in
// the exact shape rowsFromRoster produces.
//
// The MAX_ROWS cap is applied once, globally, before any grouping happens --
// the same cut rowsFromRoster makes, by number rather than by age -- so a
// machine running more than a panel's worth of sessions loses the same ones
// everywhere, not just within whichever repository happens to be drawn first.
//
// A session whose alias matches no known workspace (a stale alias, one from
// before a repository was ever named) is not dropped: it goes into a trailing
// group, and only when there is something to put there -- an empty group
// nobody can start a session in would just be noise. It is labelled "elsewhere"
// for a person to read, but that label is not what tells it apart from a real
// workspace someone happened to name "elsewhere" -- `other: true` is, and it is
// the only field app.js is allowed to branch on for "is this the catch-all."
export function groupsFromRoster(workspaces, roster, now = Date.now()) {
  const spaces = Array.isArray(workspaces) ? workspaces : [];
  const rows = liveSorted(roster)
    .slice(0, MAX_ROWS)
    .map((record) => rowFromRecord(record, now));

  const groups = spaces.map((w) => ({ alias: w.alias, main: Boolean(w.main), other: false, sessions: [] }));
  const byAlias = new Map(groups.map((g) => [g.alias, g]));

  const elsewhere = [];
  for (const row of rows) {
    const group = byAlias.get(row.where);
    if (group) group.sessions.push(row);
    else elsewhere.push(row);
  }

  if (elsewhere.length > 0) groups.push({ alias: "elsewhere", main: false, other: true, sessions: elsewhere });
  return groups;
}

// Same reasoning as #dbg: a panel someone deliberately opened is not "the
// rest of the interface", so it is shown iff the person opened it -- an empty
// roster and `h` both leave it exactly where it was.
export function panelIsVisible(open) {
  return Boolean(open);
}
