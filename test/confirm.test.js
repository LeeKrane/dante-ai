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
  readAnswer,
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

test("an interview question is never held for a confirmation", () => {
  // The question is the reply, and holding it would put a Shall I, sir? in
  // front of a question.
  assert.equal(needsConfirmation({ verb: "interview" }), false);
  assert.equal(describeIntent({ session: { verb: "interview", repo: "jarvis", note: "x" } }), null);
});

// ---------------------------------------------------------------------------
// findTarget
// ---------------------------------------------------------------------------

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
