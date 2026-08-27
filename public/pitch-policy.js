// How high or low the reply sounds, independent of anything Fish was asked
// for. Fish's TTS API has no pitch parameter at all -- its prosody object
// carries only speed, volume and normalize_loudness -- so this is applied
// entirely on this browser's own output, by resampling the clip it already
// has. Resampling shifts tempo along with pitch: a deeper voice also reads
// slightly slower, a higher one slightly faster. That is an accepted
// trade-off, not a bug, and there is no other way to get pitch out of a clip
// that was already synthesized at a fixed rate.
//
// The sixth of the pure client modules alongside volume-policy.js,
// stt-policy.js, playback-policy.js, progress-policy.js, visibility-policy.js.
// app.js owns the audio nodes; the numbers they are driven by live here so
// they can be tested without a browser.

export const MIN_PITCH = -12;
export const MAX_PITCH = 12;
export const DEFAULT_PITCH = 0;

// clampPitch(v) -> v folded into [MIN_PITCH, MAX_PITCH].
//
// This value arrives off a WebSocket message (server.js forwards cfg.pitch
// verbatim per clip) and is trusted no more than a value read back out of
// localStorage: nothing reaches an audio node without passing through here
// first. An octave each way is already an extreme resample; there is no
// reason to let a bad message push it further.
export function clampPitch(v) {
  if (!Number.isFinite(v)) return DEFAULT_PITCH;
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, v));
}

// centsForPitch(semitones) -> the value for AudioBufferSourceNode.detune,
// which is expressed in cents (100 cents to the semitone) rather than
// semitones themselves. Used on the buffered playback path.
export function centsForPitch(semitones) {
  return clampPitch(semitones) * 100;
}

// rateForPitch(semitones) -> the value for HTMLMediaElement.playbackRate,
// which is a ratio rather than a musical unit: doubling it raises pitch by an
// octave, so a semitone step is the twelfth root of two. Used on the streamed
// playback path, where there is no detune to reach for.
//
// Both functions describe the same resampling -- the two playback paths just
// take it in different units, one in cents, the other as a rate multiplier.
export function rateForPitch(semitones) {
  return 2 ** (clampPitch(semitones) / 12);
}
