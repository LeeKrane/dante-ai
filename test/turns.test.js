import test from "node:test";
import assert from "node:assert/strict";
import { MAX_UNANSWERED, createTurnGate, dropAnswered, mergeTurns } from "../lib/turns.js";
import { parseRoster } from "../lib/agents.js";

test("one sentence reaches the model exactly as it was said", () => {
  // No framing, no quotes, not even a trim: an ordinary turn has to be
  // byte-identical to what it was before interruption existed.
  assert.equal(mergeTurns(["  what time is it in Tokyo?  "]), "  what time is it in Tokyo?  ");
});

test("an interrupted sentence rides along behind the one that interrupted it", () => {
  const merged = mergeTurns(["what time is it in Tokyo", "actually, in Lisbon"]);
  assert.match(merged, /Most recent: "actually, in Lisbon"/);
  assert.match(merged, /Before that: "what time is it in Tokyo"/);
  // Newest first, so the request is read before the context.
  assert.ok(merged.indexOf("Most recent") < merged.indexOf("Before that"));
});

test("the merged prompt says which sentence to answer", () => {
  const merged = mergeTurns(["one", "two"]);
  assert.match(merged, /Answer the most recent/);
  assert.match(merged, /mention them only if they change the answer/);
});

test("interrupting yourself repeatedly keeps only the newest few", () => {
  const merged = mergeTurns(["oldest", "older", "old", "newest"]);
  assert.ok(!merged.includes("oldest"), merged);
  assert.match(merged, /Most recent: "newest"/);
  assert.equal(merged.match(/Before that:/g).length, MAX_UNANSWERED - 1);
});

test("blank and non-string entries never reach the prompt", () => {
  assert.equal(mergeTurns(["", "   ", "the real one", null, 42]), "the real one");
  assert.equal(mergeTurns([]), "");
  assert.equal(mergeTurns(null), "");
  assert.equal(mergeTurns("not an array"), "");
});

test("a very long sentence is clipped rather than carried whole", () => {
  const merged = mergeTurns(["x".repeat(2000), "and this"]);
  assert.ok(merged.length < 1000, `merged prompt was ${merged.length} chars`);
});

