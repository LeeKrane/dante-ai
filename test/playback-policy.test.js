import test from "node:test";
import assert from "node:assert/strict";
import {
  ANNOUNCEMENT_TTL_MS,
  MAX_QUEUED_ANNOUNCEMENTS,
  ORB_STATES,
  canStartListening,
  clearAnnouncements,
  floorIsFree,
  handoffAfterPreempt,
  queueAnnouncement,
  shouldShowCancel,
  stateAfterClip,
  takeAnnouncement,
} from "../public/playback-policy.js";

test("the button may be pressed while Dante is speaking, which is what makes him interruptible", () => {
  assert.equal(canStartListening("speaking", false, true), true);
});

test("the button may be pressed in every state the orb has", () => {
  for (const state of ["idle", "listening", "working", "thinking", "speaking"]) {
    assert.equal(canStartListening(state, false, true), true, state);
  }
});

test("a turn still being thought about does not lock the button either", () => {
  // The server supersedes the call in flight and folds what was said into the
  // one that replaces it, so the press is never wasted.
  assert.equal(canStartListening("thinking", false, true), true);
});

test("a button already held starts nothing a second time", () => {
  for (const state of ["idle", "speaking"]) {
    assert.equal(canStartListening(state, true, true), false, state);
  }
});

test("a browser with no speech recognition can never start listening", () => {
  assert.equal(canStartListening("idle", false, false), false);
  assert.equal(canStartListening("speaking", false, false), false);
});

test("a cancelled clip that carried no handoff ends the turn", () => {
  assert.equal(stateAfterClip(null), "idle");
  assert.equal(stateAfterClip(undefined), "idle");
  assert.equal(stateAfterClip(""), "idle");
});

test("a cancelled build confirmation still hands the orb to the running build", () => {
  // The build was dispatched before the clip was ever spoken, so silencing the
  // voice must not lose the HUD.
  assert.equal(stateAfterClip("working"), "working");
});

test("every state the orb knows survives being handed over", () => {
  for (const state of ORB_STATES) assert.equal(stateAfterClip(state), state);
});

test("a handoff the orb does not recognize is refused rather than shown", () => {
  // This value arrives off the WebSocket and would otherwise be written to the
  // screen and looked up in the orb's palette.
  for (const handoff of ["busy", "IDLE", 42, {}, [], true]) {
    assert.equal(stateAfterClip(handoff), "idle", JSON.stringify(handoff));
  }
});

// --- the cancel button ------------------------------------------------------

test("the way out is offered exactly while a clip is audible", () => {
  assert.equal(shouldShowCancel(true, false), true);
  assert.equal(shouldShowCancel(false, false), false);
});

test("nothing playing means nothing to offer, whatever the orb is doing", () => {
  // Driven by the source, not by the state: "speaking" is set a moment before
  // playback actually starts.
  assert.equal(shouldShowCancel(null, false), false);
  assert.equal(shouldShowCancel(undefined, false), false);
});

test("a hidden interface hides the way out with it, rather than leaving it pressable", () => {
  assert.equal(shouldShowCancel(true, true), false);
});

// --- one clip cutting off another ------------------------------------------

test("a clip that carries its own handoff keeps it when it cuts another off", () => {
  assert.equal(handoffAfterPreempt("working", "idle"), "idle");
  assert.equal(handoffAfterPreempt(null, "working"), "working");
});

test("a build confirmation cut off by a chat reply still hands the orb to the build", () => {
  // The kickoff line carries "working" and the build is already running. A reply
  // that pre-empts it lands on idle as usual, and the HUD of a live build would
  // never start — so the pre-empting clip inherits what the cut one was carrying.
  assert.equal(handoffAfterPreempt("working", null), "working");
  assert.equal(handoffAfterPreempt("working", undefined), "working");
  assert.equal(handoffAfterPreempt("working", ""), "working");
});

test("two ordinary clips in a row still end the turn", () => {
  assert.equal(handoffAfterPreempt(null, null), null);
  assert.equal(stateAfterClip(handoffAfterPreempt(null, null)), "idle");
});

test("a handoff the orb does not know is refused whichever clip it came from", () => {
  // Both halves arrive off the WebSocket, so neither is inherited on trust.
  assert.equal(handoffAfterPreempt("busy", null), null);
  assert.equal(handoffAfterPreempt("working", "busy"), "working");
  assert.equal(handoffAfterPreempt(42, {}), null);
});

test("every state the orb knows can be inherited by the clip that cuts in", () => {
  for (const state of ORB_STATES) assert.equal(handoffAfterPreempt(state, null), state);
});

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const announcement = (id, at = NOW) => ({ id, text: `${id} finished, sir.`, at });

