import test from "node:test";
import assert from "node:assert/strict";

import {
  INTERVIEW_TTL_MS,
  MAX_BRIEF_CHARS,
  MAX_NOTES,
  MAX_QUESTIONS,
  composeBrief,
  interviewBlock,
  isLive,
  markProceed,
  matches,
  noteInterview,
  wantsToProceed,
} from "../lib/interview.js";

// ---------------------------------------------------------------------------
// noteInterview
// ---------------------------------------------------------------------------

test("a first interview tag starts a state that counts one question and keeps the note", () => {
  const state = noteInterview(null, { verb: "interview", for: "start", repo: "jarvis", note: "wants the tests fixed" }, 1000);
  assert.deepEqual(state, {
    verb: "start",
    repo: "jarvis",
    notes: ["wants the tests fixed"],
    asked: 1,
    at: 1000,
    proceed: false,
  });
});

test("a note is appended and the count goes up, and the input state is not mutated", () => {
  const first = noteInterview(null, { verb: "interview", for: "start", repo: "jarvis", note: "first note" }, 1000);
  const snapshot = { ...first, notes: [...first.notes] };

  const second = noteInterview(first, { verb: "interview", note: "second note" }, 2000);

  assert.deepEqual(second, {
    verb: "start",
    repo: "jarvis",
    notes: ["first note", "second note"],
    asked: 2,
    at: 2000,
    proceed: false,
  });
  assert.deepEqual(first, snapshot);
});

test("an interview that has expired starts over rather than continuing", () => {
  const stale = noteInterview(null, { verb: "interview", for: "start", repo: "jarvis", note: "old note" }, 1000);
  const now = 1000 + INTERVIEW_TTL_MS;

  const restarted = noteInterview(stale, { verb: "interview", for: "tell", repo: "fitness", note: "new note" }, now);

  assert.deepEqual(restarted, {
    verb: "tell",
    repo: "fitness",
    notes: ["new note"],
    asked: 1,
    at: now,
    proceed: false,
  });
});

test("the verb comes from the tag's for key and falls back to start", () => {
  assert.equal(noteInterview(null, { verb: "interview", for: "tell" }, 1000).verb, "tell");
  assert.equal(noteInterview(null, { verb: "interview", for: "INTERRUPT" }, 1000).verb, "interrupt");
  assert.equal(noteInterview(null, { verb: "interview" }, 1000).verb, "start");
  // A for outside the interview vocabulary (stop, or garbage) is not a verb
  // this module knows how to plan for, so it falls back the same as absent.
  assert.equal(noteInterview(null, { verb: "interview", for: "stop" }, 1000).verb, "start");

  const started = noteInterview(null, { verb: "interview", for: "tell" }, 1000);
  // Once an interview is under way, a tag with no `for` continues the same
  // verb rather than falling all the way back to "start".
  assert.equal(noteInterview(started, { verb: "interview" }, 2000).verb, "tell");
});

test("only the last few notes are kept, because a brief has to stay short", () => {
  let state = null;
  for (let i = 1; i <= MAX_NOTES + 3; i++) {
    state = noteInterview(state, { verb: "interview", note: `note ${i}` }, i * 1000);
  }
  assert.equal(state.notes.length, MAX_NOTES);
  assert.deepEqual(state.notes, ["note 4", "note 5", "note 6", "note 7", "note 8", "note 9"]);
  assert.equal(state.asked, MAX_NOTES + 3);
});

// ---------------------------------------------------------------------------
// isLive / matches
// ---------------------------------------------------------------------------

test("a tag for the same verb matches an interview, a different verb does not, and the repo is not compared", () => {
  const state = noteInterview(null, { verb: "interview", for: "start", repo: "jarvis" }, 1000);
  assert.equal(matches(state, { verb: "start", repo: "fitness" }), true);
  assert.equal(matches(state, { verb: "START" }), true);
  assert.equal(matches(state, { verb: "tell", repo: "jarvis" }), false);
  assert.equal(matches(null, { verb: "start" }), false);
});

test("no live interview means no block", () => {
  assert.equal(interviewBlock(null), "");
  assert.equal(interviewBlock(undefined), "");
  const expired = noteInterview(null, { verb: "interview", for: "start" }, 1000);
  assert.equal(interviewBlock(expired, 1000 + INTERVIEW_TTL_MS), "");
  assert.equal(isLive(expired, 1000 + INTERVIEW_TTL_MS), false);
  assert.equal(isLive(expired, 1000 + INTERVIEW_TTL_MS - 1), true);
});

// ---------------------------------------------------------------------------
// wantsToProceed
// ---------------------------------------------------------------------------

test("the escape phrase is read only from a short sentence", () => {
  for (const text of [
    "just start it",
    "just do it",
    "just go",
    "go ahead",
    "that's enough",
    "that is enough",
    "enough questions",
    "no more questions",
    "skip the questions",
    "start it now",
    "proceed",
    "okay, go ahead.",
  ]) {
    assert.equal(wantsToProceed(text), true, text);
  }
});

