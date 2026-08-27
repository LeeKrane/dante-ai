import test from "node:test";
import assert from "node:assert/strict";

import { MAX_ROWS, elapsedLabel, panelIsVisible, rowsFromRoster } from "../public/roster-panel.js";

const NOW = 1_800_000_000_000;
const record = (overrides = {}) => ({
  sessionId: "aaaa1111-0000-0000-0000-000000000000",
  name: "jarvis-1-fix",
  alias: "jarvis",
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

test("the newest sessions are the ones on screen", () => {
  // The one started thirty seconds ago is being thought about; the one running
  // since this morning is furniture.
  const roster = [
    record({ sessionId: "old", startedAt: NOW - 3_600_000 }),
    record({ sessionId: "new", startedAt: NOW - 30_000 }),
  ];
  assert.deepEqual(rowsFromRoster(roster, NOW).map((r) => r.id), ["new", "old"]);
});

test("more than a handful is a wall of text in the panel", () => {
  const roster = Array.from({ length: 20 }, (_, i) =>
    record({ sessionId: `s${i}`, startedAt: NOW - i * 1000 }));
  const rows = rowsFromRoster(roster, NOW);
  assert.equal(rows.length, MAX_ROWS);
  assert.equal(MAX_ROWS, 8);
  // Cut after sorting, so what survives is the most recent rather than
  // whatever the CLI printed first.
  assert.equal(rows[0].id, "s0");
});

test("a session with no start time sorts last rather than first", () => {
  const roster = [
    record({ sessionId: "unknown", startedAt: null }),
    record({ sessionId: "known", startedAt: NOW - 10_000 }),
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
