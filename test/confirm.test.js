import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TASK_CHARS,
  PROPOSAL_TTL_MS,
  clarify,
  describeIntent,
  findTarget,
  isAnswerable,
  needsConfirmation,
  parseSessionNumber,
  readAnswer,
  readConfirmingAnswer,
  readTarget,
} from "../lib/confirm.js";

// ---------------------------------------------------------------------------
// needsConfirmation
// ---------------------------------------------------------------------------

test("start, tell, interrupt and stop all need confirmation, in any case", () => {
  for (const verb of ["start", "tell", "interrupt", "stop", "START", "Tell", "STOP"]) {
    assert.equal(needsConfirmation({ verb }), true, verb);
  }
});

test("read, recap, a missing verb and a non-string verb never need confirmation", () => {
  assert.equal(needsConfirmation({ verb: "read" }), false);
  assert.equal(needsConfirmation({ verb: "recap" }), false);
  assert.equal(needsConfirmation({}), false);
  assert.equal(needsConfirmation(undefined), false);
  assert.equal(needsConfirmation({ verb: 7 }), false);
});

test("watch needs confirmation, in any case, but unwatch never does", () => {
  // watch stands up something that persists past the turn, the same reason
  // start, tell, interrupt and stop do; unwatch only dismantles one and
  // touches no process, same class as read.
  for (const verb of ["watch", "WATCH", "Watch"]) {
    assert.equal(needsConfirmation({ verb }), true, verb);
  }
  assert.equal(needsConfirmation({ verb: "unwatch" }), false);
});

test("an interview question is never held for a confirmation", () => {
  // The question is the reply, and holding it would put a Shall I, sir? in
  // front of a question.
  assert.equal(needsConfirmation({ verb: "interview" }), false);
  assert.equal(describeIntent({ session: { verb: "interview", repo: "jarvis", note: "x" } }), null);
});

// ---------------------------------------------------------------------------
// parseSessionNumber
// ---------------------------------------------------------------------------

test("a positive integer, or a numeral string, both parse as a session number", () => {
  assert.equal(parseSessionNumber(3), 3);
  assert.equal(parseSessionNumber("3"), 3);
  assert.equal(parseSessionNumber(" 3 "), 3);
  assert.equal(parseSessionNumber(15), 15);
});

test("zero, negative, fractional and partial numbers are all refused", () => {
  for (const bad of [0, -1, -4242, 1.5, "0", "-1", "3a", "a3", "", "  ", null, undefined, NaN, Infinity, {}, []]) {
    assert.equal(parseSessionNumber(bad), null, String(bad));
  }
});

test("a number too large to be a real position is refused, not read as itself", () => {
  // Number.isInteger(1e21) is true, and MAX_LISTED never gets anywhere near a
  // thousand -- without this a spoken refusal would end up saying "There is
  // no session 1e+21, sir." instead of treating it as the unparseable value
  // it obviously is.
  for (const tooBig of [1000, 1e21, Number.MAX_SAFE_INTEGER + 1, "1000", "9999"]) {
    assert.equal(parseSessionNumber(tooBig), null, String(tooBig));
  }
  assert.equal(parseSessionNumber(999), 999);
  assert.equal(parseSessionNumber("999"), 999);
});

// ---------------------------------------------------------------------------
// findTarget
// ---------------------------------------------------------------------------

test("a number matches the session numbered that, exclusively, never falling back to the name", () => {
  // The whole point of asking for a number: a model that guessed wrong about
  // it must not still land on the right session by name.
  const roster = [
    { name: "jarvis-1-fix-tests", sessionId: "a", number: 1 },
    { name: "bug-hunt", sessionId: "b", number: 2 },
  ];
  assert.deepEqual(findTarget(roster, "bug-hunt", { number: 1 }), { record: roster[0], refusal: null });
  assert.deepEqual(findTarget(roster, "nonsense", { number: 2 }), { record: roster[1], refusal: null });
});

