import test from "node:test";
import assert from "node:assert/strict";

import {
  FACETS,
  INTERVIEW_TTL_MS,
  MAX_BRIEF_CHARS,
  MAX_NOTES,
  MAX_SAID,
  cleanBrief,
  composeBrief,
  interviewBlock,
  isLive,
  markProceed,
  matches,
  noteInterview,
  wantsToProceed,
} from "../lib/interview.js";
import { parseAction } from "../lib/action.js";

// ---------------------------------------------------------------------------
// noteInterview
// ---------------------------------------------------------------------------

test("a first interview tag starts a state that counts one question, keeps the note, and keeps what was said", () => {
  const state = noteInterview(
    null,
    { verb: "interview", for: "start", repo: "jarvis", have: "goal", note: "wants the tests fixed" },
    1000,
    "fix the failing tests in jarvis",
  );
  assert.deepEqual(state, {
    verb: "start",
    repo: "jarvis",
    notes: ["wants the tests fixed"],
    said: ["fix the failing tests in jarvis"],
    covered: ["goal", "where"],
    asked: 1,
    at: 1000,
    proceed: false,
  });
});

test("a note and a said line are both appended and the count goes up, and the input state is not mutated", () => {
  const first = noteInterview(
    null,
    { verb: "interview", for: "start", repo: "jarvis", have: "goal", note: "first note" },
    1000,
    "first thing said",
  );
  const snapshot = { ...first, notes: [...first.notes], said: [...first.said], covered: [...first.covered] };

  const second = noteInterview(
    first,
    { verb: "interview", have: "goal, constraints", note: "second note" },
    2000,
    "second thing said",
  );

  assert.deepEqual(second, {
    verb: "start",
    repo: "jarvis",
    notes: ["first note", "second note"],
    said: ["first thing said", "second thing said"],
    covered: ["goal", "where", "constraints"],
    asked: 2,
    at: 2000,
    proceed: false,
  });
  assert.deepEqual(first, snapshot);
});

