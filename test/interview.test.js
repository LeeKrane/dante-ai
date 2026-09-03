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
  holdForReadBack,
  markProceed,
  matches,
  noteInterview,
  parseBrief,
  readBack,
  readyToPropose,
  stripInterviewPreamble,
  unconfirmedFacets,
  wantsToProceed,
  withdrawConfirming,
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
    name: "",
    notes: ["wants the tests fixed"],
    said: ["fix the failing tests in jarvis"],
    covered: ["goal", "where"],
    confirming: [],
    confirmed: [],
    asked: 1,
    at: 1000,
    proceed: false,
    spokenFor: false,
    withdrawn: false,
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
    name: "",
    notes: ["first note", "second note"],
    said: ["first thing said", "second thing said"],
    covered: ["goal", "where", "constraints"],
    confirming: [],
    confirmed: [],
    asked: 2,
    at: 2000,
    proceed: false,
    spokenFor: false,
    withdrawn: false,
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
    name: "",
    notes: ["new note"],
    said: ["new ask"],
    covered: ["where"],
    confirming: [],
    confirmed: [],
    asked: 1,
    at: now,
    proceed: false,
    spokenFor: false,
    withdrawn: false,
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
  // comma because the whole value is inside quotes, and parseFacets's own
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

test("an interview about one session does not match a tag about another, and the name carries forward like the repo", () => {
  const state = noteInterview(null, { verb: "interview", for: "tell", name: "fix-tests" }, 1000);
  assert.equal(state.name, "fix-tests");
  assert.equal(matches(state, { verb: "tell", name: "fix-tests" }), true);
  assert.equal(matches(state, { verb: "tell", name: "build-ui" }), false);
  // A tag with no name, or an interview that never learned one, still matches.
  assert.equal(matches(state, { verb: "tell" }), true);
  assert.equal(matches(noteInterview(null, { verb: "interview", for: "tell" }, 1000), { verb: "tell", name: "build-ui" }), true);
  assert.equal(noteInterview(state, { verb: "interview" }, 2000).name, "fix-tests");
});

test("a start, tell or interrupt is held for a read-back until Krane says to proceed, and a skill never is", () => {
  assert.equal(holdForReadBack({ verb: "start" }, null), true);
  assert.equal(holdForReadBack({ verb: "tell", name: "fix-tests" }, null), true);
  assert.equal(holdForReadBack({ verb: "INTERRUPT" }, null), true);
  assert.equal(holdForReadBack({ verb: "stop" }, null), false);
  assert.equal(holdForReadBack({ verb: "read" }, null), false);
  assert.equal(holdForReadBack({ verb: "start", command: "/grilling" }, null), false);
  assert.equal(holdForReadBack({ verb: "start", command: "   " }, null), true);

  // Every facet read back -- even all four at once, the way the machine's
  // own synthetic tag would leave a state -- still does not skip the hold.
  // That used to be the seam a model-written read-back got through, so now
  // it holds all the same, and only proceed gets past it.
  const fullyConfirming = noteInterview(null, { verb: "interview", for: "start", confirming: "goal,where,constraints,done" }, 1000);
  assert.equal(holdForReadBack({ verb: "start" }, fullyConfirming, 1000), true);
  const partial = noteInterview(null, { verb: "interview", for: "start", confirming: "goal" }, 1000);
  assert.equal(holdForReadBack({ verb: "start" }, partial, 1000), true);
  // Krane's escape phrase reaches this through markProceed, nothing else.
  assert.equal(holdForReadBack({ verb: "start" }, markProceed(partial), 1000), false);
  assert.equal(holdForReadBack({ verb: "start" }, markProceed(fullyConfirming), 1000), false);
});