test("a number that fails to parse refuses rather than falling back to a name that would match", () => {
  // The exclusivity findTarget already promises for a valid number would be
  // pointless if a merely GARBLED one fell back to the query instead --
  // "number=3a" is an addressing attempt that failed, not an invitation to
  // try the name.
  const roster = [{ name: "bug-hunt", sessionId: "a", number: 3 }];
  assert.deepEqual(findTarget(roster, "bug-hunt", { number: "3a" }), {
    record: null,
    refusal: "I did not catch which session, sir.",
  });
});

test("a sessionId matches that exact process, ahead of both a number and a name", () => {
  const roster = [
    { name: "bug-hunt", sessionId: "a", number: 1 },
    { name: "fix-tests", sessionId: "b", number: 2 },
  ];
  assert.deepEqual(findTarget(roster, "fix-tests", { sessionId: "a", number: 2 }), {
    record: roster[0],
    refusal: null,
  });
});

test("a sessionId that is no longer on the roster is refused by itself, not by name or number", () => {
  const roster = [{ name: "bug-hunt", sessionId: "a", number: 1 }];
  assert.deepEqual(findTarget(roster, "bug-hunt", { sessionId: "gone", number: 1 }), {
    record: null,
    refusal: "That session is no longer running, sir.",
  });
});

test("a sessionId is still refused correctly when the roster itself could not be read", () => {
  assert.deepEqual(findTarget(null, "bug-hunt", { sessionId: "a" }), {
    record: null,
    refusal: "I cannot see what is running just now, sir.",
  });
});

test("a sessionId resolves a session with no name at all, which a name query never could", () => {
  // parseListing (lib/agents.js) allows name: null -- an interactive session
  // can carry one -- so the second findTarget call a confirmed "yes" makes
  // must not depend on a name that was never there. This is the bug a
  // sessionId-less re-dispatch used to hit: `name ?? repo` fell through to
  // "Which session, sir?" for exactly this record.
  const roster = [{ name: null, sessionId: "a", number: 1 }];
  assert.deepEqual(findTarget(roster, undefined, { sessionId: "a" }), { record: roster[0], refusal: null });
});

test("a number nothing answers to names the count, in words, rather than refusing blind", () => {
  const roster = [
    { name: "jarvis-1-fix-tests", sessionId: "a", number: 1 },
    { name: "bug-hunt", sessionId: "b", number: 2 },
  ];
  assert.deepEqual(findTarget(roster, "", { number: 9 }), {
    record: null,
    refusal: "There is no session nine, sir. I count two.",
  });
});

test("a number against an empty roster counts none rather than saying no", () => {
  assert.deepEqual(findTarget([], "", { number: 3 }), {
    record: null,
    refusal: "There is no session three, sir. I count none.",
  });
});

test("a listing that could not be read is refused the same way whether addressed by number or by name", () => {
  assert.deepEqual(findTarget(null, "", { number: 3 }), {
    record: null,
    refusal: "I cannot see what is running just now, sir.",
  });
});

test("a query that cleans to nothing asks which session, before the roster is even consulted", () => {
  assert.deepEqual(findTarget([{ name: "jarvis-1" }], ""), {
    record: null,
    refusal: "Which session, sir?",
  });
  assert.deepEqual(findTarget([{ name: "jarvis-1" }], "   "), {
    record: null,
    refusal: "Which session, sir?",
  });
});

test("a roster that could not be read is a listing failure, not an unknown name", () => {
  assert.deepEqual(findTarget(null, "jarvis-1"), {
    record: null,
    refusal: "I cannot see what is running just now, sir.",
  });
  assert.deepEqual(findTarget(undefined, "jarvis-1"), {
    record: null,
    refusal: "I cannot see what is running just now, sir.",
  });
});

test("an unknown name names what was actually asked for", () => {
  const roster = [{ name: "jarvis-1-fix-tests", sessionId: "a" }];
  assert.deepEqual(findTarget(roster, "fitness-1"), {
    record: null,
    refusal: "I cannot find fitness-1 running, sir.",
  });
});

test("more than one match lists at most three names, never by position", () => {
  const roster = [
    { name: "jarvis-1-fix-tests", sessionId: "a" },
    { name: "jarvis-1-fix-linter", sessionId: "b" },
    { name: "jarvis-1-fix-readme", sessionId: "c" },
    { name: "jarvis-1-fix-build", sessionId: "d" },
  ];
  assert.deepEqual(findTarget(roster, "jarvis-1"), {
    record: null,
    refusal: "Which one, sir? jarvis-1-fix-tests, jarvis-1-fix-linter, jarvis-1-fix-readme.",
  });
});

