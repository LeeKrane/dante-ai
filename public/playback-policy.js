// When Jarvis may be interrupted, and where the orb lands when he is.
//
// The fourth of the pure client modules (stt-policy.js, visibility-policy.js,
// progress-policy.js). app.js touches the DOM on its first line and can never be
// unit-tested, so every decision that can be phrased as a function is phrased
// here instead.

// The five states the orb knows. Exported because the handoff a clip carries
// arrives off the wire and has to be checked against something.
export const ORB_STATES = new Set(["idle", "listening", "thinking", "working", "speaking"]);

// canStartListening(state, holding, hasRecognizer)
//
// No state refuses the button any more, which is the whole point: whatever
// Jarvis is doing, the person gets to talk. A clip being spoken is cancelled by
// the press; a turn still being thought about is superseded by the server, which
// abandons it and folds what was said into the call that replaces it
// (lib/turns.js). Both are the same promise — whoever spoke last has the floor.
//
// `state` is kept in the signature deliberately. This is the one place that
// decides when the button is dead, and the honest answer being "never" is worth
// stating once rather than discovering by reading a call site.
export function canStartListening(state, holding, hasRecognizer) {
  if (!hasRecognizer) return false;
  return !holding;
}

// stateAfterClip(handoff) -> the state the orb takes when a clip stops, whether
// it finished on its own or was cancelled.
//
// A clip can hand the orb to a state instead of ending the turn: the build
// confirmation lands in "working" so the HUD picks up exactly when the voice
// stops. That handoff comes off the WebSocket, so it is checked against
// ORB_STATES rather than passed into setState on trust — an unknown value would
// be written to the screen and looked up in the orb's palette.
export function stateAfterClip(handoff) {
  return ORB_STATES.has(handoff) ? handoff : "idle";
}

// handoffAfterPreempt(cut, incoming) -> the handoff the clip now starting carries.
//
// A clip that arrives while another is audible cuts it off: whoever spoke last
// holds the floor, which is the same rule the record button (stage 12) and the
// turn gate (stage 13) already follow. Two clips really can land together — a
// build's spoken result is deliberately not gated by the turn that superseded
// the conversation, so a done-line and a chat reply can arrive in the same
// second, and both are legitimate.
//
// The subtlety is the handoff, not the audio. The build kickoff line carries
// "working" and the build is genuinely running by the time it is spoken; a reply
// that pre-empts it and lands on idle as usual would leave the HUD of a live
// build never started. So an incoming clip with no handoff of its own inherits
// the one it cut off. This is the opposite of what the record button does with a
// handoff, and deliberately: there setState follows two lines later, whereas the
// pre-empting clip IS the next setState.
//
// Both values arrive off the WebSocket, so neither is inherited on trust.
export function handoffAfterPreempt(cut, incoming) {
  if (ORB_STATES.has(incoming)) return incoming;
  return ORB_STATES.has(cut) ? cut : null;
}

// shouldShowCancel(playing, chromeHidden)
//
// The button offers to stop a clip, so it appears exactly while a clip is
// audible and not one moment longer. Driven by whether a source is actually
// playing rather than by the orb's state: "speaking" is set just before
// src.start(), and a button offering to stop something that has not started is
// a button that does nothing when pressed.
//
// `chromeHidden` is the interface hidden with `h`. CSS hides #controls with the
// rest of it, but a button that is only invisible is still focusable and still
// answers the keyboard, and a control nobody can see must not be one they can
// still press.
export function shouldShowCancel(playing, chromeHidden) {
  return Boolean(playing) && !chromeHidden;
}
