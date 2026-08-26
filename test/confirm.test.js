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

test("the workspace jarvis resolved beats the alias the model wrote", () => {
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

test("the primitive jarvis resolved beats the one the model named", () => {
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
