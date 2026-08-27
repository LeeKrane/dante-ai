// The sessions panel: what is running, next to the orb.
//
// The build HUD beside this one is a canvas groove that a build cuts for
// itself, and it is about one build in one directory. Sessions are the more
// important thing now and they are a different shape: several at once, each
// mostly idle, each interesting for its name, its repository and how long it
// has been at it. That is a list, not a spiral, so it is a list -- the HUD is
// left alone to do the thing it is good at.
//
// The fifth pure client module. app.js paints; every decision that can be a
// function is one here, where it can be tested.

// More than a handful on screen is a wall of text beside an orb. The roster
// Dante can see is already whitelisted to named repositories server-side, so
// this cap is about the panel rather than about scope.
export const MAX_ROWS = 6;

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
  if (minutes < 60) return `${minutes}m`;
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

// rowsFromRoster(roster, now) -> what to paint, newest first.
//
// Newest first because a session started thirty seconds ago is the one being
// thought about, and the one running since this morning is furniture.
export function rowsFromRoster(roster, now = Date.now()) {
  const list = Array.isArray(roster) ? roster : [];
  return list
    .filter((record) => record && typeof record.sessionId === "string" && record.sessionId)
    // Sorted before the cap, so the six that survive are the six most recent
    // rather than the first six the CLI happened to print. A session with no
    // start time sorts last: an unknown age is not evidence of being new.
    .slice()
    .sort((a, b) => (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity))
    .slice(0, MAX_ROWS)
    .map((record) => ({
      id: record.sessionId,
      // A session with no name is still worth a row: something is running, and
      // saying so with a blank name beats leaving a gap in the count.
      name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : "unnamed",
      where: typeof record.alias === "string" ? record.alias : "",
      condition: condition(record),
      elapsed: elapsedLabel(now - record.startedAt),
    }));
}

// The panel is shown only when it has something to say, and never when the
// interface is hidden with `h` -- a list nobody can see is still a list the
// screen reader reads out.
export function panelIsVisible(rows, chromeHidden) {
  return Array.isArray(rows) && rows.length > 0 && !chromeHidden;
}
