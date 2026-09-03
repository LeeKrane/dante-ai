import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SUMMARY_CHARS,
  MAX_TASK_CHARS,
  MAX_RECAP_CHARS,
  MAX_RECAP_EVENTS,
  doThisFirstClause,
  formatDuration,
  formatEvent,
  formatRecap,
  formatSpoken,
} from "../lib/notify.js";
import { MAX_DO_THIS_FIRST_CHARS } from "../lib/transcript.js";

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

test("a do-this-first line lands on the recap log too, as its own short clause", () => {
  const line = formatEvent({
    kind: "complete",
    name: "jarvis-1",
    summary: "improved the brief",
    doThisFirst: "Add the missing null check in widget.js.",
  });
  assert.equal(
    line,
    "jarvis-1 - done - improved the brief Do this first: Add the missing null check in widget.js.",
  );
});

test("no do-this-first line is exactly the line as it was before that field existed", () => {
  assert.equal(
    formatEvent({ kind: "complete", name: "jarvis-1", summary: "improved the brief", doThisFirst: "" }),
    "jarvis-1 - done - improved the brief",
  );
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

test("the council's do-this-first line is spoken as its own sentence when a completion carries one", () => {
  const event = {
    kind: "complete",
    name: "jarvis-1",
    durationMs: 480_000,
    summary: "improved the brief",
    doThisFirst: "Add the missing null check in widget.js before anything else.",
  };
  assert.equal(
    formatSpoken(event),
    "jarvis-1 finished in 8m, sir. improved the brief. " +
      "The council says, do this first: Add the missing null check in widget.js before anything else.",
  );
});

test("a completion with no do-this-first line is spoken exactly as it was before that field existed", () => {
  assert.equal(
    formatSpoken({ kind: "complete", name: "jarvis-1", durationMs: 480_000, summary: "improved the brief" }),
    "jarvis-1 finished in 8m, sir. improved the brief.",
  );
  assert.equal(
    formatSpoken({ kind: "complete", name: "jarvis-1", durationMs: 480_000, summary: "improved the brief", doThisFirst: "" }),
    "jarvis-1 finished in 8m, sir. improved the brief.",
  );
});

// ---------------------------------------------------------------------------
// doThisFirstClause
// ---------------------------------------------------------------------------

test("doThisFirstClause is the exact sentence formatSpoken appends, shared with lib/watch.js", () => {
  assert.equal(
    doThisFirstClause("Restart the daemon before deploying anything else."),
    "The council says, do this first: Restart the daemon before deploying anything else.",
  );
});

test("doThisFirstClause is empty for nothing to say", () => {
  assert.equal(doThisFirstClause(""), "");
  assert.equal(doThisFirstClause(undefined), "");
  assert.equal(doThisFirstClause(null), "");
});

test("doThisFirstClause caps to lib/transcript.js's own MAX_DO_THIS_FIRST_CHARS, imported rather than re-typed", () => {
  // This used to be a private 240 defined again in this file -- one of three
  // copies of the same number (lib/memory.js carried a third). Importing it
  // means there is exactly one cap left to get wrong, and this test pins
  // that the import is actually wired in, not merely present.
  const long = "x".repeat(MAX_DO_THIS_FIRST_CHARS + 50);
  const clause = doThisFirstClause(long);
  const stated = clause.slice("The council says, do this first: ".length);
  // cleanText caps at MAX_DO_THIS_FIRST_CHARS characters of "x", and
  // sentence() then adds the full stop this input has none of.
  assert.equal(stated, `${"x".repeat(MAX_DO_THIS_FIRST_CHARS)}.`);
});

// ---------------------------------------------------------------------------
// formatRecap
// ---------------------------------------------------------------------------

test("nothing to report is a short, complete sentence rather than silence", () => {
  assert.equal(formatRecap([]), "Nothing happened while you were out, sir.");
  assert.equal(formatRecap(undefined), "Nothing happened while you were out, sir.");
  assert.equal(formatRecap(null), "Nothing happened while you were out, sir.");
});

test("a session that asked for a person and has since finished is no longer said to need one", () => {
  const now = Date.now();
  const recap = formatRecap(
    [
      { kind: "needs-attention", name: "jarvis-1", detail: "waiting on a permission prompt", at: now - 600_000 },
      { kind: "complete", name: "jarvis-1", detail: "wrote the migration", at: now - 300_000 },
    ],
    now,
  );
  assert.equal(recap, "jarvis-1 finished 5m ago, sir: wrote the migration.");
});

test("a session still waiting keeps the lead even when another one finished after it", () => {
  const now = Date.now();
  const recap = formatRecap(
    [
      { kind: "needs-attention", name: "jarvis-1", detail: "waiting on a permission prompt", at: now - 600_000 },
      { kind: "complete", name: "jarvis-2", detail: "wrote the migration", at: now - 300_000 },
    ],
    now,
  );
  assert.equal(
    recap,
    "jarvis-1 still needs you, sir -- waiting on a permission prompt. That was 10m ago."
      + " jarvis-2 finished 5m ago: wrote the migration.",
  );
});

test("one event is one sentence, addressed to him", () => {
  const now = Date.now();
  assert.equal(
    formatRecap(
      [{ kind: "complete", name: "jarvis-1", detail: "fixed the timeout assertion", at: now - 252_000 }],
      now,
    ),
    "jarvis-1 finished 4m 12s ago, sir: fixed the timeout assertion.",
  );
});

test("a completed event with nothing further to add is still a full sentence", () => {
  const now = Date.now();
  assert.equal(
    formatRecap([{ kind: "complete", name: "jarvis-1", at: now - 38_000 }], now),
    "jarvis-1 finished 38s ago, sir.",
  );
});

test("a do-this-first line is its own short clause in the recap too", () => {
  const now = Date.now();
  assert.equal(
    formatRecap(
      [{
        kind: "complete", name: "jarvis-1", detail: "fixed the timeout assertion", at: now - 38_000,
        doThisFirst: "Restart the daemon before deploying anything else.",
      }],
      now,
    ),
    "jarvis-1 finished 38s ago, sir: fixed the timeout assertion. " +
      "Do this first: Restart the daemon before deploying anything else.",
  );
});

test("a failure and a start are each their own sentence", () => {
  const now = Date.now();
  assert.equal(
    formatRecap([{ kind: "failed", name: "jarvis-2", detail: "the session would not start", at: now - 60_000 }], now),
    "jarvis-2 failed 1m ago, sir: the session would not start.",
  );
  assert.equal(
    formatRecap([{ kind: "started", name: "jarvis-3", at: now - 5_000 }], now),
    "jarvis-3 started 5s ago, sir.",
  );
});

test("needs-attention leads even when it happened after everything else", () => {
  const now = Date.now();
  const recap = formatRecap(
    [
      { kind: "complete", name: "jarvis-1", detail: "all green", at: now - 600_000 },
      { kind: "needs-attention", name: "jarvis-2", detail: "wants to push to origin", at: now - 60_000 },
    ],
    now,
  );
  assert.match(recap, /^jarvis-2 still needs you, sir/);
  assert.match(recap, /jarvis-1 finished/);
  // "sir" is only said once, in the lead clause -- not after every sentence.
  assert.equal((recap.match(/sir/g) ?? []).length, 1);
});

test("a needs-attention event with no detail still names what is owed", () => {
  const now = Date.now();
  assert.equal(
    formatRecap([{ kind: "needs-attention", name: "jarvis-1", at: now - 120_000 }], now),
    "jarvis-1 still needs you, sir, as of 2m ago.",
  );
});

test("several events read as a paragraph, oldest first, not a table", () => {
  const now = Date.now();
  const recap = formatRecap(
    [
      { kind: "complete", name: "jarvis-1", detail: "fixed the tests", at: now - 600_000 },
      { kind: "failed", name: "jarvis-2", detail: "never wrote index.html", at: now - 300_000 },
    ],
    now,
  );
  assert.equal(
    recap,
    "jarvis-1 finished 10m ago, sir: fixed the tests. jarvis-2 failed 5m ago: never wrote index.html.",
  );
});

test("more events than the cap are summed up rather than all recited", () => {
  const now = Date.now();
  const events = Array.from({ length: MAX_RECAP_EVENTS + 3 }, (_, i) => ({
    kind: "complete",
    name: `jarvis-${i}`,
    at: now - i * 1000,
  }));
  const recap = formatRecap(events, now);
  assert.match(recap, /3 more things happened besides\.$/);
  // Only the cap's worth of sessions are actually named.
  for (let i = 0; i < MAX_RECAP_EVENTS; i++) assert.match(recap, new RegExp(`jarvis-${i}\\b`));
  assert.equal(recap.includes(`jarvis-${MAX_RECAP_EVENTS}`), false);
});

test("needs-attention is never crowded out of the cap by everything else", () => {
  const now = Date.now();
  const events = [
    ...Array.from({ length: MAX_RECAP_EVENTS }, (_, i) => ({ kind: "complete", name: `done-${i}`, at: now - i })),
    { kind: "needs-attention", name: "urgent", detail: "wants a decision", at: now },
  ];
  const recap = formatRecap(events, now);
  assert.match(recap, /^urgent still needs you, sir/);
});

test("an event of no known kind is dropped from the recap rather than crashing it", () => {
  const now = Date.now();
  assert.equal(
    formatRecap([{ kind: "exploded", name: "jarvis-1", at: now }, null, {}], now),
    "Nothing happened while you were out, sir.",
  );
});

test("a recap is capped in total length, however much the events carry", () => {
  const now = Date.now();
  const events = Array.from({ length: MAX_RECAP_EVENTS }, (_, i) => ({
    kind: "complete",
    name: `jarvis-${i}`,
    detail: "x".repeat(300),
    at: now - i * 1000,
  }));
  const recap = formatRecap(events, now);
  assert.ok(recap.length <= MAX_RECAP_CHARS, `recap was ${recap.length} chars`);
});

test("a name or detail that arrives hostile is capped and flattened like everywhere else", () => {
  const rlo = String.fromCharCode(0x202e);
  const now = Date.now();
  const recap = formatRecap(
    [{ kind: "complete", name: `jarvis${rlo}-1`, detail: "line one\nline two", at: now - 1000 }],
    now,
  );
  assert.equal(recap.includes(rlo), false);
  assert.match(recap, /^jarvis-1 finished 1s ago, sir: line one line two\.$/);
});