test("withdrawing the read-back puts its facets back to unconfirmed and leaves the rest alone", () => {
  const state = noteInterview(null, { verb: "interview", for: "start", repo: "jarvis", confirmed: "goal", confirming: "where,constraints,done" }, 1000);
  const withdrawn = withdrawConfirming(state);
  assert.deepEqual(withdrawn, { ...state, confirming: [], withdrawn: true });
  assert.deepEqual(unconfirmedFacets(withdrawn), ["where", "constraints", "done"]);
  assert.equal(readyToPropose(withdrawn, 1000), false);
  assert.equal(withdrawConfirming(null), null);
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

// A hand-built state for the block tests, with the confirmation lists defaulting
// to empty so a test about coverage does not have to spell them out.
function stateOf(fields) {
  return {
    name: "", notes: [], said: [], confirming: [], confirmed: [],
    proceed: false, spokenFor: false, withdrawn: false, ...fields,
  };
}

const ASK_FOR_GAP =
  "Ask the one question that closes the biggest gap, one per turn. A facet the request " +
  "itself settles is read back for a yes, never re-asked and never skipped.";

test("the block reports nothing covered yet and asks for the biggest gap", () => {
  const state = stateOf({ verb: "start", repo: "", covered: [], asked: 1, at: 1000 });
  assert.equal(
    interviewBlock(state, 1000),
    "INTERVIEW in progress: planning a start. 1 question asked. " +
      "Covered: none reported yet. Still open: goal, where, constraints, done. " +
      ASK_FOR_GAP,
  );
});

test("the block says every facet is covered and tells it to propose, never to write a read-back of its own", () => {
  const state = stateOf({
    verb: "start", repo: "jarvis", notes: ["n1", "n2"],
    covered: ["goal", "where", "constraints", "done"], asked: 2, at: 2000,
  });
  assert.equal(
    interviewBlock(state, 2000),
    "INTERVIEW in progress: planning a start in jarvis. 2 questions asked. " +
      "Covered: goal, where, constraints, done. Still open: nothing. " +
      "Learned so far: n1; n2. " +
      "Every facet is covered: propose now with the start tag carrying task= and brief=; the brief is " +
      "read back to Krane for you before anything is proposed, so never write a read-back of your " +
      "own; unless an answer left something genuinely open, then ask about that one thing only.",
  );
});

test("a tell or interrupt is held to the same rule as a start, and its tail names its own verb", () => {
  const covered = stateOf({
    verb: "tell", repo: "jarvis", covered: ["goal", "where", "constraints", "done"], asked: 2, at: 2000,
  });
  assert.match(interviewBlock(covered, 2000), /Every facet is covered: propose now with the tell tag carrying task= and brief=;/);

  const awaiting = stateOf({
    verb: "interrupt", repo: "jarvis", covered: ["goal", "where", "constraints", "done"],
    confirming: ["goal", "where", "constraints", "done"], asked: 1, at: 2000,
  });
  assert.match(interviewBlock(awaiting, 2000), /propose now with the interrupt tag\.$/);
});

test("the block names the facets read back and says the answer to them comes next", () => {
  const state = stateOf({
    verb: "start", repo: "jarvis", covered: ["goal", "where", "constraints", "done"],
    confirmed: ["goal", "where"], confirming: ["constraints", "done"], asked: 3, at: 2000,
  });
  assert.equal(
    interviewBlock(state, 2000),
    "INTERVIEW in progress: planning a start in jarvis. 3 questions asked. " +
      "Covered: goal, where, constraints, done. Still open: nothing. Confirmed: goal, where. " +
      "Awaiting a yes on: constraints, done. " +
      "Krane's answer to that read-back follows: fold a correction in, otherwise propose now with the start tag.",
  );
});

test("the block says when the read-back was the machine's, not the model's", () => {
  const state = stateOf({
    verb: "start", repo: "jarvis", covered: ["goal", "where", "constraints", "done"],
    confirming: ["goal", "where", "constraints", "done"], asked: 1, at: 2000, spokenFor: true,
  });
  assert.match(interviewBlock(state, 2000), /The read-back was spoken for you, from your brief\. Krane's answer/);
});

test("a withdrawn state -- the machine's read-back answered no or corrected -- produces the loop-back tail", () => {
  // withdrawn is the explicit signal withdrawConfirming sets: what Krane
  // says next is a correction to a read-back the machine spoke, not an
  // answer to whatever the model itself last asked.
  const state = stateOf({
    verb: "start", repo: "jarvis", covered: ["goal", "where", "constraints", "done"],
    confirmed: [], confirming: [], asked: 2, at: 2000, spokenFor: true, withdrawn: true,
  });
  assert.equal(
    interviewBlock(state, 2000),
    "INTERVIEW in progress: planning a start in jarvis. 2 questions asked. " +
      "Covered: goal, where, constraints, done. Still open: nothing. " +
      "Your brief was read back to Krane by the machine, and he said no or corrected it. What he " +
      "says now is the correction: fold it in, and if it leaves a facet open, ask about that one " +
      "thing only, one question. If instead he dropped it, say so and propose nothing. Otherwise " +
      "propose again with the corrected task and brief, which will be read back once more.",
  );
});

test("the block says every facet is confirmed and, same as covered, tells it to propose rather than read anything back", () => {
  const state = stateOf({
    verb: "start", repo: "jarvis", covered: ["goal", "where", "constraints", "done"],
    confirmed: ["goal", "where", "constraints", "done"], asked: 2, at: 2000,
  });
  assert.equal(
    interviewBlock(state, 2000),
    "INTERVIEW in progress: planning a start in jarvis. 2 questions asked. " +
      "Covered: goal, where, constraints, done. Still open: nothing. " +
      "Confirmed: goal, where, constraints, done. " +
      "Every facet is covered: propose now with the start tag carrying task= and brief=; the brief is " +
      "read back to Krane for you before anything is proposed, so never write a read-back of your " +
      "own; unless an answer left something genuinely open, then ask about that one thing only.",
  );
});

test("the block names both the covered facets and the open ones", () => {
  const state = stateOf({ verb: "start", repo: "jarvis", covered: ["goal", "where"], asked: 2, at: 2000 });
  assert.equal(
    interviewBlock(state, 2000),
    "INTERVIEW in progress: planning a start in jarvis. 2 questions asked. " +
      "Covered: goal, where. Still open: constraints, done. " +
      ASK_FOR_GAP,
  );
});

test("a proceed beats the facet coverage no matter how much is still open", () => {
  const state = stateOf({ verb: "start", repo: "jarvis", covered: ["goal"], asked: 3, at: 1000 });
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
  const state = stateOf({
    verb: "start", repo: "jarvis", said: ["fix the tests", "in jarvis"], covered: [], asked: 2, at: 1000,
  });
  assert.equal(
    interviewBlock(state, 1000),
    "INTERVIEW in progress: planning a start in jarvis. 2 questions asked. " +
      "Covered: none reported yet. Still open: goal, where, constraints, done. " +
      "Krane said, in order: (1) fix the tests (2) in jarvis. " +
      ASK_FOR_GAP,
  );
});

// ---------------------------------------------------------------------------
// confirming= / confirmed= / readyToPropose
// ---------------------------------------------------------------------------

test("confirming= names this question's facets only, and is gone from the next tag that omits it", () => {
  const first = noteInterview(null, { verb: "interview", for: "start", confirming: "goal,where" }, 1000);
  assert.deepEqual(first.confirming, ["goal", "where"]);
  const second = noteInterview(first, { verb: "interview", note: "an ordinary question" }, 2000);
  assert.deepEqual(second.confirming, []);
});

test("confirmed= carries forward when omitted and resets when present but empty, like have=", () => {
  const first = noteInterview(null, { verb: "interview", for: "start", confirmed: "goal" }, 1000);
  assert.deepEqual(first.confirmed, ["goal"]);
  const silent = noteInterview(first, { verb: "interview" }, 2000);
  assert.deepEqual(silent.confirmed, ["goal"]);
  const cleared = noteInterview(silent, { verb: "interview", confirmed: "" }, 3000);
  assert.deepEqual(cleared.confirmed, []);
});

test("a facet being read back, or confirmed, counts as covered whether or not have= said so", () => {
  const state = noteInterview(null, { verb: "interview", for: "start", have: "goal", confirming: "done", confirmed: "constraints" }, 1000);
  assert.deepEqual(state.covered, ["goal", "constraints", "done"]);
});

test("a real tag, parsed end to end, carries confirming= and confirmed= the same way it carries have=", () => {
  const tag = parseAction(
    'So, the builder test only - have I got that right? [ACTION:SESSION verb=interview for=start repo=jarvis have=goal,where confirming=constraints,done confirmed=goal note="only the builder test"]',
  ).session;
  const state = noteInterview(null, tag, 1000);
  assert.deepEqual(state.confirming, ["constraints", "done"]);
  assert.deepEqual(state.confirmed, ["goal"]);
  assert.deepEqual(state.covered, ["goal", "where", "constraints", "done"]);
});

test("a start is ready to propose only once Krane has said to proceed -- covered, confirmed or read back are none of them enough on their own", () => {
  assert.equal(readyToPropose(null, 1000), false);
  assert.deepEqual(unconfirmedFacets(null), ["goal", "where", "constraints", "done"]);

  const partial = noteInterview(null, { verb: "interview", for: "start", repo: "jarvis", have: "goal,where,constraints,done", confirming: "goal" }, 1000);
  assert.equal(readyToPropose(partial, 1000), false);
  assert.deepEqual(unconfirmedFacets(partial), ["where", "constraints", "done"]);

  // Covered is not confirmed: all four known, none read back.
  const covered = noteInterview(null, { verb: "interview", for: "start", repo: "jarvis", have: "goal,where,constraints,done" }, 1000);
  assert.equal(readyToPropose(covered, 1000), false);

  // Every facet read back, even all four at once -- this is what the
  // machine's own synthetic tag leaves behind -- is still not ready by
  // itself. That used to be the rule, and it was the seam a model-written
  // read-back (whole or partial) could get through instead of the machine's;
  // now nothing short of Krane's own proceed does.
  const readBackAll = noteInterview(null, { verb: "interview", for: "start", confirming: "goal,where,constraints,done" }, 1000);
  assert.equal(readyToPropose(readBackAll, 1000), false);

  // Nor is every facet confirmed, for the same reason.
  const confirmedAll = noteInterview(readBackAll, { verb: "interview", confirmed: "goal,where,constraints,done" }, 2000);
  assert.equal(readyToPropose(confirmedAll, 2000), false);

  // Only proceed does -- live, and gone once the interview has gone stale.
  assert.equal(readyToPropose(markProceed(partial), 1000), true);
  assert.equal(readyToPropose(markProceed(confirmedAll), 2000), true);
  assert.equal(readyToPropose(markProceed(confirmedAll), 2000 + INTERVIEW_TTL_MS), false);
});

test("the machine's own read-back tag marks the state as spoken for, but that alone still is not ready to propose", () => {
  const held = noteInterview(null, { for: "start", repo: "jarvis", confirming: "goal,where,constraints,done", spokenFor: true }, 1000, "fix the tests");
  assert.equal(held.spokenFor, true);
  assert.equal(held.verb, "start");
  // spokenFor says whose question this was, not whether Krane has answered
  // it -- readyToPropose reads only proceed, and Krane has not said that.
  assert.equal(readyToPropose(held, 1000), false);
  const next = noteInterview(held, { verb: "interview", confirmed: "goal,where", confirming: "constraints" }, 2000, "no, the other test");
  assert.equal(next.spokenFor, false);
});

// ---------------------------------------------------------------------------
// parseBrief / readBack
// ---------------------------------------------------------------------------

const DOC_BRIEF = [
  "Goal: fix the flaky builder test",
  "Where: jarvis, test/builder.test.js",
  "Constraints:",
  "- do not touch lib/builder.js itself, only the test",
  "- keep using the existing writeFake fixture, don't add a new one",
  "Done when:",
  "- npm test passes twice in a row",
  "Also:",
  "- Krane wants to know which assertion was racing, in the summary",
].join("\n");

test("parseBrief reads the documented shape back into its sections", () => {
  assert.deepEqual(parseBrief(DOC_BRIEF), {
    goal: "fix the flaky builder test",
    where: "jarvis, test/builder.test.js",
    constraints: [
      "do not touch lib/builder.js itself, only the test",
      "keep using the existing writeFake fixture, don't add a new one",
    ],
    done: ["npm test passes twice in a row"],
    also: ["Krane wants to know which assertion was racing, in the summary"],
  });
});

test("parseBrief reads a label the model dressed up as markdown, because the read-back must not deny what the brief said", () => {
  const brief = "## Goal\nfix login\n**Where:** jarvis\n__Constraints__:\n- only touch auth.js\n* Done when: tests pass";
  assert.deepEqual(parseBrief(brief), {
    goal: "fix login", where: "jarvis", constraints: ["only touch auth.js"], done: ["tests pass"], also: [],
  });
  assert.match(readBack({ verb: "start", task: "fix login", brief }, FACETS), /constraints: only touch auth.js, done when tests pass\./);
});

test("parseBrief tolerates a missing section, text on the label's own line, and no brief at all", () => {
  assert.deepEqual(parseBrief("Goal: run the tests\nConstraints: none\nDone: green"), {
    goal: "run the tests", where: "", constraints: ["none"], done: ["green"], also: [],
  });
  assert.deepEqual(parseBrief(undefined), { goal: "", where: "", constraints: [], done: [], also: [] });
  // Lines before any label belong to nothing and are dropped rather than
  // guessed into a section.
  assert.deepEqual(parseBrief("just some text\nGoal: x").goal, "x");
});

test("readBack names every facet it is given, from the brief, as one question", () => {
  assert.equal(
    readBack({ task: "fix tests", repo: "jarvis", brief: DOC_BRIEF }, FACETS),
    "Before I propose, sir, let me check I have this right: the goal is fix the flaky builder test, " +
      "in jarvis, test/builder.test.js, " +
      "constraints: do not touch lib/builder.js itself, only the test; keep using the existing writeFake fixture, don't add a new one, " +
      "done when npm test passes twice in a row. Have I got that right?",
  );
});

test("readBack names only the facets it is given, so a second read-back covers the corrected one alone", () => {
  assert.equal(
    readBack({ task: "fix tests", repo: "jarvis", brief: DOC_BRIEF }, ["done"]),
    "Before I propose, sir, let me check I have this right: done when npm test passes twice in a row. Have I got that right?",
  );
  assert.equal(readBack({ task: "fix tests", brief: DOC_BRIEF }, []), "");
  assert.equal(readBack({ task: "fix tests", brief: DOC_BRIEF }, ["nonsense"]), "");
});

test("readBack falls back to the task and repo when there is no brief, and asks a silent facet as the assumption it amounts to", () => {
  assert.equal(
    readBack({ task: "fix the tests.", repo: "jarvis" }, FACETS),
    "Before I propose, sir, let me check I have this right: the goal is fix the tests, in jarvis. " +
      "And nothing was said about constraints, so I would take it there are none, " +
      "and nothing was said about what done looks like, so I would take the goal itself as the test. " +
      "Have I got that right?",
  );
  // Nothing at all known about a facet is still a question about that facet.
  assert.equal(
    readBack({ task: "fix the tests" }, ["where"]),
    "Before I propose, sir, nothing was said about where, so I would use the main repository. Have I got that right?",
  );
});

test("readBack for a tell or interrupt names the session rather than a repository, and says what it would tell it", () => {
  assert.equal(
    readBack({ verb: "tell", name: "fix-tests", task: "run the linter as well" }, FACETS),
    "Before I propose, sir, let me check I have this right: I would tell it to run the linter as well, " +
      "the session is fix-tests. " +
      "And nothing was said about constraints, so I would take it there are none, " +
      "and nothing was said about what done looks like, so I would take the goal itself as the test. " +
      "Have I got that right?",
  );
  assert.equal(
    readBack({ verb: "interrupt", name: "fix-tests", task: "use the other branch", brief: "Goal: use the other branch\nDone when:\n- the tests run there" }, ["goal", "done"]),
    "Before I propose, sir, let me check I have this right: I would interrupt it to use the other branch, " +
      "done when the tests run there. Have I got that right?",
  );
  // The session's name outranks the brief's Where line for these two verbs,
  // and with neither a name nor a repo the facet is asked as its assumption.
  assert.match(readBack({ verb: "tell", name: "fix-tests", brief: "Where: jarvis, lib/" }, ["where"]), /the session is fix-tests\./);
  assert.match(readBack({ verb: "tell" }, ["where"]), /nothing was said about which session\. Have I got that right\?$/);
});

test("readBack strips unprintables and caps each clause, because a model wrote the brief", () => {
  const rlo = String.fromCharCode(0x202e);
  const spoken = readBack({ task: `fix${rlo} the tests`, brief: `Goal: ${"x".repeat(400)}` }, ["goal"]);
  assert.equal(spoken.includes(rlo), false);
  assert.ok(spoken.length < 260, spoken.length);
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
// stripInterviewPreamble
// ---------------------------------------------------------------------------

test("a leading announcement of the interview is dropped and the questions behind it are kept verbatim", () => {
  const reply =
    'Before I interview, sir: should repos be lettered A, B, C or should they follow repository names? ' +
    "And should numbering persist across restarts or reset each session?";
  assert.equal(
    stripInterviewPreamble(reply),
    "should repos be lettered A, B, C or should they follow repository names? " +
      "And should numbering persist across restarts or reset each session?",
  );
});

test("a reply that is only the announcement becomes nothing to speak", () => {
  assert.equal(stripInterviewPreamble("Before I interview, sir:"), "");
});

test("a plain question is returned unchanged", () => {
  assert.equal(stripInterviewPreamble("What is the goal, sir?"), "What is the goal, sir?");
});

test("a lead-in that does not mention the interview is left alone", () => {
  const reply = "Before I ask, sir, one thing: is this the main repository?";
  assert.equal(stripInterviewPreamble(reply), reply);
});

test("a clause with a question mark before the colon is left alone", () => {
  const reply = "Really, before I interview, sir? one moment: is this the main repository?";
  assert.equal(stripInterviewPreamble(reply), reply);
});

test("a clause of exactly eighty characters is stripped", () => {
  const clause = `Before I interview you, sir, at needlessly great length about this ${"x".repeat(13)}`;
  assert.equal(clause.length, 80, "the clause under test must be exactly eighty characters");
  const reply = `${clause}: is this the main repository?`;
  assert.equal(stripInterviewPreamble(reply), "is this the main repository?");
});

test("a clause of eighty-one characters is left alone", () => {
  const clause = `Before I interview you, sir, at needlessly great length about this ${"x".repeat(14)}`;
  assert.equal(clause.length, 81, "the clause under test must be exactly eighty-one characters");
  const reply = `${clause}: is this the main repository?`;
  assert.equal(stripInterviewPreamble(reply), reply);
});

test("a colon inside the question itself is not where the strip stops", () => {
  const reply = "Before I interview, sir: which repo: jarvis or dante?";
  assert.equal(stripInterviewPreamble(reply), "which repo: jarvis or dante?");
});

test("a real question that names the interview and uses a colon list is left alone", () => {
  const reply = "Which interview style: short or long?";
  assert.equal(stripInterviewPreamble(reply), reply);
});

test("a read-back opener that never mentions the interview is left alone", () => {
  // lib/interview.js's own readBack() opens with "Before I propose, sir, let
  // me check I have this right: ..." -- a colon-terminated leading clause,
  // same shape as the bug, but it never says "interview" so it is untouched
  // for that reason alone.
  const reply = "Before I propose, sir, let me check I have this right: is this the main repository?";
  assert.equal(stripInterviewPreamble(reply), reply);
});

test("a non-string reply is nothing to speak", () => {
  assert.equal(stripInterviewPreamble(undefined), "");
  assert.equal(stripInterviewPreamble(null), "");
  assert.equal(stripInterviewPreamble(42), "");
});

test("a lower-case interviewing announcement is dropped too", () => {
  assert.equal(stripInterviewPreamble("before I start interviewing, sir: what is the goal?"), "what is the goal?");
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