test("exactly one match returns the record and no refusal", () => {
  const record = { name: "jarvis-1-fix-tests", sessionId: "a" };
  assert.deepEqual(findTarget([record], "jarvis-1-fix-tests"), { record, refusal: null });
});

// ---------------------------------------------------------------------------
// findTarget: the repo cross-check on a number
// ---------------------------------------------------------------------------

test("a repo alongside a number that agrees with the roster resolves normally", () => {
  const roster = [{ name: "jarvis-1-fix-tests", sessionId: "a", number: 1, alias: "jarvis" }];
  assert.deepEqual(findTarget(roster, "bug-hunt", { number: 1, alias: "jarvis" }), {
    record: roster[0],
    refusal: null,
  });
});

test("a repo alongside a number that disagrees with the roster is refused, naming the real one", () => {
  const roster = [{ name: "jarvis-1-fix-tests", sessionId: "a", number: 3, alias: "jarvis" }];
  assert.deepEqual(findTarget(roster, "", { number: 3, alias: "fitness" }), {
    record: null,
    refusal: "Session three is in jarvis, not fitness, sir.",
  });
});

test("the repo cross-check is case-insensitive, since a spoken letter resolves to whatever case the alias is stored in", () => {
  const roster = [{ name: "jarvis-1-fix-tests", sessionId: "a", number: 1, alias: "jarvis" }];
  assert.deepEqual(findTarget(roster, "", { number: 1, alias: "JARVIS" }), { record: roster[0], refusal: null });
});

test("the repo cross-check is skipped, not refused, when the record carries no alias at all", () => {
  const roster = [{ name: "jarvis-1-fix-tests", sessionId: "a", number: 1 }];
  assert.deepEqual(findTarget(roster, "", { number: 1, alias: "fitness" }), { record: roster[0], refusal: null });
});

test("addressing by name never applies the repo cross-check, even when it would disagree", () => {
  // The name path already had the name to go on -- a mismatched alias here
  // would just be the same wrong guess said twice, not new information.
  const roster = [{ name: "jarvis-1-fix-tests", sessionId: "a", alias: "jarvis" }];
  assert.deepEqual(findTarget(roster, "jarvis-1-fix-tests", { alias: "fitness" }), {
    record: roster[0],
    refusal: null,
  });
});

test("addressing by sessionId never applies the repo cross-check either", () => {
  // A sessionId re-targets a session a proposal already resolved once; there
  // is nothing new to cross-check on that second lookup.
  const roster = [{ name: "jarvis-1-fix-tests", sessionId: "a", alias: "jarvis" }];
  assert.deepEqual(findTarget(roster, "", { sessionId: "a", alias: "fitness" }), {
    record: roster[0],
    refusal: null,
  });
});

// ---------------------------------------------------------------------------
// describeIntent
// ---------------------------------------------------------------------------

test("a session to start is described by where and what", () => {
  assert.equal(
    describeIntent({ session: { verb: "start", repo: "jarvis", task: "summarize the README" } }),
    "Start a session in jarvis to summarize the README. Shall I, sir?",
  );
});

test("a named successor is read back as part of the same sentence", () => {
  assert.equal(
    describeIntent({
      session: { verb: "start", repo: "jarvis", task: "fix the tests", then: "run the linter" },
    }),
    "Start a session in jarvis to fix the tests, then run the linter. Shall I, sir?",
  );
});

test("a successor with nothing to follow is dropped rather than said with no clause to hang off", () => {
  assert.equal(
    describeIntent({ session: { verb: "start", repo: "jarvis", then: "run the linter" } }),
    "Start a session in jarvis. Shall I, sir?",
  );
});

test("a successor is only described for verb start, not tell or stop", () => {
  assert.equal(
    describeIntent({ session: { verb: "tell", name: "jarvis-1", task: "run it", then: "run the linter" } }),
    "Tell jarvis-1 to run it. Shall I, sir?",
  );
});

