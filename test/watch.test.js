import test from "node:test";
import assert from "node:assert/strict";

import {
  GHOST_MS,
  MAX_WATCHERS,
  WATCH_QUESTION,
  cancelTarget,
  createWatchers,
  describeFired,
  ghostRecords,
  pruneFired,
  refuseWatch,
  resumedAmong,
  unwatchVerdict,
  watchCoverage,
  watchEvent,
  watchVerdict,
  watchingLine,
} from "../lib/watch.js";
import { MAX_READ_CHARS } from "../lib/transcript.js";
import { MAX_DETAIL_CHARS } from "../lib/notify.js";

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
  watchers.add(working());
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
    watchers.add(working({ sessionId: `s${i}`, name: `session-${i}` }));
  }
  const refusal = refuseWatch(working({ sessionId: "sN", name: "session-new" }), watchers);
  assert.equal(refusal, "I am already watching five sessions, sir. Cancel one first.");

  watchers.cancel("s0");
  assert.equal(refuseWatch(working({ sessionId: "sN", name: "session-new" }), watchers), null);
});

test("the checks run in order: an already-watched session is refused as already-watched, whatever state it is now in", () => {
  // watchers.has() is checked before isWorking() and before the blocked
  // check below it -- so a session that is already watched and either no
  // longer working or freshly blocked still gets the already-watching
  // sentence, not one of the reasons further down the list.
  const watchers = createWatchers();
  const idle = working({ state: "done" });
  watchers.add(idle);
  assert.equal(refuseWatch(idle, watchers), "I am already watching jarvis-1, sir.");
  assert.equal(
    refuseWatch(working({ state: "blocked" }), watchers),
    "I am already watching jarvis-1, sir.",
  );
});

test("a session already blocked refuses a watch, so a fresh transition is not confused with an old one", () => {
  const watchers = createWatchers();
  const blocked = working({ state: "blocked" });
  assert.equal(
    refuseWatch(blocked, watchers),
    "jarvis-1 is already blocked, sir, waiting on a permission prompt.",
  );
});

// ---------------------------------------------------------------------------
// createWatchers
// ---------------------------------------------------------------------------

test("add stores a watch and it is then visible to has, size and names", () => {
  const watchers = createWatchers();
  const ok = watchers.add(working());
  assert.equal(ok, true);
  assert.equal(watchers.has("s1"), true);
  assert.equal(watchers.size(), 1);
  assert.deepEqual(watchers.names(), ["jarvis-1"]);
});

test("a watch remembers where the session ran", () => {
  const watchers = createWatchers();
  // Built the way dispatchWatch (server.js) builds it -- a roster record with
  // alias and startedAt on it, spread field-by-field into the add() literal --
  // rather than through the watch-shaped `working()` helper, so this test
  // would fail if that call site ever stopped passing the two fields through.
  const record = { sessionId: "s1", name: "jarvis-1", cwd: "/repo", state: "working", alias: "jarvis", startedAt: 1000 };
  watchers.add({
    sessionId: record.sessionId,
    name: record.name,
    cwd: record.cwd,
    task: "",
    state: record.state,
    alias: record.alias,
    startedAt: record.startedAt,
  });
  const [watch] = watchers.list();
  assert.equal(watch.alias, "jarvis");
  assert.equal(watch.startedAt, 1000);
});

test("add refuses a non-string or empty sessionId", () => {
  const watchers = createWatchers();
  for (const sessionId of [undefined, null, 42, "", {}]) {
    assert.equal(watchers.add({ ...working(), sessionId }), false, String(sessionId));
  }
  assert.equal(watchers.size(), 0);
});

test("add refuses a sessionId that is already watched", () => {
  const watchers = createWatchers();
  assert.equal(watchers.add(working()), true);
  assert.equal(watchers.add(working()), false);
  assert.equal(watchers.size(), 1);
});

