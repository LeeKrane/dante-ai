import test from "node:test";
import assert from "node:assert/strict";
import { MAX_UNANSWERED, createTurnGate, mergeTurns } from "../lib/turns.js";

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