test("the workspace Dante resolved beats the alias the model wrote", () => {
  // They can differ, and the resolved one is where the session actually runs.
  assert.match(
    describeIntent({
      session: { verb: "start", repo: "fitnes", task: "run the tests" },
      workspace: { alias: "fitness", path: "/home/krane/development/KraneticFitness" },
    }),
    /^Start a session in fitness /,
  );
});

test("a start with no repo named still names the one it will actually run in", () => {
  // server.js resolves session.repo to the main repository before this is
  // ever called (see resolveRepoAlias in lib/memory.js), so `workspace` here
  // is exactly what a real caller passes for "no repo said out loud" -- the
  // confirmation must say where it lands, not go silent about it the way it
  // would if `where` fell back to the never-set session.repo instead.
  assert.equal(
    describeIntent({ session: { verb: "start", task: "fix the tests" }, workspace: { alias: "fitness" } }),
    "Start a session in fitness to fix the tests. Shall I, sir?",
  );
});

test("a follow-up and a stop name the session, because that is what is at stake", () => {
  assert.equal(
    describeIntent({ session: { verb: "tell", name: "jarvis-1", task: "also run the tests" } }),
    "Tell jarvis-1 to also run the tests. Shall I, sir?",
  );
  assert.equal(
    describeIntent({ session: { verb: "stop", name: "jarvis-1" } }),
    "Stop jarvis-1. Shall I, sir?",
  );
});

test("an interrupt names the session and, unlike tell, still confirms with no task", () => {
  assert.equal(
    describeIntent({ session: { verb: "interrupt", name: "jarvis-1", task: "check the other file first" } }),
    "Interrupt jarvis-1 and tell it to check the other file first. Shall I, sir?",
  );
  assert.equal(
    describeIntent({ session: { verb: "interrupt", name: "jarvis-1" } }),
    "Interrupt jarvis-1. Shall I, sir?",
  );
});

test("an interrupt resolves who by name, then by the repo alias, and is silent with neither", () => {
  assert.match(
    describeIntent({
      session: { verb: "interrupt", repo: "fitnes", task: "stop and check the logs" },
      workspace: { alias: "fitness", path: "/home/krane/development/KraneticFitness" },
    }),
    /^Interrupt fitness /,
  );
  assert.equal(describeIntent({ session: { verb: "interrupt" } }), null);
});

test("a task is read back as part of the sentence, not quoted at someone", () => {
  // A model writes a capitalised sentence with a full stop; this lands
  // mid-sentence, where both would be wrong.
  assert.equal(
    describeIntent({ session: { verb: "start", repo: "jarvis", task: "Summarize the README." } }),
    "Start a session in jarvis to summarize the README. Shall I, sir?",
  );
  // An acronym keeps its case: only a leading Capital-then-lowercase is a
  // sentence capital.
  assert.match(
    describeIntent({ session: { verb: "start", repo: "jarvis", task: "README needs a summary" } }),
    /to README needs a summary/,
  );
});

test("a build names what it is building and what it is about", () => {
  assert.equal(
    describeIntent({ action: { primitive: "landing-page", params: { subject: "the fitness app" } } }),
    "Build a landing page for the fitness app. Shall I, sir?",
  );
  assert.equal(
    describeIntent({ action: { primitive: "landing-page", params: {} } }),
    "Build a landing page. Shall I, sir?",
  );
  assert.equal(
    describeIntent({ action: { primitive: "email-draft", params: {} } }),
    "Build an email draft. Shall I, sir?",
  );
});

test("the primitive Dante resolved beats the one the model named", () => {
  assert.match(
    describeIntent({ action: { primitive: "landing", params: {} }, primitive: { id: "landing-page" } }),
    /^Build a landing page\./,
  );
});

test("a tag nothing can be said about is not held back", () => {
  // Better dispatched, where the dispatcher explains itself, than confirmed
  // with a sentence nobody understands.
  assert.equal(describeIntent({ session: { verb: "explode", name: "jarvis-1" } }), null);
  assert.equal(describeIntent({ session: { verb: "stop" } }), null);
  assert.equal(describeIntent({ session: { verb: "tell", name: "jarvis-1" } }), null);
  assert.equal(describeIntent({ action: { primitive: "" } }), null);
  assert.equal(describeIntent({}), null);
  assert.equal(describeIntent(), null);
});