test("add never exceeds MAX_WATCHERS", () => {
  const watchers = createWatchers();
  for (let i = 0; i < MAX_WATCHERS; i++) {
    assert.equal(watchers.add(working({ sessionId: `s${i}`, name: `session-${i}` })), true);
  }
  assert.equal(watchers.add(working({ sessionId: "sN", name: "session-new" })), false);
  assert.equal(watchers.size(), MAX_WATCHERS);
});

test("cancel removes a watch and returns it, and returns null for one that was never there", () => {
  const watchers = createWatchers();
  watchers.add(working());
  const removed = watchers.cancel("s1");
  assert.equal(removed.sessionId, "s1");
  assert.equal(removed.name, "jarvis-1");
  assert.equal(watchers.has("s1"), false);
  assert.equal(watchers.cancel("s1"), null);
  assert.equal(watchers.cancel("never-added"), null);
});

test("names come back in insertion order", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "first" }));
  watchers.add(working({ sessionId: "s2", name: "second" }));
  watchers.add(working({ sessionId: "s3", name: "third" }));
  assert.deepEqual(watchers.names(), ["first", "second", "third"]);
});

test("names falls back to a generic subject for a watch with no name, so the WATCHING line never lists a blank item", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: null }));
  watchers.add(working({ sessionId: "s2", name: "second" }));
  assert.deepEqual(watchers.names(), ["that session", "second"]);
});

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

test("a non-array roster fires nothing and keeps every watch, the same rule diffRoster follows", () => {
  const watchers = createWatchers();
  watchers.add(working());
  for (const roster of [null, undefined, "not a roster", {}]) {
    assert.deepEqual(watchers.tick(roster, Date.now()), [], String(roster));
  }
  assert.equal(watchers.has("s1"), true);
});

test("a session still working keeps the watcher waiting, and it is not fired", () => {
  const watchers = createWatchers();
  watchers.add(working());
  const fired = watchers.tick([working()], Date.now());
  assert.deepEqual(fired, []);
  assert.equal(watchers.has("s1"), true);
});

test("an idle session fires once and removes the watch", () => {
  const watchers = createWatchers();
  watchers.add(working());
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
  watchers.add(working());
  const fired = watchers.tick([], Date.now());
  assert.equal(fired.length, 1);
  assert.equal(fired[0].change, "gone");
  assert.equal(fired[0].record, null);
  assert.equal(watchers.has("s1"), false);
});

test("a fresh transition into blocked fires once, and is not fired again because it was removed", () => {
  const watchers = createWatchers();
  watchers.add(working({ state: "working" }));
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
  watchers.add(working({ state: "blocked" }));
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
  watchers.add(working({ sessionId: "s1", name: "one" }));
  watchers.add(working({ sessionId: "s2", name: "two" }));
  watchers.add(working({ sessionId: "s3", name: "three" }));

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

test("a session with a tell waiting has not stopped working so its watch keeps waiting", () => {
  const watchers = createWatchers();
  watchers.add(working());
  const roster = [working({ state: "done" })];
  const fired = watchers.tick(roster, Date.now(), { skip: new Set(["s1"]) });
  assert.deepEqual(fired, []);
  assert.equal(watchers.has("s1"), true);
});

test("a skipped watch fires on the next tick once the queue is empty", () => {
  const watchers = createWatchers();
  watchers.add(working());
  const roster = [working({ state: "done" })];
  assert.deepEqual(watchers.tick(roster, Date.now(), { skip: new Set(["s1"]) }), []);
  const fired = watchers.tick(roster, Date.now());
  assert.equal(fired.length, 1);
  assert.equal(fired[0].change, "idle");
  assert.equal(watchers.has("s1"), false);
});

test("a skip list naming nothing on the roster changes no outcome", () => {
  const watchers = createWatchers();
  watchers.add(working());
  const roster = [working({ state: "done" })];
  const fired = watchers.tick(roster, Date.now(), { skip: new Set(["unrelated-id"]) });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].change, "idle");
});

