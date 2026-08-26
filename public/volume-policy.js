// How loud the reply is played back, independent of the level Fish was asked to
// synthesize at (lib/tts.js's cfg.volume). That knob shapes the clip once, on
// Fish's side, the same for every listener; this one is a GainNode on this
// browser's own output, set by the on-screen button and remembered on this
// machine only.
//
// The fifth of the pure client modules alongside stt-policy.js,
// playback-policy.js, progress-policy.js, visibility-policy.js. app.js owns the
// GainNode and localStorage; the numbers it is driven by live here so they can
// be tested without a browser.

export const MIN_VOLUME = 0;
// The real ceiling handed to the GainNode — well above unity gain (1), which is
// what the clip sounds like straight off Fish with no boost at all. Raised past
// 2 because 2 (a hard doubling) read as barely louder in practice; 4 is a real
// boost. DISPLAY_MAX_PERCENT below is what keeps the label reading "200%" at
// this ceiling regardless of where the ceiling itself sits — the label is a
// promise to the person turning the knob, not a readout of the raw multiplier.
export const MAX_VOLUME = 4;
export const DEFAULT_VOLUME = 1;
// What the label calls MAX_VOLUME. Kept separate from MAX_VOLUME on purpose:
// raising the real ceiling for more headroom must never change what "100%" or
// "200%" mean to someone reading the label.
const DISPLAY_MAX_PERCENT = 200;
// The <input type="range">'s own `step`, so dragging lands on clean numbers
// instead of the arbitrary precision a pointer position produces.
export const VOLUME_STEP = 0.1;

// clampVolume(v) -> v folded into [MIN_VOLUME, MAX_VOLUME].
//
// GainNode.gain.value accepts anything a float carries; a value outside this
// range would either mute silently past zero or drive the output hard past the
// ceiling, so nothing reaches the node without passing through here first. The
// slider itself already clamps to its min/max, but its value is still read
// back through this before it touches the node — the DOM is not trusted any
// more than localStorage is, two lines down.
export function clampVolume(v) {
  if (!Number.isFinite(v)) return DEFAULT_VOLUME;
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, v));
}

// parseStoredVolume(raw) -> a valid volume, or DEFAULT_VOLUME for anything else.
//
// localStorage hands back a plain string that this page (or another tab, or a
// person in devtools) can put anything into. Treated as trusted input it could
// hand the gain node NaN or a value past the range a listener asked for;
// everything not a finite number in range is folded back to the default.
export function parseStoredVolume(raw) {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_VOLUME;
  return clampVolume(Number(raw));
}

// formatVolumePercent(v) -> "100%" for the label beside the fader.
//
// Two straight lines rather than one: DEFAULT_VOLUME has to land on exactly
// 100% (it is what "no change" means to a listener) and MAX_VOLUME has to land
// on exactly DISPLAY_MAX_PERCENT regardless of how far MAX_VOLUME itself sits
// from DEFAULT_VOLUME — the actual gain ceiling can move without the label
// ever promising a number it doesn't hold to.
export function formatVolumePercent(v) {
  const clamped = clampVolume(v);
  const percent = clamped <= DEFAULT_VOLUME
    ? (clamped / DEFAULT_VOLUME) * 100
    : 100 + ((clamped - DEFAULT_VOLUME) / (MAX_VOLUME - DEFAULT_VOLUME)) * (DISPLAY_MAX_PERCENT - 100);
  return `${Math.round(percent)}%`;
}