test("a read is deliberately not describable, so it is never held for a confirmation", () => {
  // This module exists because start, tell and stop reach a real process. A read
  // touches nothing, and holding "what did jarvis three do?" for a "Shall I,
  // sir?" would put a spoken round trip in front of every question someone asks
  // about their own work. null here is the mechanism that lets it run.
  assert.equal(describeIntent({ session: { verb: "read", name: "jarvis-1" } }), null);
  assert.equal(
    describeIntent({ session: { verb: "read", name: "jarvis-1", question: "did the tests pass?" } }),
    null,
  );
});

test("a recap is never described, because it is never confirmed", () => {
  // It changes no process, so server.js dispatches it straight off the parsed
  // tag -- the same exemption [MEMORY:SET] gets, applied here rather than
  // there because a session tag is what a recap arrives as.
  assert.equal(describeIntent({ session: { verb: "recap" } }), null);
});

test("a start with no repository is still describable, because refusing is the dispatcher's job", () => {
  assert.equal(
    describeIntent({ session: { verb: "start", task: "read the README" } }),
    "Start a session to read the README. Shall I, sir?",
  );
});

test("a start carrying a brief says the brief is on screen rather than reading it", () => {
  // The brief can be several sentences; the page shows it verbatim. What IS
  // spoken is built from the tag, which is the property this module exists for.
  assert.equal(
    describeIntent({ session: { verb: "start", repo: "jarvis", task: "fix the tests", brief: "Fix the failing test in src/app.js. The issue is that the mock is not set up correctly." } }),
    "Start a session in jarvis to fix the tests, with the brief on screen. Shall I, sir?",
  );
  assert.equal(
    describeIntent({ session: { verb: "start", repo: "jarvis", brief: "Some instructions here." } }),
    "Start a session in jarvis, with the brief on screen. Shall I, sir?",
  );
});

test("a tell or interrupt carrying a brief says so too, a stop never does", () => {
  assert.equal(
    describeIntent({ session: { verb: "tell", name: "jarvis-1", task: "run the tests", brief: "Run the tests and report back." } }),
    "Tell jarvis-1 to run the tests, with the brief on screen. Shall I, sir?",
  );
  assert.equal(
    describeIntent({ session: { verb: "interrupt", name: "jarvis-1", task: "check the logs", brief: "Look at the error logs." } }),
    "Interrupt jarvis-1 and tell it to check the logs, with the brief on screen. Shall I, sir?",
  );
  assert.equal(
    describeIntent({ session: { verb: "interrupt", name: "jarvis-1", brief: "Stop and wait." } }),
    "Interrupt jarvis-1, with the brief on screen. Shall I, sir?",
  );
  // Stop never mentions a brief, regardless of whether one is present
  assert.equal(
    describeIntent({ session: { verb: "stop", name: "jarvis-1", brief: "Stop this session." } }),
    "Stop jarvis-1. Shall I, sir?",
  );
});

test("an empty brief is no brief", () => {
  assert.equal(
    describeIntent({ session: { verb: "start", repo: "jarvis", task: "fix the tests", brief: "" } }),
    "Start a session in jarvis to fix the tests. Shall I, sir?",
  );
  assert.equal(
    describeIntent({ session: { verb: "start", repo: "jarvis", task: "fix the tests", brief: "   " } }),
    "Start a session in jarvis to fix the tests. Shall I, sir?",
  );
});

test("everything spoken is capped and stripped, because a model wrote it", () => {
  const rlo = String.fromCharCode(0x202e);
  const spoken = describeIntent({
    session: { verb: "start", repo: `jar${rlo}vis`, task: "x".repeat(MAX_TASK_CHARS * 3) },
  });
  assert.equal(spoken.includes(rlo), false);
  assert.match(spoken, /^Start a session in jarvis to x{140}\. Shall I, sir\?$/);

  assert.equal(
    describeIntent({ session: { verb: "tell", name: "jarvis-1", task: "run\nthe tests" } }),
    "Tell jarvis-1 to run the tests. Shall I, sir?",
  );
});

