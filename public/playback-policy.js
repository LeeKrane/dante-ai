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
// "speaking" is deliberately NOT on the refusal list, which is the whole point:
// pressing the button while Jarvis is talking cancels the clip and starts a new
// turn, the way every voice assistant that is pleasant to use behaves.
//
// "thinking" stays refused. Nothing is playing yet, so there is nothing to
// interrupt — only a turn already in flight, whose reply would arrive in the
// middle of the next sentence.
export function canStartListening(state, holding, hasRecognizer) {
  if (!hasRecognizer) return false;
  if (holding) return false;
  return state !== "thinking";
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
