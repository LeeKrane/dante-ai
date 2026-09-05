import test from "node:test";
import assert from "node:assert/strict";

import { isListed, startVerdict, stopVerdict, tellVerdict } from "../lib/verdict.js";

const roster = [{ sessionId: "aaa", name: "bug-hunt" }, { sessionId: "bbb", name: "docs" }];

// ---------------------------------------------------------------------------
// isListed
// ---------------------------------------------------------------------------

test("a session on the roster is listed and one that is not is not", () => {
  assert.equal(isListed(roster, "aaa"), true);
  assert.equal(isListed(roster, "ccc"), false);
});

test("no roster at all is neither listed nor absent", () => {
  // "I could not check" must not read as "it is gone".
  assert.equal(isListed(null, "aaa"), null);
  assert.equal(isListed(undefined, "aaa"), null);
});

test("a missing session id is never listed", () => {
  assert.equal(isListed(roster, ""), false);
  assert.equal(isListed(roster, undefined), false);
});

// ---------------------------------------------------------------------------
// stopVerdict
// ---------------------------------------------------------------------------

test("a stop is only said to have stopped once the roster no longer lists it", () => {
  const verdict = stopVerdict({ name: "bug-hunt", result: { ok: true }, listed: false });
  assert.deepEqual(verdict, { spoken: "bug-hunt is stopped, sir.", stopped: true });
});

test("a session still on the roster after the signal is reported as sent, not stopped", () => {
  // The failure this module exists for: the pid went away, the session did not.
  const verdict = stopVerdict({ name: "bug-hunt", result: { ok: true }, listed: true });
  assert.equal(verdict.stopped, false);
  assert.match(verdict.spoken, /^The stop went to bug-hunt, sir, but it is still on the roster\.$/);
});

test("a process that was already gone but a session still listed says both", () => {
  const verdict = stopVerdict({ name: "bug-hunt", result: { ok: true, alreadyGone: true }, listed: true });
  assert.equal(verdict.stopped, false);
  assert.match(verdict.spoken, /already gone.*still on the roster/);
});

test("a stop whose roster check failed says it could not check rather than either outcome", () => {
  const verdict = stopVerdict({ name: "bug-hunt", result: { ok: true }, listed: null });
  assert.equal(verdict.stopped, false);
  assert.match(verdict.spoken, /could not check/);
  assert.doesNotMatch(verdict.spoken, /is stopped/);
});

test("a session that had already finished is reported as finished once the roster agrees", () => {
  const verdict = stopVerdict({ name: "bug-hunt", result: { ok: true, alreadyGone: true }, listed: false });
  assert.deepEqual(verdict, { spoken: "bug-hunt had already finished, sir.", stopped: true });
});

test("a failed stop carries the reason and stops nothing", () => {
  const verdict = stopVerdict({ name: "bug-hunt", result: { ok: false, error: "it is still running" }, listed: false });
  assert.deepEqual(verdict, { spoken: "I could not stop bug-hunt, sir. it is still running.", stopped: false });
});

test("a failed stop with no reason still ends the sentence cleanly", () => {
  const verdict = stopVerdict({ name: "bug-hunt", result: { ok: false } });
  assert.equal(verdict.spoken, "I could not stop bug-hunt, sir.");
});

test("a stop verdict with no result at all is a failure, never a success", () => {
  assert.equal(stopVerdict({ name: "bug-hunt" }).stopped, false);
  assert.equal(stopVerdict().stopped, false);
});

// ---------------------------------------------------------------------------
// tellVerdict
// ---------------------------------------------------------------------------

test("a message over the peer channel is reported as sent, with the gap named", () => {
  // Nothing acknowledges a user frame, so "has it" was a claim. Whatever the
  // sentence says, it must not say the session has, read or is acting on it.
  const spoken = tellVerdict({ name: "bug-hunt", verb: "tell", channel: "peer" });
  assert.equal(spoken, "Sent to bug-hunt, sir. I cannot confirm it was read.");
});

test("an interrupt over the peer channel is reported as sent, not as interrupted", () => {
  const spoken = tellVerdict({ name: "bug-hunt", verb: "interrupt", channel: "peer" });
  assert.equal(spoken, "Interrupt sent to bug-hunt, sir. I cannot confirm it was read.");
  assert.doesNotMatch(spoken, /is interrupted/);
});

test("a queued message says it is waiting rather than that it went", () => {
  const spoken = tellVerdict({ name: "bug-hunt", verb: "tell", channel: "queued" });
  assert.equal(spoken, "bug-hunt is busy, sir. I will pass it on when it stops.");
});

test("a resumed session's own reply is the confirmation", () => {
  assert.equal(tellVerdict({ name: "bug-hunt", channel: "resume", reply: "  Done, tests pass. " }), "Done, tests pass.");
});

test("a resumed session that said nothing back is reported as having run silently", () => {
  assert.equal(tellVerdict({ name: "bug-hunt", channel: "resume", reply: "" }), "bug-hunt took it, sir, and said nothing back.");
});

test("no tell verdict ever says a session has it", () => {
  for (const channel of ["peer", "queued", "resume"]) {
    for (const verb of ["tell", "interrupt"]) {
      assert.doesNotMatch(tellVerdict({ name: "x", verb, channel }), /has it/, `${verb}/${channel}`);
    }
  }
});

// ---------------------------------------------------------------------------
// startVerdict
// ---------------------------------------------------------------------------

test("a started session the roster lists is running under its name", () => {
  assert.equal(startVerdict({ name: "bug-hunt", listed: true }), "Running as bug-hunt.");
});

test("a started session the roster does not list yet is started, not running", () => {
  const spoken = startVerdict({ name: "bug-hunt", listed: false });
  assert.match(spoken, /^Started as bug-hunt, sir\./);
  assert.doesNotMatch(spoken, /Running/);
});

test("a started session whose roster check failed says so", () => {
  assert.match(startVerdict({ name: "bug-hunt", listed: null }), /could not check the roster/);
});

test("a verdict with no name still names something", () => {
  assert.match(stopVerdict({ result: { ok: true }, listed: false }).spoken, /^that session is stopped/);
  assert.match(tellVerdict({ channel: "peer" }), /^Sent to that session/);
  assert.match(startVerdict({ listed: true }), /^Running as that session/);
});

test("an ordinary start, with nothing overridden, never mentions a command", () => {
  assert.equal(startVerdict({ name: "bug-hunt", listed: true }), "Running as bug-hunt.");
  assert.doesNotMatch(startVerdict({ name: "bug-hunt", listed: true, overriddenKind: null }), /command/);
});

test("a command that replaced a kind's own prompt is named out loud, not just logged", () => {
  const spoken = startVerdict({ name: "bug-hunt", listed: true, overriddenKind: "brainstorm" });
  assert.equal(spoken, "Running as bug-hunt, the command replaced the brainstorm prompt.");
});

test("the override clause reads as one sentence regardless of which roster branch reported", () => {
  assert.equal(
    startVerdict({ name: "bug-hunt", listed: false, overriddenKind: "brainstorm" }),
    "Started as bug-hunt, sir. It is not on the roster yet, the command replaced the brainstorm prompt.",
  );
  assert.equal(
    startVerdict({ name: "bug-hunt", listed: null, overriddenKind: "brainstorm" }),
    "Started as bug-hunt, sir, but I could not check the roster, the command replaced the brainstorm prompt.",
  );
});
