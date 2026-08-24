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
