import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampVolume,
  parseStoredVolume,
  formatVolumePercent,
  MIN_VOLUME,
  MAX_VOLUME,
  DEFAULT_VOLUME,
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