test("a session that vanished while a tell was in flight still fires gone; the skip only holds for one still listed", () => {
  const watchers = createWatchers();
  watchers.add(working());
  const fired = watchers.tick([], Date.now(), { skip: new Set(["s1"]) });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].change, "gone");
  assert.equal(watchers.has("s1"), false);
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
  watchers.add(working({ sessionId: "s1", name: "one" }));
  watchers.add(working({ sessionId: "s2", name: "two" }));
  const { watch, refusal } = cancelTarget(watchers, { sessionId: "s2" });
  assert.equal(refusal, null);
  assert.equal(watch.sessionId, "s2");
});

test("cancelTarget refuses outright when sessionId is given but matches no watch, even with one unrelated watch live", () => {
  // A stale id must not silently fall through to no-name resolution and
  // cancel the one live watch that happens to be unrelated to it.
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "one" }));
  const { watch, refusal } = cancelTarget(watchers, { sessionId: "stale-id" });
  assert.equal(watch, null);
  assert.equal(refusal, "That session is no longer being watched, sir.");
  assert.equal(watchers.has("s1"), true);
});

test("cancelTarget's Which one join never speaks a blank item for a nameless watch", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: null }));
  watchers.add(working({ sessionId: "s2", name: "named" }));
  const { watch, refusal } = cancelTarget(watchers, {});
  assert.equal(watch, null);
  assert.match(refusal, /^Which one, sir\?/);
  assert.match(refusal, /that session/);
  assert.match(refusal, /named/);
});

test("cancelTarget matches a named watch via matchSessions", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "fix-tests" }));
  watchers.add(working({ sessionId: "s2", name: "landing-page" }));
  const { watch, refusal } = cancelTarget(watchers, { name: "fix-tests" });
  assert.equal(refusal, null);
  assert.equal(watch.sessionId, "s1");
});

test("cancelTarget refuses a name matching nothing being watched", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "fix-tests" }));
  const { watch, refusal } = cancelTarget(watchers, { name: "landing-page" });
  assert.equal(watch, null);
  assert.equal(refusal, "I am not watching landing-page, sir.");
});

test("cancelTarget asks which one when a name matches more than one watch", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "jarvis-1-fix-tests" }));
  watchers.add(working({ sessionId: "s2", name: "jarvis-1-landing-page" }));
  const { watch, refusal } = cancelTarget(watchers, { name: "jarvis-1" });
  assert.equal(watch, null);
  assert.match(refusal, /^Which one, sir\?/);
  assert.match(refusal, /jarvis-1-fix-tests/);
  assert.match(refusal, /jarvis-1-landing-page/);
});

test("cancelTarget with no name and exactly one watch resolves it on its own", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "only-one" }));
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

test("both which-one failures use the same words", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "jarvis-1-fix-tests" }));
  watchers.add(working({ sessionId: "s2", name: "jarvis-1-landing-page" }));
  const byAmbiguousName = cancelTarget(watchers, { name: "jarvis-1" }).refusal;
  const byNoNameGiven = cancelTarget(watchers, {}).refusal;
  assert.equal(byAmbiguousName, byNoNameGiven);
});