test("an interview that has expired starts over rather than continuing", () => {
  const stale = noteInterview(
    null,
    { verb: "interview", for: "start", repo: "jarvis", note: "old note" },
    1000,
    "old ask",
  );
  const now = 1000 + INTERVIEW_TTL_MS;

  const restarted = noteInterview(
    stale,
    { verb: "interview", for: "tell", repo: "fitness", note: "new note" },
    now,
    "new ask",
  );

  assert.deepEqual(restarted, {
    verb: "tell",
    repo: "fitness",
    notes: ["new note"],
    said: ["new ask"],
    covered: ["where"],
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

test("said may be an array of sentences from a superseded turn, and each becomes its own entry in order", () => {
  const state = noteInterview(
    null,
    { verb: "interview", note: "wants both fixed" },
    1000,
    ["fix the tests", "also update the docs"],
  );
  assert.deepEqual(state.said, ["fix the tests", "also update the docs"]);

  // An empty entry inside the array is dropped, same as a single empty string
  // would be, and the rest keep their order.
  const withEmpty = noteInterview(state, { verb: "interview" }, 2000, ["", "one more thing", "   "]);
  assert.deepEqual(withEmpty.said, ["fix the tests", "also update the docs", "one more thing"]);
});

test("only the last MAX_NOTES notes and the last MAX_SAID said lines are kept, because a brief has to stay bounded", () => {
  let state = null;
  for (let i = 1; i <= MAX_NOTES + 3; i++) {
    state = noteInterview(state, { verb: "interview", note: `note ${i}` }, i * 1000, `said ${i}`);
  }
  assert.equal(state.notes.length, MAX_NOTES);
  assert.equal(state.notes[0], "note 4");
  assert.equal(state.notes[state.notes.length - 1], `note ${MAX_NOTES + 3}`);
  assert.equal(state.said.length, MAX_SAID);
  assert.equal(state.said[0], "said 4");
  assert.equal(state.said[state.said.length - 1], `said ${MAX_SAID + 3}`);
  assert.equal(state.asked, MAX_NOTES + 3);
});

// ---------------------------------------------------------------------------
// have= parsing (covered)
// ---------------------------------------------------------------------------

test("have= is parsed case- and spacing-insensitively, drops unknown names, and orders as FACETS regardless of input order", () => {
  const state = noteInterview(null, { verb: "interview", have: "Done,   GOAL  where foo bar" }, 1000);
  assert.deepEqual(state.covered, ["goal", "where", "done"]);
  assert.deepEqual(FACETS, ["goal", "where", "constraints", "done"]);
});

test("a real tag, parsed end to end, teaches have= the way the persona now does -- no spaces, comma-separated", () => {
  // lib/action.js's PAIR takes \S* for an unquoted value, so a have= written
  // with a space after the comma ("goal, where") would parse as just "goal,".
  // The persona now teaches have=goal,where with no spaces, and this is the
  // parser actually reading a tag built that way, not just noteInterview
  // called with an already-split value.
  const unquoted = parseAction(
    'Which repo? [ACTION:SESSION verb=interview for=start have=goal,constraints note="wants the tests fixed"]',
  ).session;
  assert.deepEqual(noteInterview(null, unquoted, 1000).covered, ["goal", "constraints"]);

  // The quoted form -- have="goal, constraints" -- survives a space after the
  // comma because the whole value is inside quotes, and parseHave's own
  // /[\s,]+/ split tolerates it regardless.
  const quoted = parseAction(
    'Which repo? [ACTION:SESSION verb=interview for=start have="goal, constraints" note="wants the tests fixed"]',
  ).session;
  assert.deepEqual(noteInterview(null, quoted, 1000).covered, ["goal", "constraints"]);
});

test("an absent have key keeps the previous covered list, and a present-but-empty one resets it", () => {
  const first = noteInterview(null, { verb: "interview", have: "goal" }, 1000);
  assert.deepEqual(first.covered, ["goal"]);

  const silent = noteInterview(first, { verb: "interview" }, 2000);
  assert.deepEqual(silent.covered, ["goal"]);

  const cleared = noteInterview(silent, { verb: "interview", have: "" }, 3000);
  assert.deepEqual(cleared.covered, []);
});

test("a known repo counts as where covered, whether or not have= said so", () => {
  const noRepo = noteInterview(null, { verb: "interview", have: "goal" }, 1000);
  assert.deepEqual(noRepo.covered, ["goal"]);

  const withRepo = noteInterview(noRepo, { verb: "interview", repo: "jarvis" }, 2000);
  assert.deepEqual(withRepo.covered, ["goal", "where"]);

  // where does not need to be named explicitly once a repo is known, and
  // naming it explicitly changes nothing.
  const named = noteInterview(null, { verb: "interview", repo: "jarvis", have: "where" }, 1000);
  assert.deepEqual(named.covered, ["where"]);
});

// ---------------------------------------------------------------------------
// isLive / matches
// ---------------------------------------------------------------------------

test("a tag for the same verb matches an interview, and the repo must match when both are known", () => {
  const state = noteInterview(null, { verb: "interview", for: "start", repo: "jarvis" }, 1000);
  assert.equal(matches(state, { verb: "start", repo: "jarvis" }), true);
  assert.equal(matches(state, { verb: "START", repo: "jarvis" }), true);
  // An interview about one repo does not match a start in another.
  assert.equal(matches(state, { verb: "start", repo: "fitness" }), false);
  // A tag that names no repo still matches.
  assert.equal(matches(state, { verb: "start" }), true);
  // A different verb never matches.
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

test("the newer stop-asking phrases are read as an escape the same way", () => {
  for (const text of [
    "stop asking",
    "stop the questions",
    "stop with the questions",
    "that'll do",
    "that will do",
    "you have enough",
    "you've got enough",
    "you know enough",
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

test("a refusal that contains an escape phrase is not an escape", () => {
  for (const text of ["no, do not proceed", "don't just go", "wait, not yet, don't start it"]) {
    assert.equal(wantsToProceed(text), false, text);
  }
});

test("stop alone is a negation rather than the stop-asking escape, and a refusal beats an escape phrase either way", () => {
  for (const text of ["stop", "no, stop", "don't stop asking"]) {
    assert.equal(wantsToProceed(text), false, text);
  }
});

// ---------------------------------------------------------------------------
// interviewBlock
// ---------------------------------------------------------------------------

test("the block reports nothing covered yet and asks for the biggest gap", () => {
  const state = { verb: "start", repo: "", notes: [], said: [], covered: [], asked: 1, at: 1000, proceed: false };
  assert.equal(
    interviewBlock(state, 1000),
    "INTERVIEW in progress: planning a start. 1 question asked. " +
      "Covered: none reported yet. Still open: goal, where, constraints, done. " +
      "Ask the one question that closes the biggest gap, one per turn, or propose now if the " +
      "request itself already settles what is open.",
  );
});

test("the block says every facet is covered and tells it to propose", () => {
  const state = {
    verb: "start", repo: "jarvis", notes: ["n1", "n2"], said: [],
    covered: ["goal", "where", "constraints", "done"], asked: 2, at: 2000, proceed: false,
  };
  assert.equal(
    interviewBlock(state, 2000),
    "INTERVIEW in progress: planning a start in jarvis. 2 questions asked. " +
      "Covered: goal, where, constraints, done. Still open: nothing. " +
      "Learned so far: n1; n2. " +
      "Every facet is covered: propose now, unless an answer left something genuinely open - " +
      "then ask about that one thing only.",
  );
});

test("the block names both the covered facets and the open ones", () => {
  const state = {
    verb: "start", repo: "jarvis", notes: [], said: [],
    covered: ["goal", "where"], asked: 2, at: 2000, proceed: false,
  };
  assert.equal(
    interviewBlock(state, 2000),
    "INTERVIEW in progress: planning a start in jarvis. 2 questions asked. " +
      "Covered: goal, where. Still open: constraints, done. " +
      "Ask the one question that closes the biggest gap, one per turn, or propose now if the " +
      "request itself already settles what is open.",
  );
});

test("a proceed beats the facet coverage no matter how much is still open", () => {
  const state = {
    verb: "start", repo: "jarvis", notes: [], said: [],
    covered: ["goal"], asked: 3, at: 1000, proceed: false,
  };
  const proceeding = markProceed(state);
  assert.equal(
    interviewBlock(proceeding, 1000),
    "INTERVIEW in progress: planning a start in jarvis. 3 questions asked. " +
      "Covered: goal. Still open: where, constraints, done. " +
      "Krane asked you to proceed: ask nothing more, propose now with what you have.",
  );
  assert.equal(markProceed(null), null);
});

test("what Krane said is read back in order, numbered", () => {
  const state = {
    verb: "start", repo: "jarvis", notes: [], said: ["fix the tests", "in jarvis"],
    covered: [], asked: 2, at: 1000, proceed: false,
  };
  assert.equal(
    interviewBlock(state, 1000),
    "INTERVIEW in progress: planning a start in jarvis. 2 questions asked. " +
      "Covered: none reported yet. Still open: goal, where, constraints, done. " +
      "Krane said, in order: (1) fix the tests (2) in jarvis. " +
      "Ask the one question that closes the biggest gap, one per turn, or propose now if the " +
      "request itself already settles what is open.",
  );
});

// ---------------------------------------------------------------------------
// cleanBrief
// ---------------------------------------------------------------------------

test("cleanBrief keeps line breaks and collapses horizontal whitespace, including tabs, around them", () => {
  assert.equal(cleanBrief("Goal:\tx  y\nWhere: z"), "Goal: x y\nWhere: z");
});

test("cleanBrief drops a trailing space left before a newline by the horizontal collapse", () => {
  assert.equal(cleanBrief("line one   \nline two"), "line one\nline two");
});

test("cleanBrief drops carriage returns and collapses three or more newlines down to two", () => {
  assert.equal(cleanBrief("a\r\nb\n\n\n\nc"), "a\nb\n\nc");
});

test("cleanBrief strips bidi overrides and other unprintables, but leaves the newline itself alone", () => {
  const rlo = String.fromCharCode(0x202e);
  assert.equal(cleanBrief(`line one${rlo}\nline two`), "line one\nline two");
});

test("cleanBrief caps at maxChars, defaulting to MAX_BRIEF_CHARS", () => {
  const long = "x".repeat(MAX_BRIEF_CHARS * 2);
  assert.equal(cleanBrief(long).length, MAX_BRIEF_CHARS);
  assert.equal(cleanBrief(long, 10).length, 10);
});

test("cleanBrief is empty for anything that is not a string", () => {
  assert.equal(cleanBrief(undefined), "");
  assert.equal(cleanBrief(null), "");
  assert.equal(cleanBrief(42), "");
});

// ---------------------------------------------------------------------------
// composeBrief
// ---------------------------------------------------------------------------

test("a brief the model wrote wins over the task and notes, and keeps its own structure", () => {
  const brief = "Goal: fix the failing builder test\nConstraints:\n- keep it isolated";
  assert.equal(
    composeBrief({ task: "fix the tests", notes: ["it's the builder test"], brief }),
    brief,
  );
});

test("with no brief, the task, repo, notes and what was said become a structured document", () => {
  const result = composeBrief({
    task: "fix the tests",
    repo: "jarvis",
    notes: ["it's the builder test", "only that one file"],
    said: ["fix the failing tests", "in jarvis, the builder test only"],
  });
  assert.equal(
    result,
    [
      "Goal: fix the tests",
      "Where: jarvis",
      "What the interview established:",
      "- it's the builder test.",
      "- only that one file.",
      "Krane said, in order:",
      "- fix the failing tests",
      "- in jarvis, the builder test only",
    ].join("\n"),
  );
  // A note that already ends its own sentence keeps its own punctuation.
  assert.equal(
    composeBrief({ task: "fix the tests", notes: ["is it the builder test?"] }),
    "Goal: fix the tests\nWhat the interview established:\n- is it the builder test?",
  );
});

test("with only a task, the fallback is a single Goal line", () => {
  assert.equal(composeBrief({ task: "fix the tests" }), "Goal: fix the tests");
  assert.equal(composeBrief({ task: "fix the tests", notes: [] }), "Goal: fix the tests");
});

test("with a repo but no notes or said, the fallback has a Where line and nothing else", () => {
  assert.equal(
    composeBrief({ task: "fix the tests", repo: "jarvis" }),
    "Goal: fix the tests\nWhere: jarvis",
  );
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

test("a note handed straight to composeBrief is cleaned like everything else", () => {
  const rlo = String.fromCharCode(0x202e);
  const result = composeBrief({ task: "build something", notes: [`line 1\nline 2${rlo}`] });
  // The newline inside the note collapses to a space (notes are cleaned with
  // clean, not cleanBrief -- a note is a single line), and the override
  // character is stripped.
  assert.ok(result.includes("- line 1 line 2."), `result: ${result}`);
  assert.equal(result.includes(rlo), false);
});

test("what was said is cleaned the same way, and an empty one is dropped", () => {
  const result = composeBrief({ task: "build something", said: ["  spaced out  ", ""] });
  assert.equal(result, "Goal: build something\nKrane said, in order:\n- spaced out");
});
