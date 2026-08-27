import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TASK_CHARS,
  PROPOSAL_TTL_MS,
  describeIntent,
  isAnswerable,
  readAnswer,
} from "../lib/confirm.js";

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
