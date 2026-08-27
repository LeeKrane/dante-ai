import test from "node:test";
import assert from "node:assert/strict";

import { MAX_ROWS, elapsedLabel, groupsFromRoster, panelIsVisible, rowsFromRoster } from "../public/roster-panel.js";

const NOW = 1_800_000_000_000;
const record = (overrides = {}) => ({
  sessionId: "aaaa1111-0000-0000-0000-000000000000",
  name: "jarvis-1-fix",
  alias: "jarvis",
  number: 1,
  state: "working",
  status: "busy",
  startedAt: NOW - 65_000,
  ...overrides,
});

test("a row says which session, where, how it is and how long", () => {
  assert.deepEqual(rowsFromRoster([record()], NOW), [{
    id: "aaaa1111-0000-0000-0000-000000000000",
    name: "jarvis-1-fix",
    where: "jarvis",
    number: 1,
    condition: "working",
    elapsed: "1m",
  }]);
});

test("blocked is its own word, because it is the one you can do something about", () => {
  assert.equal(rowsFromRoster([record({ state: "blocked" })], NOW)[0].condition, "blocked");
  assert.equal(rowsFromRoster([record({ state: "done", status: "idle" })], NOW)[0].condition, "done");
  assert.equal(rowsFromRoster([record({ state: null, status: "idle" })], NOW)[0].condition, "idle");
  assert.equal(rowsFromRoster([record({ state: null, status: "busy" })], NOW)[0].condition, "working");
});

test("rows keep the server's own numbered order rather than being resorted here", () => {
  // The server numbers the roster once (lib/agents.js's orderRoster) so a
  // click and a spoken "session three" name the same session; a panel that
  // reordered them by age on top of that would make the two disagree.
  const roster = [
    record({ sessionId: "three", number: 3, startedAt: NOW - 30_000 }),
    record({ sessionId: "one", number: 1, startedAt: NOW - 3_600_000 }),
    record({ sessionId: "two", number: 2, startedAt: NOW - 1_800_000 }),
  ];
  assert.deepEqual(rowsFromRoster(roster, NOW).map((r) => r.id), ["one", "two", "three"]);
});

test("more than a handful is a wall of text in the panel", () => {
  const roster = Array.from({ length: 20 }, (_, i) =>
    record({ sessionId: `s${i}`, number: i + 1, startedAt: NOW - i * 1000 }));
  const rows = rowsFromRoster(roster, NOW);
  assert.equal(rows.length, MAX_ROWS);
  assert.equal(MAX_ROWS, 15);
  // Cut after sorting by number, so what survives is the first fifteen numbers
  // rather than whatever the caller happened to hand this function.
  assert.equal(rows[0].id, "s0");
});

test("a session with no number sorts last rather than first", () => {
  const roster = [
    record({ sessionId: "unknown", number: null }),
    record({ sessionId: "known", number: 1 }),
  ];
  assert.deepEqual(rowsFromRoster(roster, NOW).map((r) => r.id), ["known", "unknown"]);
});

test("a session with no name is still a session that is running", () => {
  const rows = rowsFromRoster([record({ name: null }), record({ sessionId: "b", name: "   " })], NOW);
  assert.deepEqual(rows.map((r) => r.name), ["unnamed", "unnamed"]);
});

test("a roster Dante could not read paints nothing", () => {
  assert.deepEqual(rowsFromRoster(null, NOW), []);
  assert.deepEqual(rowsFromRoster([], NOW), []);
  assert.deepEqual(rowsFromRoster([null, {}, { sessionId: "" }], NOW), []);
});

test("an elapsed time is read the way someone would say it", () => {
  assert.equal(elapsedLabel(45_000), "45s");
  assert.equal(elapsedLabel(65_000), "1m");
  assert.equal(elapsedLabel(3_600_000), "1h");
  assert.equal(elapsedLabel(3_900_000), "1h 5m");
});

test("a session younger than a second says nothing rather than flickering", () => {
  assert.equal(elapsedLabel(400), "");
  assert.equal(elapsedLabel(0), "");
  assert.equal(elapsedLabel(-5), "");
  assert.equal(elapsedLabel(NaN), "");
  assert.equal(elapsedLabel(null), "");
});

test("the panel is shown when opened, whether or not anything is running", () => {
  assert.equal(panelIsVisible(true), true);
  assert.equal(panelIsVisible(false), false);
});

test("closing the panel hides it, however busy the machine is", () => {
  assert.equal(panelIsVisible(false), false);
});