test("an announcement waits for a floor nobody else is holding", () => {
  assert.equal(floorIsFree({ state: "idle" }), true);
  // A build running in the background is not a conversation.
  assert.equal(floorIsFree({ state: "working" }), true);
});

test("an announcement never barges in on someone else's turn", () => {
  for (const state of ["listening", "thinking", "speaking"]) {
    assert.equal(floorIsFree({ state }), false, state);
  }
  assert.equal(floorIsFree({ state: "idle", holding: true }), false, "the mic is open");
  assert.equal(floorIsFree({ state: "idle", playing: {} }), false, "a clip is audible");
  assert.equal(floorIsFree({ state: "idle", awaitingAnswer: true }), false, "a question is waiting");
  assert.equal(floorIsFree({ state: "idle", listening: true }), false);
});

test("the floor is free by default, because an unknown state is not a conversation", () => {
  assert.equal(floorIsFree({}), true);
  assert.equal(floorIsFree(), true);
});

test("with the floor free the oldest announcement is spoken and the rest wait", () => {
  const queue = [announcement("a"), announcement("b")];
  const result = takeAnnouncement(queue, { state: "idle" }, NOW);
  assert.equal(result.speak.id, "a");
  assert.deepEqual(result.queue.map((i) => i.id), ["b"]);
  assert.equal(result.dropped, 0);
});

test("with the floor held nothing is spoken and nothing is lost", () => {
  const queue = [announcement("a")];
  const result = takeAnnouncement(queue, { state: "speaking" }, NOW);
  assert.equal(result.speak, null);
  assert.deepEqual(result.queue.map((i) => i.id), ["a"]);
});

test("an announcement older than a couple of minutes is dropped rather than spoken stale", () => {
  // It already went to Slack, which is the durable channel. "jarvis-1 has
  // finished" two minutes late is not news.
  const queue = [announcement("old", NOW - ANNOUNCEMENT_TTL_MS), announcement("new")];
  const result = takeAnnouncement(queue, { state: "idle" }, NOW);
  assert.equal(result.speak.id, "new");
  assert.equal(result.dropped, 1);
});

test("stale announcements are swept even when the floor is busy", () => {
  // Callers assign the queue back unconditionally, so this is where a backlog
  // stops growing during a long conversation.
  const queue = [announcement("old", NOW - ANNOUNCEMENT_TTL_MS)];
  const result = takeAnnouncement(queue, { state: "thinking" }, NOW);
  assert.deepEqual(result.queue, []);
  assert.equal(result.dropped, 1);
});

test("an empty queue is not an announcement", () => {
  assert.deepEqual(takeAnnouncement([], { state: "idle" }, NOW), { speak: null, queue: [], dropped: 0 });
  assert.equal(takeAnnouncement(null, { state: "idle" }, NOW).speak, null);
});

test("an entry with no timestamp cannot go stale, so it is not kept", () => {
  const result = takeAnnouncement([{ id: "x", text: "x" }], { state: "idle" }, NOW);
  assert.equal(result.speak, null);
  assert.equal(result.dropped, 1);
});

test("a long walk away keeps the recent endings, not the first ones", () => {
  let queue = [];
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) queue = queueAnnouncement(queue, announcement(id));
  assert.equal(queue.length, MAX_QUEUED_ANNOUNCEMENTS);
  assert.deepEqual(queue.map((i) => i.id), ["c", "d", "e", "f", "g"]);
});

test("something that is not an announcement never joins the queue", () => {
  assert.deepEqual(queueAnnouncement([], null), []);
  assert.deepEqual(queueAnnouncement([], { text: "no id" }), []);
  assert.deepEqual(queueAnnouncement("not a queue", announcement("a")).map((i) => i.id), ["a"]);
});

// ---------------------------------------------------------------------------
// clearAnnouncements
// ---------------------------------------------------------------------------

test("a recap empties the queue and says how much it emptied", () => {
  const queue = [announcement("a"), announcement("b"), announcement("c")];
  assert.deepEqual(clearAnnouncements(queue), { queue: [], dropped: 3 });
});

test("clearing an already-empty queue reports nothing dropped", () => {
  assert.deepEqual(clearAnnouncements([]), { queue: [], dropped: 0 });
});

test("clearing treats a non-array the same way every other queue helper here does", () => {
  assert.deepEqual(clearAnnouncements(null), { queue: [], dropped: 0 });
  assert.deepEqual(clearAnnouncements(undefined), { queue: [], dropped: 0 });
  assert.deepEqual(clearAnnouncements("not a queue"), { queue: [], dropped: 0 });
});