test("a long sentence that mentions go ahead is not an escape", () => {
  assert.equal(
    wantsToProceed("well I don't think we should just go ahead with that plan yet, honestly"),
    false,
  );
});

test("an ordinary answer to a question is not an escape", () => {
  for (const text of ["fix the failing tests", "in the fitness repo", "yes", "no", ""]) {
    assert.equal(wantsToProceed(text), false, text);
  }
});

// ---------------------------------------------------------------------------
// interviewBlock
// ---------------------------------------------------------------------------

test("the block says how many questions are left and stops asking at the cap", () => {
  let state = noteInterview(null, { verb: "interview", for: "start", repo: "jarvis", note: "first note" }, 1000);
  state = noteInterview(state, { verb: "interview", note: "second note" }, 2000);

  assert.equal(
    interviewBlock(state, 2000),
    "INTERVIEW in progress: planning a start in jarvis. 2 of 4 questions asked. " +
      "Learned so far: first note; second note. Ask at most 2 more, one per turn, or propose now if the picture is clear.",
  );

  let capped = state;
  for (let i = 0; i < MAX_QUESTIONS - 2; i++) {
    capped = noteInterview(capped, { verb: "interview" }, 3000 + i);
  }
  assert.equal(capped.asked, MAX_QUESTIONS);
  assert.match(
    interviewBlock(capped, 3000),
    /Question limit reached: ask nothing more, propose now with what you have\.$/,
  );
});

test("the block omits the repo and the notes sentence when there is nothing to say", () => {
  const state = noteInterview(null, { verb: "interview", for: "tell" }, 1000);
  assert.equal(
    interviewBlock(state, 1000),
    "INTERVIEW in progress: planning a tell. 1 of 4 questions asked. Ask at most 3 more, one per turn, or propose now if the picture is clear.",
  );

  const interrupting = noteInterview(null, { verb: "interview", for: "interrupt" }, 1000);
  assert.match(interviewBlock(interrupting, 1000), /^INTERVIEW in progress: planning an interrupt\. /);
});

test("a proceed beats the cap sentence and says Jesse asked for it", () => {
  let capped = noteInterview(null, { verb: "interview", for: "start", repo: "jarvis" }, 1000);
  for (let i = 1; i < MAX_QUESTIONS; i++) {
    capped = noteInterview(capped, { verb: "interview" }, 1000 + i);
  }
  assert.equal(capped.asked, MAX_QUESTIONS);
  assert.match(interviewBlock(capped, 1000), /Question limit reached/);

  const proceeding = markProceed(capped);
  assert.match(
    interviewBlock(proceeding, 1000),
    /Jesse asked you to proceed: ask nothing more, propose now with what you have\.$/,
  );
  assert.equal(interviewBlock(proceeding, 1000).includes("Question limit reached"), false);

  assert.equal(markProceed(null), null);
});

// ---------------------------------------------------------------------------
// composeBrief
// ---------------------------------------------------------------------------

test("a brief the model wrote wins over the task and notes", () => {
  assert.equal(
    composeBrief({ task: "fix the tests", notes: ["it's the builder test"], brief: "Fix the failing builder test in lib/builder.js." }),
    "Fix the failing builder test in lib/builder.js.",
  );
});

test("with no brief the task and the notes become one", () => {
  assert.equal(
    composeBrief({ task: "fix the tests", notes: ["it's the builder test", "only that one file"] }),
    "fix the tests Context from the conversation: it's the builder test. only that one file.",
  );
  // A note that already ends its own sentence keeps its own punctuation.
  assert.equal(
    composeBrief({ task: "fix the tests", notes: ["is it the builder test?"] }),
    "fix the tests Context from the conversation: is it the builder test?",
  );
  // No notes at all: just the cleaned task.
  assert.equal(composeBrief({ task: "fix the tests", notes: [] }), "fix the tests");
  assert.equal(composeBrief({ task: "fix the tests" }), "fix the tests");
});

test("nothing survives when there is neither a brief nor a task", () => {
  assert.equal(composeBrief({}), "");
  assert.equal(composeBrief(), "");
  assert.equal(composeBrief({ notes: ["a note with nothing to attach it to"] }), "");
});

test("a brief is capped and stripped because a model wrote it", () => {
  const rlo = String.fromCharCode(0x202e);
  const brief = composeBrief({ task: "fallback", brief: `${rlo}${"x".repeat(MAX_BRIEF_CHARS * 2)}` });
  assert.equal(brief.includes(rlo), false);
  assert.equal(brief.length, MAX_BRIEF_CHARS);
  assert.equal(brief, "x".repeat(MAX_BRIEF_CHARS));
});