// --- groupsFromRoster --------------------------------------------------

const workspace = (overrides = {}) => ({ alias: "jarvis", main: false, ...overrides });

test("groups keep the server's own order, main first", () => {
  const workspaces = [workspace({ alias: "fitness", main: true }), workspace({ alias: "jarvis" })];
  const roster = [record({ sessionId: "j1", alias: "jarvis" }), record({ sessionId: "f1", alias: "fitness", startedAt: NOW - 5000 })];
  const groups = groupsFromRoster(workspaces, roster, NOW);
  assert.deepEqual(groups.map((g) => [g.alias, g.main]), [["fitness", true], ["jarvis", false]]);
});

test("a repository with no sessions still gets a group, just an empty one", () => {
  const workspaces = [workspace({ alias: "fitness", main: true }), workspace({ alias: "jarvis" })];
  const groups = groupsFromRoster(workspaces, [record({ alias: "jarvis" })], NOW);
  assert.deepEqual(groups.find((g) => g.alias === "fitness").sessions, []);
  assert.equal(groups.find((g) => g.alias === "jarvis").sessions.length, 1);
});

test("a session whose alias names no known workspace lands in elsewhere, and only then", () => {
  const workspaces = [workspace({ alias: "jarvis", main: true })];
  const withoutStray = groupsFromRoster(workspaces, [record({ alias: "jarvis" })], NOW);
  assert.equal(withoutStray.some((g) => g.alias === "elsewhere"), false);

  const withStray = groupsFromRoster(
    workspaces,
    [record({ alias: "jarvis" }), record({ sessionId: "ghost", alias: "long-gone" })],
    NOW,
  );
  const elsewhere = withStray.find((g) => g.alias === "elsewhere");
  assert.ok(elsewhere);
  assert.equal(elsewhere.main, false);
  assert.equal(elsewhere.other, true);
  assert.deepEqual(elsewhere.sessions.map((r) => r.id), ["ghost"]);
});

test("a real workspace named elsewhere does not lose sessions to the catch-all group", () => {
  // Both groups end up carrying the same label, which is not the property
  // under test -- "other" is: it is the one field that tells a real
  // workspace's own group apart from the synthetic catch-all, and app.js
  // is only allowed to branch on it, never on the alias string.
  const workspaces = [workspace({ alias: "elsewhere", main: true })];
  const groups = groupsFromRoster(
    workspaces,
    [record({ sessionId: "real", alias: "elsewhere" }), record({ sessionId: "ghost", alias: "long-gone" })],
    NOW,
  );
  const real = groups.find((g) => g.alias === "elsewhere" && !g.other);
  const stray = groups.find((g) => g.alias === "elsewhere" && g.other);
  assert.ok(real);
  assert.equal(real.main, true);
  assert.deepEqual(real.sessions.map((r) => r.id), ["real"]);
  assert.ok(stray);
  assert.equal(stray.main, false);
  assert.deepEqual(stray.sessions.map((r) => r.id), ["ghost"]);
});

test("every real group says other: false, whether or not it is main", () => {
  const workspaces = [workspace({ alias: "fitness", main: true }), workspace({ alias: "jarvis" })];
  const groups = groupsFromRoster(workspaces, [], NOW);
  assert.deepEqual(groups.map((g) => g.other), [false, false]);
});

test("the MAX_ROWS cap applies across every group, by number, not per group", () => {
  const workspaces = [workspace({ alias: "jarvis", main: true })];
  const roster = Array.from({ length: 20 }, (_, i) =>
    record({ sessionId: `s${i}`, alias: "jarvis", number: i + 1, startedAt: NOW - i * 1000 }));
  const groups = groupsFromRoster(workspaces, roster, NOW);
  const total = groups.reduce((sum, g) => sum + g.sessions.length, 0);
  assert.equal(total, MAX_ROWS);
  assert.equal(groups[0].sessions[0].id, "s0");
});

test("rows inside a group are shaped exactly the way rowsFromRoster shapes them", () => {
  const workspaces = [workspace({ alias: "jarvis", main: true })];
  const groups = groupsFromRoster(workspaces, [record()], NOW);
  assert.deepEqual(groups[0].sessions, rowsFromRoster([record()], NOW));
});

test("no workspaces and no sessions is an empty list of groups", () => {
  assert.deepEqual(groupsFromRoster([], [], NOW), []);
  assert.deepEqual(groupsFromRoster(null, null, NOW), []);
});
