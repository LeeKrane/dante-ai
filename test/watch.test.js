import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_WATCHERS,
  WATCH_QUESTION,
  cancelTarget,
  createWatchers,
  describeFired,
  refuseWatch,
  resumedAmong,
  unwatchVerdict,
  watchVerdict,
  watchingLine,
} from "../lib/watch.js";
import { MAX_READ_CHARS } from "../lib/transcript.js";

const working = (over = {}) => ({
  sessionId: "s1", name: "jarvis-1", cwd: "/repo", state: "working", ...over,
});

// ---------------------------------------------------------------------------
// refuseWatch
// ---------------------------------------------------------------------------

test("a session that is no longer running refuses a watch before anything else is checked", () => {
  const watchers = createWatchers();
  assert.equal(refuseWatch(null, watchers), "That session is no longer running, sir.");
});

test("a session already being watched refuses a second watch on it", () => {
  const watchers = createWatchers();
  watchers.add(working(), Date.now());
  assert.equal(refuseWatch(working(), watchers), "I am already watching jarvis-1, sir.");
});

test("a session that is not working refuses a watch, because it would never fire", () => {
  const watchers = createWatchers();
  const idle = working({ state: "done" });
  assert.equal(
    refuseWatch(idle, watchers),
    "jarvis-1 is not working just now, sir, so there is nothing to wait for.",
  );
});

test("a record with no usable name refuses before anything else is checked, even one that is also not working", () => {
  const watchers = createWatchers();
  for (const name of [null, undefined, "", 42]) {
    const record = { sessionId: "s1", name, state: "done" };
    assert.equal(
      refuseWatch(record, watchers),
      "I cannot watch a session with no name, sir.",
      String(name),
    );
  }
});

test("a full watch list refuses one more, and cancelling frees a slot", () => {
  const watchers = createWatchers();
  for (let i = 0; i < MAX_WATCHERS; i++) {
    watchers.add(working({ sessionId: `s${i}`, name: `session-${i}` }), Date.now());
  }
  const refusal = refuseWatch(working({ sessionId: "sN", name: "session-new" }), watchers);
  assert.equal(refusal, "I am already watching five sessions, sir. Cancel one first.");

  watchers.cancel("s0");
  assert.equal(refuseWatch(working({ sessionId: "sN", name: "session-new" }), watchers), null);
});

test("the checks run in order: an already-watched session is refused as already-watched, even if it later went idle", () => {
  // watchers.has() is checked before isWorking() -- so a session that is
  // both already watched and no longer working still gets the
  // already-watching sentence, not the nothing-to-wait-for one.
  const watchers = createWatchers();
  const idle = working({ state: "done" });
  watchers.add(idle, Date.now());
  assert.equal(refuseWatch(idle, watchers), "I am already watching jarvis-1, sir.");
});

// ---------------------------------------------------------------------------
// createWatchers
// ---------------------------------------------------------------------------

test("add stores a watch and it is then visible to has, size and names", () => {
  const watchers = createWatchers();
  const ok = watchers.add(working(), 1000);
  assert.equal(ok, true);
  assert.equal(watchers.has("s1"), true);
  assert.equal(watchers.size(), 1);
  assert.deepEqual(watchers.names(), ["jarvis-1"]);
});

test("add refuses a non-string or empty sessionId", () => {
  const watchers = createWatchers();
  for (const sessionId of [undefined, null, 42, "", {}]) {
    assert.equal(watchers.add({ ...working(), sessionId }, Date.now()), false, String(sessionId));
  }
  assert.equal(watchers.size(), 0);
});

test("add refuses a sessionId that is already watched", () => {
  const watchers = createWatchers();
  assert.equal(watchers.add(working(), Date.now()), true);
  assert.equal(watchers.add(working(), Date.now()), false);
  assert.equal(watchers.size(), 1);
});

test("add never exceeds MAX_WATCHERS", () => {
  const watchers = createWatchers();
  for (let i = 0; i < MAX_WATCHERS; i++) {
    assert.equal(watchers.add(working({ sessionId: `s${i}`, name: `session-${i}` }), Date.now()), true);
  }
  assert.equal(watchers.add(working({ sessionId: "sN", name: "session-new" }), Date.now()), false);
  assert.equal(watchers.size(), MAX_WATCHERS);
});

test("cancel removes a watch and returns it, and returns null for one that was never there", () => {
  const watchers = createWatchers();
  watchers.add(working(), 1234);
  const removed = watchers.cancel("s1");
  assert.equal(removed.sessionId, "s1");
  assert.equal(removed.name, "jarvis-1");
  assert.equal(watchers.has("s1"), false);
  assert.equal(watchers.cancel("s1"), null);
  assert.equal(watchers.cancel("never-added"), null);
});

