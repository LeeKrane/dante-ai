import test from "node:test";
import assert from "node:assert/strict";
import { ORB_STATES, canStartListening, stateAfterClip } from "../public/playback-policy.js";

test("the button may be pressed while Jarvis is speaking, which is what makes him interruptible", () => {
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