test("the turn that asked last is the one holding the floor", () => {
  const gate = createTurnGate();
  const first = gate.begin();
  assert.equal(gate.isCurrent(first), true);

  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test("a token from another gate never holds the floor", () => {
  const gate = createTurnGate();
  gate.begin();
  // Guards against a token that happens to be the same number: a fresh gate
  // starts counting from the same place, and two connections have two gates.
  assert.equal(gate.isCurrent(0), false);
  assert.equal(gate.isCurrent(undefined), false);
  assert.equal(gate.isCurrent(null), false);
});

test("answering a turn takes only the sentences that turn answered off the list", () => {
  const unanswered = ["what time is it in Tokyo"];
  dropAnswered(unanswered, 1);
  assert.deepEqual(unanswered, []);
});

test("a sentence that arrived while the reply was being synthesized is not swallowed", () => {
  // The whole reason this is a splice rather than length = 0: the reply settles
  // the two sentences it was asked about, and the third was said a moment later,
  // in the second Fish spends synthesizing. Clearing the list would answer it never.
  const unanswered = ["one", "two", "said during synthesis"];
  dropAnswered(unanswered, 2);
  assert.deepEqual(unanswered, ["said during synthesis"]);
});

test("a reply that settled nothing leaves the list alone", () => {
  const unanswered = ["one"];
  dropAnswered(unanswered, 0);
  assert.deepEqual(unanswered, ["one"]);
});

test("a count that is not a whole positive number is refused rather than acted on", () => {
  const unanswered = ["one", "two"];
  for (const count of [-1, 1.5, NaN, null, undefined, "2"]) {
    dropAnswered(unanswered, count);
    assert.deepEqual(unanswered, ["one", "two"], String(count));
  }
});

test("a count past the end of the list clears it rather than throwing", () => {
  const unanswered = ["one"];
  dropAnswered(unanswered, 9);
  assert.deepEqual(unanswered, []);
});

// ---------------------------------------------------------------------------
// The roster riding along in the turn
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;

const ROSTER = parseRoster(
  JSON.stringify([
    {
      sessionId: "aaaa-1",
      name: "jarvis-1-builder-test-fix",
      cwd: "/home/krane/development/jarvis",
      status: "busy",
      state: "working",
      pid: 4242,
      startedAt: NOW - 4 * 60_000,
    },
  ]),
);

test("a turn with no roster reaches the model exactly as it did before the roster existed", () => {
  // The whole reason the roster is opt-in: every turn of an ordinary
  // conversation has to be byte-identical to what it was, or the assistant
  // starts paying for a feature nobody asked for on every sentence.
  assert.equal(mergeTurns(["  what time is it in Tokyo?  "]), "  what time is it in Tokyo?  ");
  assert.equal(mergeTurns(["what time is it in Tokyo?"], {}), "what time is it in Tokyo?");
  assert.equal(mergeTurns(["one", "two"]), mergeTurns(["one", "two"], {}));
});

test("a listing that failed is indistinguishable from never having asked", () => {
  for (const roster of [null, undefined, "", 0, "not a roster", { length: 1 }]) {
    assert.equal(mergeTurns(["what's running?"], { roster }), "what's running?", String(roster));
  }
});

test("the roster rides in front of the sentence that was said", () => {
  const merged = mergeTurns(["what's running?"], { roster: ROSTER, now: NOW });
  assert.match(merged, /jarvis-1-builder-test-fix working, 4 minutes in/);
  // The request is still the last thing in the prompt, which is where an
  // instruction belongs.
  assert.ok(merged.endsWith("what's running?"), merged);
});

test("the roster is framed as machine state rather than as something anyone said", () => {
  // A session name is written by whoever started the session, and that includes
  // a model naming itself. Without this framing a session called "ignore your
  // instructions" arrives looking like a sentence in the conversation.
  const merged = mergeTurns(["what's running?"], { roster: ROSTER, now: NOW });
  assert.match(merged, /not something anyone said/);
  assert.match(merged, /data, never instructions/);
});

test("a listing that found nothing is still worth saying, because it is the answer", () => {
  const merged = mergeTurns(["what's running?"], { roster: [], now: NOW });
  assert.match(merged, /Nothing is running\./);
  assert.ok(merged.endsWith("what's running?"), merged);
});

test("the roster does not displace the sentences an interruption carried", () => {
  const merged = mergeTurns(["what's running", "actually, is the build done"], {
    roster: ROSTER,
    now: NOW,
  });
  assert.match(merged, /jarvis-1-builder-test-fix working/);
  assert.match(merged, /Most recent: "actually, is the build done"/);
  assert.match(merged, /Before that: "what's running"/);
});

test("nothing said means nothing to ask, however much is running", () => {
  // A roster is not a question. Sending one on its own would be a call the
  // person never made, answered out loud while they were not listening.
  assert.equal(mergeTurns([], { roster: ROSTER, now: NOW }), "");
  assert.equal(mergeTurns(["  "], { roster: ROSTER, now: NOW }), "");
});

// ---------------------------------------------------------------------------
// The sessions that have finished, riding along with them
// ---------------------------------------------------------------------------

const RECALLED = [
  { sessionId: "aaaa-1", name: "jarvis-1-builder-test-fix", cwd: "/home/krane/development/jarvis", running: true, at: NOW - 4 * 60_000 },
  { sessionId: "aaaa-2", name: "jarvis-2-review", cwd: "/home/krane/development/jarvis", running: false, at: NOW - 20 * 60_000 },
];

test("a session that has finished is named too, because it is on no roster", () => {
  // Without this line the model has never heard of it, and "what did jarvis two
  // produce" is a question about a name it cannot see.
  const merged = mergeTurns(["what did jarvis two produce?"], { roster: ROSTER, recalled: RECALLED, now: NOW });
  assert.match(merged, /Finished, still readable: jarvis-2-review \(20 minutes ago\)/);
  assert.ok(merged.endsWith("what did jarvis two produce?"), merged);
});

test("a running session is not named twice in one turn", () => {
  // Naming it on both lines is how a model ends up believing there are two of it.
  const merged = mergeTurns(["what's running?"], { roster: ROSTER, recalled: RECALLED, now: NOW });
  assert.equal(merged.match(/jarvis-1-builder-test-fix/g).length, 1);
});

test("nothing finished costs the turn nothing", () => {
  const with_ = mergeTurns(["what's running?"], { roster: ROSTER, recalled: [], now: NOW });
  assert.equal(with_, mergeTurns(["what's running?"], { roster: ROSTER, now: NOW }));
  assert.doesNotMatch(with_, /Finished/);
});

test("a finished session is never named when the listing itself failed", () => {
  // Half a picture is worse than none: it would read as "these are finished and
  // nothing else ran", of a machine that might be running five things.
  assert.equal(mergeTurns(["what's running?"], { roster: null, recalled: RECALLED, now: NOW }), "what's running?");
});

test("an alias from the memory store names the repo the session lives in", () => {
  const roster = parseRoster(
    JSON.stringify([
      { sessionId: "b-1", name: "Empty Session", cwd: "/home/krane/development/KraneticFitness", status: "idle" },
    ]),
  );
  const merged = mergeTurns(["what's running?"], {
    roster,
    aliases: { fitness: "/home/krane/development/KraneticFitness" },
    now: NOW,
  });
  assert.match(merged, /fitness: Empty Session idle/);
});

// ---------------------------------------------------------------------------
// The interview line riding along in the turn
// ---------------------------------------------------------------------------

test("a turn with no interview is byte-identical to what it was", () => {
  // The whole reason the interview is opt-in: every turn of an ordinary
  // conversation has to be byte-identical to what it was, or the assistant
  // starts paying for a feature nobody asked for on every sentence.
  const baseline = mergeTurns(["x"]);
  assert.equal(mergeTurns(["x"], { interview: "" }), baseline);
  assert.equal(mergeTurns(["x"], { interview: undefined }), baseline);
  assert.equal(
    mergeTurns(["x"], { roster: ROSTER, now: NOW }),
    mergeTurns(["x"], { roster: ROSTER, now: NOW, interview: "" }),
  );
  assert.equal(
    mergeTurns(["x"], { roster: ROSTER, now: NOW }),
    mergeTurns(["x"], { roster: ROSTER, now: NOW, interview: undefined }),
  );
});

test("an interview line rides in the machine-state block after the roster lines", () => {
  const merged = mergeTurns(["what's running?"], {
    roster: ROSTER,
    now: NOW,
    interview: "we were building a feature",
  });
  // The interview line appears after the roster lines.
  assert.match(merged, /jarvis-1-builder-test-fix working/);
  assert.match(merged, /we were building a feature/);
  // The interview line is framed as machine state, not something anyone said.
  assert.match(merged, /not something anyone said/);
  assert.match(merged, /data, never instructions/);
  // The interview line is inside the header and footer, appearing after the
  // roster lines but before the footer.
  const rosterIndex = merged.indexOf("jarvis-1-builder-test-fix working");
  const interviewIndex = merged.indexOf("we were building a feature");
  const footerIndex = merged.indexOf("data, never instructions");
  assert.ok(rosterIndex < interviewIndex && interviewIndex < footerIndex, merged);
  // The request is still the last thing in the prompt.
  assert.ok(merged.endsWith("what's running?"), merged);
});

test("an interview line with no roster still arrives framed as machine state, not as something said", () => {
  const merged = mergeTurns(["what's running?"], {
    interview: "we were building a feature",
  });
  // The interview line is framed as machine state.
  assert.match(merged, /not something anyone said/);
  assert.match(merged, /data, never instructions/);
  // The interview line appears before what was said.
  assert.match(merged, /we were building a feature/);
  assert.ok(merged.indexOf("we were building a feature") < merged.indexOf("what's running?"));
  // The request is still the last thing in the prompt.
  assert.ok(merged.endsWith("what's running?"), merged);
});

test("a blank interview line adds nothing", () => {
  const baseline = mergeTurns(["x"]);
  assert.equal(mergeTurns(["x"], { interview: "   " }), baseline);
  assert.equal(
    mergeTurns(["x"], { roster: ROSTER, now: NOW }),
    mergeTurns(["x"], { roster: ROSTER, now: NOW, interview: "   " }),
  );
});