test("names come back in insertion order", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "first" }), 1);
  watchers.add(working({ sessionId: "s2", name: "second" }), 2);
  watchers.add(working({ sessionId: "s3", name: "third" }), 3);
  assert.deepEqual(watchers.names(), ["first", "second", "third"]);
});

test("names falls back to a generic subject for a watch with no name, so the WATCHING line never lists a blank item", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: null }), 1);
  watchers.add(working({ sessionId: "s2", name: "second" }), 2);
  assert.deepEqual(watchers.names(), ["that session", "second"]);
});

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

test("a non-array roster fires nothing and keeps every watch, the same rule diffRoster follows", () => {
  const watchers = createWatchers();
  watchers.add(working(), Date.now());
  for (const roster of [null, undefined, "not a roster", {}]) {
    assert.deepEqual(watchers.tick(roster, Date.now()), [], String(roster));
  }
  assert.equal(watchers.has("s1"), true);
});

test("a session still working keeps the watcher waiting, and it is not fired", () => {
  const watchers = createWatchers();
  watchers.add(working(), Date.now());
  const fired = watchers.tick([working()], Date.now());
  assert.deepEqual(fired, []);
  assert.equal(watchers.has("s1"), true);
});

test("an idle session fires once and removes the watch", () => {
  const watchers = createWatchers();
  watchers.add(working(), Date.now());
  const roster = [working({ state: "done" })];
  const fired = watchers.tick(roster, Date.now());
  assert.equal(fired.length, 1);
  assert.equal(fired[0].change, "idle");
  assert.equal(fired[0].watch.sessionId, "s1");
  assert.equal(fired[0].record.state, "done");
  assert.equal(watchers.has("s1"), false);

  // Firing removed it, so ticking again finds nothing to fire.
  assert.deepEqual(watchers.tick(roster, Date.now()), []);
});

test("a session gone from the roster fires with a null record", () => {
  const watchers = createWatchers();
  watchers.add(working(), Date.now());
  const fired = watchers.tick([], Date.now());
  assert.equal(fired.length, 1);
  assert.equal(fired[0].change, "gone");
  assert.equal(fired[0].record, null);
  assert.equal(watchers.has("s1"), false);
});

test("a fresh transition into blocked fires once, and is not fired again because it was removed", () => {
  const watchers = createWatchers();
  watchers.add(working({ state: "working" }), Date.now());
  const blockedRoster = [working({ state: "blocked" })];
  const fired = watchers.tick(blockedRoster, Date.now());
  assert.equal(fired.length, 1);
  assert.equal(fired[0].change, "blocked");
  assert.equal(watchers.has("s1"), false);

  // The watch is gone, so a second tick against the same roster fires nothing
  // -- there is nothing left to fire.
  assert.deepEqual(watchers.tick(blockedRoster, Date.now()), []);
});

test("a watch created while the session is already blocked does not fire on that same blocked state", () => {
  const watchers = createWatchers();
  watchers.add(working({ state: "blocked" }), Date.now());
  const stillBlocked = [working({ state: "blocked" })];
  assert.deepEqual(watchers.tick(stillBlocked, Date.now()), []);
  assert.equal(watchers.has("s1"), true);

  // It still fires once the session leaves blocked for something else.
  const fired = watchers.tick([working({ state: "done" })], Date.now());
  assert.equal(fired.length, 1);
  assert.equal(fired[0].change, "idle");
});

test("several watches fire independently in one tick", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "one" }), Date.now());
  watchers.add(working({ sessionId: "s2", name: "two" }), Date.now());
  watchers.add(working({ sessionId: "s3", name: "three" }), Date.now());

  const roster = [
    working({ sessionId: "s1", name: "one", state: "done" }), // idle
    // s2 missing entirely -> gone
    working({ sessionId: "s3", name: "three", state: "working" }), // keeps waiting
  ];
  const fired = watchers.tick(roster, Date.now());
  const bySession = Object.fromEntries(fired.map((f) => [f.watch.sessionId, f.change]));
  assert.deepEqual(bySession, { s1: "idle", s2: "gone" });
  assert.equal(watchers.has("s1"), false);
  assert.equal(watchers.has("s2"), false);
  assert.equal(watchers.has("s3"), true);
});

// ---------------------------------------------------------------------------
// resumedAmong
// ---------------------------------------------------------------------------

test("a reported session seen working again is returned, so its report can be forgotten", () => {
  const reported = new Set(["s1", "s2"]);
  const roster = [working(), working({ sessionId: "s2", state: undefined, status: "busy" })];
  assert.deepEqual(resumedAmong(reported, roster), ["s1", "s2"]);
});

