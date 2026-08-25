import test from "node:test";
import assert from "node:assert/strict";

import { DEDUPE_MS, MAX_DETAIL_CHARS, createDeduper, isLoopback, parseHookEvent } from "../lib/hooks.js";

const ID = "3b139d5b-d998-4168-9a8c-6afae89909b8";

test("only this machine is loopback", () => {
  // The entire security model of POST /hook, so it is a function with tests
  // rather than a comparison written inline once.
  for (const good of ["127.0.0.1", "::1", "::ffff:127.0.0.1", " ::FFFF:127.0.0.1 "]) {
    assert.equal(isLoopback(good), true, good);
  }
  for (const bad of ["192.168.82.5", "127.0.0.2", "localhost", "10.0.0.1", "", null, undefined, 42]) {
    assert.equal(isLoopback(bad), false, String(bad));
  }
});

test("the three hook events jarvis reports become the two kinds it reports them as", () => {
  assert.equal(parseHookEvent({ hook_event_name: "Stop", session_id: ID }).kind, "complete");
  assert.equal(parseHookEvent({ hook_event_name: "SessionEnd", session_id: ID }).kind, "complete");
  assert.equal(parseHookEvent({ hook_event_name: "Notification", session_id: ID }).kind, "needs-attention");
});

test("an event jarvis does not report is dropped rather than guessed at", () => {
  // Any local process can post here. An unknown name is not an error to
  // complain about; a complaint is a channel too.
  assert.equal(parseHookEvent({ hook_event_name: "PreToolUse", session_id: ID }), null);
  assert.equal(parseHookEvent({ hook_event_name: "", session_id: ID }), null);
  assert.equal(parseHookEvent({ session_id: ID }), null);
  assert.equal(parseHookEvent(null), null);
  assert.equal(parseHookEvent("Stop"), null);
  assert.equal(parseHookEvent([{ hook_event_name: "Stop" }]), null);
});

test("an event nothing can be attributed to is not reported", () => {
  // The id names both a transcript file and a memory record, so anything
  // outside a safe alphabet names neither.
  assert.equal(parseHookEvent({ hook_event_name: "Stop" }), null);
  assert.equal(parseHookEvent({ hook_event_name: "Stop", session_id: "../../etc/passwd" }), null);
  assert.equal(parseHookEvent({ hook_event_name: "Stop", session_id: "short" }), null);
  assert.equal(parseHookEvent({ hook_event_name: "Stop", session_id: 42 }), null);
});

test("a notification carries what it is waiting for, capped and flattened", () => {
  const rlo = String.fromCharCode(0x202e);
  const event = parseHookEvent({
    hook_event_name: "Notification",
    session_id: ID,
    cwd: "/home/krane/development/jarvis",
    message: `Claude needs your permission${rlo} to use\nBash`,
  });
  assert.equal(event.detail, "Claude needs your permission to use Bash");
  assert.equal(event.cwd, "/home/krane/development/jarvis");

  const long = parseHookEvent({ hook_event_name: "Notification", session_id: ID, message: "x".repeat(999) });
  assert.equal(long.detail.length, MAX_DETAIL_CHARS);
});

test("a SessionEnd reports how it ended", () => {
  const event = parseHookEvent({ hook_event_name: "SessionEnd", session_id: ID, reason: "prompt_input_exit" });
  assert.equal(event.detail, "prompt_input_exit");
});

test("an event with no detail at all is still an event", () => {
  const event = parseHookEvent({ hook_event_name: "Stop", session_id: ID });
  assert.deepEqual(event, { kind: "complete", sessionId: ID, cwd: "", detail: "" });
});

// ---------------------------------------------------------------------------
// createDeduper
// ---------------------------------------------------------------------------

test("one exit noticed by three mechanisms is reported once", () => {
  // SessionEnd and Stop both fire as a session exits, and the roster poller
  // notices the same exit a tick later.
  const dedupe = createDeduper();
  const key = `${ID}:complete`;
  assert.equal(dedupe.accept(key, 1000), true);
  assert.equal(dedupe.accept(key, 1500), false);
  assert.equal(dedupe.accept(key, 1000 + DEDUPE_MS - 1), false);
});

test("a session that genuinely finishes twice is news both times", () => {
  // Something queued for it lands after it went idle, and it works again.
  const dedupe = createDeduper();
  const key = `${ID}:complete`;
  assert.equal(dedupe.accept(key, 1000), true);
  assert.equal(dedupe.accept(key, 1000 + DEDUPE_MS), true);
});

test("two sessions finishing at once are two reports", () => {
  const dedupe = createDeduper();
  assert.equal(dedupe.accept("a:complete", 1000), true);
  assert.equal(dedupe.accept("b:complete", 1000), true);
  assert.equal(dedupe.accept("a:needs-attention", 1000), true);
});

test("the deduper cannot grow without bound, because anything local can feed it", () => {
  const dedupe = createDeduper({ windowMs: 1_000_000, maxKeys: 10 });
  for (let i = 0; i < 100; i += 1) dedupe.accept(`key-${i}`, 1000);
  assert.ok(dedupe.size <= 10, `held ${dedupe.size} keys`);
});

test("keys that fell out of the window are forgotten rather than kept", () => {
  const dedupe = createDeduper({ windowMs: 100 });
  dedupe.accept("a", 1000);
  dedupe.accept("b", 2000);
  assert.equal(dedupe.size, 1);
});

test("an event with no key is not accepted", () => {
  const dedupe = createDeduper();
  assert.equal(dedupe.accept(""), false);
  assert.equal(dedupe.accept(null), false);
});