test("a verb is read whatever case it arrives in", () => {
  assert.match(describeIntent({ session: { verb: "START", repo: "jarvis", task: "x" } }), /^Start a session/);
});

test("the session Dante resolved beats the name the model wrote", () => {
  assert.equal(
    describeIntent({
      session: { verb: "stop", name: "jarvis-1" },
      target: { name: "jarvis-1-fix-failing-builder-test" },
    }),
    "Stop jarvis-1-fix-failing-builder-test. Shall I, sir?",
  );
  assert.equal(
    describeIntent({
      session: { verb: "interrupt", name: "jarvis-1", task: "check the other file first" },
      target: { name: "jarvis-1-fix-failing-builder-test" },
    }),
    "Interrupt jarvis-1-fix-failing-builder-test and tell it to check the other file first. Shall I, sir?",
  );
  assert.equal(
    describeIntent({
      session: { verb: "tell", name: "jarvis-1", task: "run it" },
      target: { name: "jarvis-1-fix-failing-builder-test" },
    }),
    "Tell jarvis-1-fix-failing-builder-test to run it. Shall I, sir?",
  );
});

test("a session addressed by number is confirmed by number, with the resolved name appended", () => {
  assert.equal(
    describeIntent({
      session: { verb: "stop", number: "3" },
      target: { name: "bug-hunt" },
    }),
    "Stop session three, bug-hunt. Shall I, sir?",
  );
  assert.equal(
    describeIntent({
      session: { verb: "tell", number: "3", task: "run the tests" },
      target: { name: "bug-hunt" },
    }),
    "Tell session three, bug-hunt to run the tests. Shall I, sir?",
  );
  assert.equal(
    describeIntent({
      session: { verb: "interrupt", number: "3", task: "check the other file first" },
      target: { name: "bug-hunt" },
    }),
    "Interrupt session three, bug-hunt and tell it to check the other file first. Shall I, sir?",
  );
});

test("a session addressed by number with nothing yet resolved says the number alone", () => {
  assert.equal(
    describeIntent({ session: { verb: "stop", number: "3" } }),
    "Stop session three. Shall I, sir?",
  );
});

// ---------------------------------------------------------------------------
// describeIntent - watch
// ---------------------------------------------------------------------------

test("a watch by name is confirmed with a promise to report back", () => {
  assert.equal(
    describeIntent({ session: { verb: "watch", name: "jarvis-1" } }),
    "Watch jarvis-1 and tell you the moment it stops working. Shall I, sir?",
  );
});

test("a watch by number uses whoFor, the same as stop, tell and interrupt", () => {
  assert.equal(
    describeIntent({ session: { verb: "watch", number: "3" }, target: { name: "bug-hunt" } }),
    "Watch session three, bug-hunt and tell you the moment it stops working. Shall I, sir?",
  );
});

test("a watch says back the session Dante resolved, not the one the model wrote", () => {
  assert.equal(
    describeIntent({
      session: { verb: "watch", name: "jarvis-1" },
      target: { name: "jarvis-1-fix-failing-builder-test" },
    }),
    "Watch jarvis-1-fix-failing-builder-test and tell you the moment it stops working. Shall I, sir?",
  );
});

test("a watch tag with nothing to name describes nothing, so it is clarified instead", () => {
  assert.equal(describeIntent({ session: { verb: "watch" } }), null);
});

// ---------------------------------------------------------------------------
// readTarget
// ---------------------------------------------------------------------------

// A live roster record (what findTarget resolves a number against) and its
// recallableSessions counterpart (what dispatchRead actually needs -- task,
// running) are deliberately different shapes here, the same way they are in
// practice: one comes off `claude agents --json`, the other off the store.
const LIVE = [{ name: "bug-hunt", sessionId: "a", number: 1, cwd: "/home/krane/development/jarvis" }];
const CANDIDATE = { sessionId: "a", name: "bug-hunt", cwd: "/home/krane/development/jarvis", task: "fix the tests", running: true };

test("a number hits a live session that is also readable, and returns its candidate shape", () => {
  assert.deepEqual(readTarget(LIVE, [CANDIDATE], { number: 1 }), { record: CANDIDATE, refusal: null });
});