test("a reported session that is idle, blocked, or gone from the roster is not returned", () => {
  const reported = new Set(["s1", "s2", "s3"]);
  const roster = [working({ state: "done" }), working({ sessionId: "s2", state: "blocked" })];
  assert.deepEqual(resumedAmong(reported, roster), []);
});

test("a working session nobody reported on is left alone, and a failed listing forgets nothing", () => {
  const reported = new Set(["s9"]);
  assert.deepEqual(resumedAmong(reported, [working()]), []);
  for (const roster of [null, undefined, "not a roster", {}]) {
    assert.deepEqual(resumedAmong(new Set(["s1"]), roster), [], String(roster));
  }
});

// ---------------------------------------------------------------------------
// cancelTarget
// ---------------------------------------------------------------------------

test("cancelTarget resolves by sessionId when one is given and matches", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "one" }), Date.now());
  watchers.add(working({ sessionId: "s2", name: "two" }), Date.now());
  const { watch, refusal } = cancelTarget(watchers, { sessionId: "s2" });
  assert.equal(refusal, null);
  assert.equal(watch.sessionId, "s2");
});

test("cancelTarget refuses outright when sessionId is given but matches no watch, even with one unrelated watch live", () => {
  // A stale id must not silently fall through to no-name resolution and
  // cancel the one live watch that happens to be unrelated to it.
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "one" }), Date.now());
  const { watch, refusal } = cancelTarget(watchers, { sessionId: "stale-id" });
  assert.equal(watch, null);
  assert.equal(refusal, "That session is no longer being watched, sir.");
  assert.equal(watchers.has("s1"), true);
});

test("cancelTarget's Which one join never speaks a blank item for a nameless watch", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: null }), Date.now());
  watchers.add(working({ sessionId: "s2", name: "named" }), Date.now());
  const { watch, refusal } = cancelTarget(watchers, {});
  assert.equal(watch, null);
  assert.match(refusal, /^Which one, sir\?/);
  assert.match(refusal, /that session/);
  assert.match(refusal, /named/);
});

test("cancelTarget matches a named watch via matchSessions", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "fix-tests" }), Date.now());
  watchers.add(working({ sessionId: "s2", name: "landing-page" }), Date.now());
  const { watch, refusal } = cancelTarget(watchers, { name: "fix-tests" });
  assert.equal(refusal, null);
  assert.equal(watch.sessionId, "s1");
});

test("cancelTarget refuses a name matching nothing being watched", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "fix-tests" }), Date.now());
  const { watch, refusal } = cancelTarget(watchers, { name: "landing-page" });
  assert.equal(watch, null);
  assert.equal(refusal, "I am not watching landing-page, sir.");
});

test("cancelTarget asks which one when a name matches more than one watch", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "jarvis-1-fix-tests" }), Date.now());
  watchers.add(working({ sessionId: "s2", name: "jarvis-1-landing-page" }), Date.now());
  const { watch, refusal } = cancelTarget(watchers, { name: "jarvis-1" });
  assert.equal(watch, null);
  assert.match(refusal, /^Which one, sir\?/);
  assert.match(refusal, /jarvis-1-fix-tests/);
  assert.match(refusal, /jarvis-1-landing-page/);
});

test("cancelTarget with no name and exactly one watch resolves it on its own", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "only-one" }), Date.now());
  const { watch, refusal } = cancelTarget(watchers, {});
  assert.equal(refusal, null);
  assert.equal(watch.sessionId, "s1");
});

test("cancelTarget with no name and nothing watched refuses plainly", () => {
  const watchers = createWatchers();
  const { watch, refusal } = cancelTarget(watchers, {});
  assert.equal(watch, null);
  assert.equal(refusal, "I am not watching anything, sir.");
});

test("cancelTarget with no name and several watches asks which one", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "one" }), Date.now());
  watchers.add(working({ sessionId: "s2", name: "two" }), Date.now());
  const { watch, refusal } = cancelTarget(watchers, {});
  assert.equal(watch, null);
  assert.match(refusal, /^Which one, sir\?/);
  assert.match(refusal, /one/);
  assert.match(refusal, /two/);
});

test("cancelTarget ignores a number-only tag, treating it as no name given", () => {
  // A number names a roster line, and a finished or renumbered session may
  // no longer have one -- see the module comment on why unwatch never
  // consults it.
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "only-one" }), Date.now());
  const { watch, refusal } = cancelTarget(watchers, { number: "3" });
  assert.equal(refusal, null);
  assert.equal(watch.sessionId, "s1");
});

// ---------------------------------------------------------------------------
// watchVerdict / unwatchVerdict
// ---------------------------------------------------------------------------

test("watchVerdict names the session and promises a report", () => {
  assert.equal(
    watchVerdict({ name: "jarvis-1" }),
    "Watching jarvis-1, sir. I will tell you the moment it stops working.",
  );
});

