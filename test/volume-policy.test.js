import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampVolume,
  parseStoredVolume,
  formatVolumePercent,
  isMuted,
  nextMuteState,
  isPhoneLayout,
  volumeButtonAction,
  MIN_VOLUME,
  MAX_VOLUME,
  DEFAULT_VOLUME,
  PHONE_MAX_WIDTH,
} from "../public/volume-policy.js";

test("clampVolume leaves an in-range value untouched", () => {
  assert.equal(clampVolume(0.5), 0.5);
});

test("clampVolume floors at the minimum", () => {
  assert.equal(clampVolume(-3), MIN_VOLUME);
});

test("clampVolume ceilings at the maximum, which sits above the default", () => {
  assert.equal(clampVolume(9), MAX_VOLUME);
  assert.ok(MAX_VOLUME > DEFAULT_VOLUME, "the button has to be able to go louder than normal");
});

test("clampVolume falls back to the default for anything that isn't a finite number", () => {
  assert.equal(clampVolume(NaN), DEFAULT_VOLUME);
  assert.equal(clampVolume(Infinity), DEFAULT_VOLUME);
  assert.equal(clampVolume(undefined), DEFAULT_VOLUME);
});

test("parseStoredVolume reads back a value this page wrote", () => {
  assert.equal(parseStoredVolume("1.5"), 1.5);
});

test("parseStoredVolume defaults for missing storage", () => {
  assert.equal(parseStoredVolume(null), DEFAULT_VOLUME);
  assert.equal(parseStoredVolume(undefined), DEFAULT_VOLUME);
  assert.equal(parseStoredVolume(""), DEFAULT_VOLUME);
});

test("parseStoredVolume treats a tampered or corrupt string as untrusted input", () => {
  assert.equal(parseStoredVolume("not a number"), DEFAULT_VOLUME);
  assert.equal(parseStoredVolume("9999"), MAX_VOLUME);
  assert.equal(parseStoredVolume("-9999"), MIN_VOLUME);
});

test("formatVolumePercent renders the label beside the fader", () => {
  assert.equal(formatVolumePercent(0), "0%");
  assert.equal(formatVolumePercent(DEFAULT_VOLUME), "100%");
});

test("formatVolumePercent calls the real ceiling 200%, whatever the raw multiplier there is", () => {
  // The label is a promise to the person turning the knob, not a readout of
  // the GainNode's raw value — raising MAX_VOLUME for more real headroom must
  // never change what the top of the fader claims to be.
  assert.equal(formatVolumePercent(MAX_VOLUME), "200%");
});

test("formatVolumePercent scales linearly on each side of the default", () => {
  const half = DEFAULT_VOLUME / 2;
  const mid = DEFAULT_VOLUME + (MAX_VOLUME - DEFAULT_VOLUME) / 2;
  assert.equal(formatVolumePercent(half), "50%");
  assert.equal(formatVolumePercent(mid), "150%");
});

test("isMuted is true exactly at the minimum", () => {
  assert.equal(isMuted(MIN_VOLUME), true);
});

test("isMuted is false at the default", () => {
  assert.equal(isMuted(DEFAULT_VOLUME), false);
});

test("isMuted is false just above the minimum", () => {
  assert.equal(isMuted(MIN_VOLUME + 0.01), false);
});

test("nextMuteState muting from a normal level sends it to the minimum and remembers the level", () => {
  assert.deepEqual(nextMuteState(0.7, DEFAULT_VOLUME), { volume: MIN_VOLUME, restore: 0.7 });
});

test("nextMuteState unmuting brings back the remembered level", () => {
  assert.deepEqual(nextMuteState(MIN_VOLUME, 0.7), { volume: 0.7, restore: 0.7 });
});

test("nextMuteState unmuting when the remembered level is itself 0 falls back to DEFAULT_VOLUME rather than staying silent", () => {
  assert.deepEqual(nextMuteState(MIN_VOLUME, 0), { volume: DEFAULT_VOLUME, restore: 0 });
});

test("nextMuteState treats a tampered or corrupt restore level as untrusted input", () => {
  assert.deepEqual(nextMuteState(MIN_VOLUME, "banana"), { volume: DEFAULT_VOLUME, restore: DEFAULT_VOLUME });
  assert.deepEqual(nextMuteState(MIN_VOLUME, 99), { volume: MAX_VOLUME, restore: MAX_VOLUME });
});

test("PHONE_MAX_WIDTH is 520, matching the @media (max-width: 520px) breakpoint in index.html", () => {
  // Named so that changing the breakpoint in index.html has to visit this
  // test too, rather than the two numbers drifting apart silently.
  assert.equal(PHONE_MAX_WIDTH, 520);
});

test("isPhoneLayout is true only without hover and with a narrow viewport", () => {
  assert.equal(isPhoneLayout({ hoverCapable: false, narrow: true }), true);
  assert.equal(isPhoneLayout({ hoverCapable: true, narrow: true }), false);
  assert.equal(isPhoneLayout({ hoverCapable: false, narrow: false }), false);
  assert.equal(isPhoneLayout({ hoverCapable: true, narrow: false }), false);
});

test("isPhoneLayout treats an undefined narrow as not a phone", () => {
  assert.equal(isPhoneLayout({ hoverCapable: false, narrow: undefined }), false);
});

test("volumeButtonAction always mutes on a hover-capable device, whether or not the fader is already open, narrow or wide", () => {
  assert.equal(volumeButtonAction({ hoverCapable: true, narrow: true, faderOpen: false }), "mute");
  assert.equal(volumeButtonAction({ hoverCapable: true, narrow: true, faderOpen: true }), "mute");
  assert.equal(volumeButtonAction({ hoverCapable: true, narrow: false, faderOpen: false }), "mute");
  assert.equal(volumeButtonAction({ hoverCapable: true, narrow: false, faderOpen: true }), "mute");
});

test("volumeButtonAction opens the fader on a wide no-hover device (tablet), when it isn't open yet", () => {
  assert.equal(volumeButtonAction({ hoverCapable: false, narrow: false, faderOpen: false }), "open");
});

test("volumeButtonAction mutes on a wide no-hover device (tablet), once the fader is already open", () => {
  assert.equal(volumeButtonAction({ hoverCapable: false, narrow: false, faderOpen: true }), "mute");
});

test("volumeButtonAction opens the fader on a phone when it is closed, and never mutes", () => {
  assert.equal(volumeButtonAction({ hoverCapable: false, narrow: true, faderOpen: false }), "open");
});

test("volumeButtonAction closes the fader on a phone when it is open, rather than muting", () => {
  assert.equal(volumeButtonAction({ hoverCapable: false, narrow: true, faderOpen: true }), "close");
});