test("a number hits a live session with nothing readable yet -- started this tick, no transcript", () => {
  // recallableSessions drops a session with no transcript on disk, which a
  // session started this very tick has not written yet -- findTarget alone
  // would happily resolve it, so this is the one refusal readTarget adds on
  // top of findTarget's own.
  assert.deepEqual(readTarget(LIVE, [], { number: 1 }), {
    record: null,
    refusal: "I have nothing readable by that number, sir.",
  });
});

test("a number that matches nothing on the roster is refused the way findTarget refuses it", () => {
  assert.deepEqual(readTarget(LIVE, [CANDIDATE], { number: 9 }), {
    record: null,
    refusal: "There is no session nine, sir. I count one.",
  });
});

test("a listing that could not be read refuses before either list is even consulted", () => {
  assert.deepEqual(readTarget(null, [CANDIDATE], { number: 1 }), {
    record: null,
    refusal: "I cannot see what is running just now, sir.",
  });
});

test("with no number, a name is matched against the candidates, live or finished alike", () => {
  const finished = { sessionId: "b", name: "readme-summary", cwd: "/x", task: "", running: false };
  assert.deepEqual(readTarget([], [finished], { name: "readme-summary" }), { record: finished, refusal: null });
});

test("a name nothing answers to is refused by name, not by number", () => {
  assert.deepEqual(readTarget(LIVE, [CANDIDATE], { name: "nonsense" }), {
    record: null,
    refusal: "I have nothing readable by that name, sir.",
  });
});

// ---------------------------------------------------------------------------
// clarify
// ---------------------------------------------------------------------------

test("a tell with no task asks what to tell the target, by its resolved name", () => {
  assert.equal(
    clarify({
      session: { verb: "tell", name: "jarvis-1" },
      target: { name: "jarvis-1-fix-failing-builder-test" },
    }),
    "What should I tell jarvis-1-fix-failing-builder-test, sir?",
  );
});

test("a stop with nothing to name asks which session, not what to say to it", () => {
  assert.equal(clarify({ session: { verb: "stop" } }), "Which session, sir?");
  assert.equal(clarify({ session: { verb: "interrupt" } }), "Which session, sir?");
  assert.equal(clarify({ session: { verb: "tell" } }), "Which session, sir?");
});

test("a watch with nothing to name asks which session too, the default clarify question", () => {
  assert.equal(clarify({ session: { verb: "watch" } }), "Which session, sir?");
});

test("a read is not a confirmable verb, so clarify has nothing to ask", () => {
  assert.equal(clarify({ session: { verb: "read", name: "jarvis-1" } }), null);
  assert.equal(clarify({ session: { verb: "recap" } }), null);
  assert.equal(clarify({}), null);
});

// ---------------------------------------------------------------------------
// readAnswer
// ---------------------------------------------------------------------------

test("yes runs it and no drops it", () => {
  for (const text of ["yes", "go ahead", "do it", "sure"]) assert.equal(readAnswer(text), "yes", text);
  for (const text of ["no", "nope", "cancel", "don't"]) assert.equal(readAnswer(text), "no", text);
});

test("anything else is a correction rather than an answer", () => {
  // The outcome that makes the loop worth having: this is not a refusal and
  // not an approval, it is the next turn.
  for (const text of ["in fitness instead", "hmm", "", null]) {
    assert.equal(readAnswer(text), "amend", String(text));
  }
});

test("a correction that opens with a refusal is still a correction", () => {
  // The sentence that made the word count necessary. To parseYesNo this is a
  // flat "no", which would drop the correction and make the person say it
  // twice.
  assert.equal(readAnswer("no, the whole repo, not just the README"), "amend");
  assert.equal(readAnswer("not that one, the other session"), "amend");
});

test("an answer is short, and a sentence is not an answer", () => {
  assert.equal(readAnswer("yes that's fine"), "yes");
  assert.equal(readAnswer("not now"), "no");
  assert.equal(readAnswer("yes go ahead and start it in fitness"), "amend");
});

test("a sentence that says both ways is a correction, never a yes", () => {
  assert.equal(readAnswer("yes but in fitness, not jarvis"), "amend");
  assert.equal(readAnswer("no, go ahead"), "amend");
});