test("watchVerdict falls back to a generic subject when there is no name", () => {
  assert.equal(
    watchVerdict({ name: null }),
    "Watching that session, sir. I will tell you the moment it stops working.",
  );
});

test("unwatchVerdict names the session that is no longer being watched", () => {
  assert.equal(unwatchVerdict({ name: "jarvis-1" }), "No longer watching jarvis-1, sir.");
  assert.equal(unwatchVerdict({}), "No longer watching that session, sir.");
});

// ---------------------------------------------------------------------------
// describeFired
// ---------------------------------------------------------------------------

test("a gone watcher reads the transcript back and asks for the next step", () => {
  const spoken = describeFired({ name: "jarvis-1", change: "gone", text: "It fixed the failing test." });
  assert.equal(
    spoken,
    "jarvis-1 has finished, sir. It fixed the failing test. Ready for the next step, sir?",
  );
});

test("a blocked watcher says it is waiting on a permission prompt", () => {
  const spoken = describeFired({ name: "jarvis-1", change: "blocked", text: "It wants to run npm install." });
  assert.equal(
    spoken,
    "jarvis-1 is blocked, sir, waiting on a permission prompt. It wants to run npm install. Ready for the next step, sir?",
  );
});

test("an idle watcher names the new state when it is a plain, known word", () => {
  const spoken = describeFired({ name: "jarvis-1", change: "idle", state: "done", text: "It shipped the feature." });
  assert.equal(
    spoken,
    "jarvis-1 has stopped working, sir; it is done now. It shipped the feature. Ready for the next step, sir?",
  );
});

test("an idle watcher omits the state clause when the state is missing or not printable", () => {
  for (const state of [undefined, null, "", "Some Weird State!!", "x".repeat(30)]) {
    const spoken = describeFired({ name: "jarvis-1", change: "idle", state, text: "It did the thing." });
    assert.equal(
      spoken,
      "jarvis-1 has stopped working, sir. It did the thing. Ready for the next step, sir?",
      String(state),
    );
  }
});

test("empty text with reason no-transcript says nothing was left to read", () => {
  const spoken = describeFired({ name: "jarvis-1", change: "gone", text: "", reason: "no-transcript" });
  assert.equal(spoken, "jarvis-1 has finished, sir. It left nothing I can read. Ready for the next step, sir?");
});

test("empty text with any other reason says the read failed, never a generic state line", () => {
  for (const reason of ["failed", "", undefined, "something-unexpected"]) {
    const spoken = describeFired({ name: "jarvis-1", change: "gone", text: "", reason });
    assert.equal(
      spoken,
      "jarvis-1 has finished, sir. I could not read what it produced. Ready for the next step, sir?",
      String(reason),
    );
  }
});

test("unprintable characters are stripped from the name and the text", () => {
  const spoken = describeFired({
    name: "jarvis-1‎",
    change: "gone",
    text: "It did‏ the thing.",
  });
  assert.equal(spoken, "jarvis-1 has finished, sir. It did the thing. Ready for the next step, sir?");
});

test("the text is capped at MAX_READ_CHARS", () => {
  const long = "x".repeat(MAX_READ_CHARS + 200);
  const spoken = describeFired({ name: "jarvis-1", change: "gone", text: long });
  assert.equal(spoken.includes("x".repeat(MAX_READ_CHARS)), true);
  assert.equal(spoken.includes("x".repeat(MAX_READ_CHARS + 1)), false);
});

test("a nameless fired watch still reads as a sentence", () => {
  const spoken = describeFired({ name: null, change: "gone", text: "Done." });
  assert.equal(spoken, "that session has finished, sir. Done. Ready for the next step, sir?");
});

// ---------------------------------------------------------------------------
// watchingLine
// ---------------------------------------------------------------------------

test("watchingLine is empty when nothing is being watched", () => {
  assert.equal(watchingLine([]), "");
  assert.equal(watchingLine(undefined), "");
  assert.equal(watchingLine(null), "");
  assert.equal(watchingLine("not an array"), "");
});

test("watchingLine names every watched session, joined by commas", () => {
  assert.equal(
    watchingLine(["jarvis-1", "jarvis-2"]),
    "WATCHING: jarvis-1, jarvis-2 - you will be told the moment each stops working.",
  );
});

// ---------------------------------------------------------------------------
// WATCH_QUESTION
// ---------------------------------------------------------------------------

test("WATCH_QUESTION asks what happened, what it produced and what it is waiting on", () => {
  assert.match(WATCH_QUESTION, /what did this session just do/i);
  assert.match(WATCH_QUESTION, /what did it produce/i);
  assert.match(WATCH_QUESTION, /waiting on now/i);
});