test("cancelTarget with no name and several watches asks which one", () => {
  const watchers = createWatchers();
  watchers.add(working({ sessionId: "s1", name: "one" }));
  watchers.add(working({ sessionId: "s2", name: "two" }));
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
  watchers.add(working({ sessionId: "s1", name: "only-one" }));
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

test("a gone watcher reads the transcript back and stops there, without asking for an instruction", () => {
  const spoken = describeFired({ name: "jarvis-1", change: "gone", text: "It fixed the failing test." });
  assert.equal(spoken, "jarvis-1 has finished, sir. It fixed the failing test.");
});

test("a blocked watcher says it is waiting on a permission prompt", () => {
  const spoken = describeFired({ name: "jarvis-1", change: "blocked", text: "It wants to run npm install." });
  assert.equal(
    spoken,
    "jarvis-1 is blocked, sir, waiting on a permission prompt. It wants to run npm install.",
  );
});

test("an idle watcher names the new state when it is a plain, known word", () => {
  const spoken = describeFired({ name: "jarvis-1", change: "idle", state: "done", text: "It shipped the feature." });
  assert.equal(spoken, "jarvis-1 has stopped working, sir; it is done now. It shipped the feature.");
});

test("an idle watcher omits the state clause when the state is missing or not printable", () => {
  for (const state of [undefined, null, "", "Some Weird State!!", "x".repeat(30)]) {
    const spoken = describeFired({ name: "jarvis-1", change: "idle", state, text: "It did the thing." });
    assert.equal(spoken, "jarvis-1 has stopped working, sir. It did the thing.", String(state));
  }
});

test("empty text with reason no-transcript says nothing was left to read", () => {
  const spoken = describeFired({ name: "jarvis-1", change: "gone", text: "", reason: "no-transcript" });
  assert.equal(spoken, "jarvis-1 has finished, sir. It left nothing I can read.");
});

test("empty text with any other reason says the read failed, never a generic state line", () => {
  for (const reason of ["failed", "", undefined, "something-unexpected"]) {
    const spoken = describeFired({ name: "jarvis-1", change: "gone", text: "", reason });
    assert.equal(spoken, "jarvis-1 has finished, sir. I could not read what it produced.", String(reason));
  }
});

test("unprintable characters are stripped from the name and the text", () => {
  const spoken = describeFired({
    name: "jarvis-1‎",
    change: "gone",
    text: "It did‏ the thing.",
  });
  assert.equal(spoken, "jarvis-1 has finished, sir. It did the thing.");
});

test("the text is capped at MAX_READ_CHARS", () => {
  const long = "x".repeat(MAX_READ_CHARS + 200);
  const spoken = describeFired({ name: "jarvis-1", change: "gone", text: long });
  assert.equal(spoken.includes("x".repeat(MAX_READ_CHARS)), true);
  assert.equal(spoken.includes("x".repeat(MAX_READ_CHARS + 1)), false);
});

test("a nameless fired watch still reads as a sentence", () => {
  const spoken = describeFired({ name: null, change: "gone", text: "Done." });
  assert.equal(spoken, "that session has finished, sir. Done.");
});

// ---------------------------------------------------------------------------
// watchEvent
// ---------------------------------------------------------------------------

test("the spoken report and the recap entry are built from one read-back, so they cannot drift", () => {
  const spoken = describeFired({ name: "jarvis-1", change: "gone", text: "It fixed the failing test." });
  const event = watchEvent({ name: "jarvis-1", change: "gone", text: "It fixed the failing test." });
  assert.equal(spoken, `jarvis-1 has finished, sir. ${event.detail}`);
});

test("a blocked change is recorded as needs-attention, and a finished one as complete", () => {
  assert.equal(
    watchEvent({ name: "jarvis-1", change: "blocked", text: "It wants npm install." }).kind,
    "needs-attention",
  );
  assert.equal(watchEvent({ name: "jarvis-1", change: "idle", text: "It shipped." }).kind, "complete");
  assert.equal(watchEvent({ name: "jarvis-1", change: "gone", text: "It shipped." }).kind, "complete");
});

test("a long read-back is shortened to whole sentences before the recap's own cap ever cuts it", () => {
  const text = "It fixed the failing test. It also updated the README. It ran the full suite one more time to be sure.";
  const event = watchEvent({ name: "jarvis-1", change: "gone", text });
  assert.equal(event.detail, "It fixed the failing test. It also updated the README.");
  assert.equal(event.detail.length <= MAX_DETAIL_CHARS, true);
});

test("a read-back with no sentence break is still cut to the recap's limit", () => {
  const text = "x".repeat(MAX_DETAIL_CHARS + 50);
  const event = watchEvent({ name: "jarvis-1", change: "gone", text });
  assert.equal(event.detail, "x".repeat(MAX_DETAIL_CHARS));
});

test("a dot inside a filename or a decimal is not read as a sentence end", () => {
  const text = "It edited server.js and lib/watch.js. Then it ran tests. Then it committed.";
  const event = watchEvent({ name: "jarvis-1", change: "gone", text });
  assert.equal(event.detail, "It edited server.js and lib/watch.js. Then it ran tests.");
});

test("a decimal number does not split a sentence in two", () => {
  const text = "It took 3.5 hours. Then it pushed.";
  const event = watchEvent({ name: "jarvis-1", change: "gone", text });
  assert.equal(event.detail, "It took 3.5 hours. Then it pushed.");
});

test("e.g. followed by a space still reads as a boundary, cutting one sentence short -- a known limitation", () => {
  const text = "It ran e.g. the suite and passed. Then stopped. Then more.";
  const event = watchEvent({ name: "jarvis-1", change: "gone", text });
  assert.equal(event.detail, "It ran e.g. the suite and passed.");
});

// ---------------------------------------------------------------------------
// watchCoverage
// ---------------------------------------------------------------------------

test("idle and gone are both fully covered by the watcher's own report, so the generic recap and speech are skipped", () => {
  assert.deepEqual(watchCoverage("idle"), { record: false, spoken: false });
  assert.deepEqual(watchCoverage("gone"), { record: false, spoken: false });
});

test("a blocked report leaves the recap entry to fire, since completing afterwards is fresh news, but still yields the spoken line", () => {
  assert.deepEqual(watchCoverage("blocked"), { record: true, spoken: false });
});

test("nothing fired at all leaves both the recap entry and the spoken line to happen here, same as before watchers existed", () => {
  assert.deepEqual(watchCoverage(null), { record: true, spoken: true });
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

// ---------------------------------------------------------------------------
// ghostRecords / pruneFired
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const fired = (over = {}) => ({ name: "jarvis-1", alias: "jarvis", startedAt: NOW - 60_000, firedAt: NOW, ...over });

test("a finished session is still drawn for a minute, so its row does not vanish while it is spoken about", () => {
  const recentlyFired = new Map([["s1", fired()]]);
  const ghosts = ghostRecords(recentlyFired, [], NOW + 30_000, GHOST_MS);
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0].sessionId, "s1");
});

test("a ghost carries its repository, so it is not filed under elsewhere", () => {
  const recentlyFired = new Map([["s1", fired({ alias: "fitness" })]]);
  const [ghost] = ghostRecords(recentlyFired, [], NOW, GHOST_MS);
  assert.equal(ghost.alias, "fitness");
});

test("a ghost's clock stops at the fire", () => {
  const recentlyFired = new Map([["s1", fired({ startedAt: NOW - 120_000, firedAt: NOW - 10_000 })]]);
  const [ghost] = ghostRecords(recentlyFired, [], NOW, GHOST_MS);
  assert.equal(ghost.startedAt, NOW - 120_000);
  assert.equal(ghost.endedAt, NOW - 10_000);
  assert.equal(ghost.number, null);
  assert.equal(ghost.gone, true);
  assert.equal(ghost.state, "done");
  assert.equal(ghost.status, "idle");
});

test("a session back on the roster is no longer a ghost", () => {
  const recentlyFired = new Map([["s1", fired()]]);
  const roster = [{ sessionId: "s1", state: "working" }];
  assert.deepEqual(ghostRecords(recentlyFired, roster, NOW, GHOST_MS), []);
});

test("a fired record older than the window is forgotten", () => {
  const recentlyFired = new Map([["s1", fired({ firedAt: NOW - GHOST_MS - 1 })]]);
  assert.deepEqual(ghostRecords(recentlyFired, [], NOW, GHOST_MS), []);
});

test("a fire nobody has looked at in a minute and a half is forgotten, and the map it came from is left alone", () => {
  const recentlyFired = new Map([
    ["old", fired({ firedAt: NOW - GHOST_MS - 1 })],
    ["fresh", fired({ firedAt: NOW - 1000 })],
  ]);
  const pruned = pruneFired(recentlyFired, NOW, GHOST_MS);
  assert.deepEqual([...pruned.keys()], ["fresh"]);
  assert.deepEqual([...recentlyFired.keys()], ["old", "fresh"]);
});