// ---------------------------------------------------------------------------
// readConfirmingAnswer
// ---------------------------------------------------------------------------

test("four words or fewer reads exactly like readAnswer", () => {
  for (const text of ["yes", "go ahead", "do it", "sure", "yes that's fine", "not now"]) {
    assert.equal(readConfirmingAnswer(text), readAnswer(text), text);
  }
  for (const text of ["no", "nope", "cancel", "don't"]) {
    assert.equal(readConfirmingAnswer(text), readAnswer(text), text);
  }
});

test("a long, plain yes to the read-back is still a yes, not a correction", () => {
  // The asymmetry this exists for: misreading a genuine yes here sends the
  // model around to propose again, and the whole read-back gets spoken a
  // second time -- the very duplicate this replaced.
  assert.equal(readConfirmingAnswer("yes that is exactly right"), "yes");
  assert.equal(readConfirmingAnswer("go ahead that is right"), "yes");
  assert.equal(readConfirmingAnswer("yes that's right, nothing to change"), "yes");
  assert.equal(readConfirmingAnswer("yes that's actually perfect"), "yes");
});

test("a long answer that corrects something, even while agreeing, is a correction", () => {
  assert.equal(readConfirmingAnswer("yes but only the test file"), "amend");
  assert.equal(readConfirmingAnswer("no, the other test not that one"), "amend");
  assert.equal(readConfirmingAnswer("yes, actually make it the whole repo"), "amend");
  assert.equal(readConfirmingAnswer("yes and also skip the lint"), "amend");
});

test("a word that names a real content change, not a filler word, reads as a correction even though a yes word is present", () => {
  // The allowlist's whole point: a word this recognises neither as a YES
  // word nor as filler is where a correction hides, and a blacklist of
  // correction words could never enumerate every noun that might show up
  // there.
  assert.equal(readConfirmingAnswer("sure, in the fitness repo"), "amend");
  assert.equal(readConfirmingAnswer("okay so make it the whole test suite"), "amend");
});

// ---------------------------------------------------------------------------
// isAnswerable
// ---------------------------------------------------------------------------

test("a proposal is answered in the next breath or not at all", () => {
  // A "yes" ten minutes later agrees to something the person stopped thinking
  // about, and there is a real process on the end of it.
  assert.equal(isAnswerable(1000, 1000 + PROPOSAL_TTL_MS - 1), true);
  assert.equal(isAnswerable(1000, 1000 + PROPOSAL_TTL_MS), false);
  assert.equal(isAnswerable(1000, 1000), true);
});

test("a proposal with no timestamp is not answerable", () => {
  assert.equal(isAnswerable(undefined), false);
  assert.equal(isAnswerable(null, 1000), false);
  assert.equal(isAnswerable("1000", 1000), false);
});

test("a slash command is said back exactly, for a start and a tell", () => {
  assert.equal(
    describeIntent({ session: { verb: "start", repo: "jarvis", command: "/review high", task: "run /review high" } }),
    "Start a session in jarvis running /review high. Shall I, sir?",
  );
  assert.equal(
    describeIntent({ session: { verb: "tell", name: "fix-tests", command: "/compact" } }),
    "Send /compact to fix-tests. Shall I, sir?",
  );
  // An interrupt never carries a command by the time it is described (server.js
  // turns one into a tell), so the interrupt sentence ignores the key.
  assert.equal(
    describeIntent({ session: { verb: "interrupt", name: "fix-tests", command: "/compact", task: "tidy up" } }),
    "Interrupt fix-tests and tell it to tidy up. Shall I, sir?",
  );
  // The command outranks a task and a brief on the same tag: what is said is
  // what runs, and the brief is not part of what runs.
  assert.equal(
    describeIntent({ session: { verb: "tell", name: "fix-tests", command: "/compact", task: "tidy up", brief: "Goal: tidy" } }),
    "Send /compact to fix-tests. Shall I, sir?",
  );
});

test("a command without its slash is not a command, and the sentence falls back to the task", () => {
  assert.equal(
    describeIntent({ session: { verb: "tell", name: "fix-tests", command: "compact", task: "tidy up" } }),
    "Tell fix-tests to tidy up. Shall I, sir?",
  );
});
