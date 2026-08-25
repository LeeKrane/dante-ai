import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SUMMARY_CHARS,
  MAX_TASK_CHARS,
  formatDuration,
  formatEvent,
  formatSpoken,
} from "../lib/notify.js";

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

test("a duration is read the way someone would say it", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(38_000), "38s");
  assert.equal(formatDuration(252_000), "4m 12s");
  assert.equal(formatDuration(240_000), "4m");
  assert.equal(formatDuration(3_900_000), "1h 5m");
  assert.equal(formatDuration(7_200_000), "2h");
});

test("a duration nobody can compute is left out rather than guessed at", () => {
  assert.equal(formatDuration(undefined), "");
  assert.equal(formatDuration(null), "");
  assert.equal(formatDuration(-1), "");
  assert.equal(formatDuration(NaN), "");
  assert.equal(formatDuration("4m"), "");
});

// ---------------------------------------------------------------------------
// formatEvent
// ---------------------------------------------------------------------------

test("a started event names the task, because nothing else will", () => {
  assert.equal(
    formatEvent({ kind: "started", name: "jarvis-1-builder-test-fix", task: "fix the failing builder test" }),
    'jarvis-1-builder-test-fix - started - "fix the failing builder test"',
  );
});

test("a completed event carries the summary and the time it took", () => {
  assert.equal(
    formatEvent({
      kind: "complete",
      name: "jarvis-1-builder-test-fix",
      durationMs: 252_000,
      summary: "fixed the timeout assertion and added a regression test",
    }),
    "jarvis-1-builder-test-fix - done in 4m 12s - fixed the timeout assertion and added a regression test",
  );
});

test("a reply does not repeat the task the thread parent already shows", () => {
  // In a thread the task is on screen. Repeating it pushes the thing that
  // actually changed off the end of the line.
  const line = formatEvent({ kind: "complete", name: "jarvis-1", task: "fix the tests", summary: "done" });
  assert.equal(line.includes("fix the tests"), false);
});

test("a failure says so without dressing it up in how long it took first", () => {
  assert.equal(
    formatEvent({ kind: "failed", name: "jarvis-2", durationMs: 252_000, detail: "the session would not start" }),
    "jarvis-2 - failed - the session would not start",
  );
});

test("a session waiting on a person says what it is waiting for", () => {
  assert.equal(
    formatEvent({ kind: "needs-attention", name: "jarvis-1", detail: "wants to push to origin" }),
    "jarvis-1 - waiting on you - wants to push to origin",
  );
});

test("an event with nothing to add is still a complete line", () => {
  assert.equal(formatEvent({ kind: "complete", name: "jarvis-1" }), "jarvis-1 - done");
  assert.equal(formatEvent({ kind: "started", name: "jarvis-1" }), "jarvis-1 - started");
});

test("a summary beats a detail when an event somehow carries both", () => {
  const line = formatEvent({ kind: "complete", name: "j-1", summary: "the summary", detail: "the detail" });
  assert.match(line, /the summary/);
  assert.equal(line.includes("the detail"), false);
});

test("an event of no known kind is not posted at all", () => {
  // Reached from a hook payload, where any local process can invent a kind.
  assert.equal(formatEvent({ kind: "exploded", name: "jarvis-1" }), "");
  assert.equal(formatEvent({ kind: null }), "");
  assert.equal(formatEvent({}), "");
  assert.equal(formatEvent(), "");
});

test("a nameless session is still reportable", () => {
  assert.equal(formatEvent({ kind: "complete", alias: "jarvis" }), "jarvis - done");
  assert.equal(formatEvent({ kind: "complete" }), "a session - done");
});

test("every field that came from somewhere else is capped and flattened", () => {
  const rlo = String.fromCharCode(0x202e);
  const line = formatEvent({
    kind: "started",
    name: `jarvis${rlo}-1`,
    task: "x".repeat(MAX_TASK_CHARS * 3),
  });
  assert.equal(line.includes(rlo), false);
  assert.match(line, /^jarvis-1 - started - "x{200}"$/);

  const multiline = formatEvent({ kind: "complete", name: "j-1", summary: "line one\nline two" });
  assert.equal(multiline, "j-1 - done - line one line two");

  const long = formatEvent({ kind: "complete", name: "j-1", summary: "y".repeat(MAX_SUMMARY_CHARS * 3) });
  assert.ok(long.length < MAX_SUMMARY_CHARS + 80, `line was ${long.length} chars`);
});

// ---------------------------------------------------------------------------
// formatSpoken
// ---------------------------------------------------------------------------

test("the spoken form of an event is shorter than the posted one", () => {
  const event = {
    kind: "complete",
    name: "jarvis-1-builder-test-fix",
    durationMs: 252_000,
    task: "fix the failing builder test",
    summary: "fixed the timeout assertion",
  };
  assert.equal(
    formatSpoken(event),
    "jarvis-1-builder-test-fix finished in 4m 12s, sir. fixed the timeout assertion.",
  );
  // The task is never spoken back: whoever hears this said it themselves.
  assert.equal(formatSpoken(event).includes("fix the failing builder test"), false);
});

test("a spoken line ends in a full stop, so the next one does not run into it", () => {
  assert.match(formatSpoken({ kind: "complete", name: "j-1", summary: "all green" }), /all green\.$/);
  assert.match(formatSpoken({ kind: "complete", name: "j-1", summary: "all green!" }), /all green!$/);
});

test("the spoken form always names the session, because that is what you answer", () => {
  assert.equal(formatSpoken({ kind: "started", name: "jarvis-1" }), "jarvis-1 is running, sir.");
  assert.equal(formatSpoken({ kind: "needs-attention", name: "jarvis-1", detail: "wants to push" }),
    "jarvis-1 needs you, sir. wants to push.");
  assert.equal(formatSpoken({ kind: "failed", name: "jarvis-1" }), "jarvis-1 failed, sir.");
  assert.equal(formatSpoken({ kind: "complete" }), "A session finished, sir.");
});

test("an event of no known kind is not spoken either", () => {
  assert.equal(formatSpoken({ kind: "exploded", name: "jarvis-1" }), "");
  assert.equal(formatSpoken(), "");
});
