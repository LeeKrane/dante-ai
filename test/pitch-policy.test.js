import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampPitch,
  centsForPitch,
  rateForPitch,
  MIN_PITCH,
  MAX_PITCH,
  DEFAULT_PITCH,
} from "../public/pitch-policy.js";

test("clampPitch leaves an in-range value untouched", () => {
  assert.equal(clampPitch(3), 3);
});

test("clampPitch floors at the minimum", () => {
  assert.equal(clampPitch(-99), MIN_PITCH);
});

test("clampPitch ceilings at the maximum", () => {
  assert.equal(clampPitch(99), MAX_PITCH);
});

test("clampPitch falls back to the default for anything that isn't a finite number", () => {
  assert.equal(clampPitch(NaN), DEFAULT_PITCH);
  assert.equal(clampPitch(Infinity), DEFAULT_PITCH);
  assert.equal(clampPitch(undefined), DEFAULT_PITCH);
});

test("centsForPitch converts neutral pitch to zero cents", () => {
  assert.equal(centsForPitch(0), 0);
});

test("centsForPitch converts a full octave up to 1200 cents", () => {
  assert.equal(centsForPitch(12), 1200);
});

test("centsForPitch clamps before converting, so an out-of-range input cannot produce out-of-range cents", () => {
  assert.equal(centsForPitch(999), MAX_PITCH * 100);
  assert.equal(centsForPitch(-999), MIN_PITCH * 100);
});

// These three are exact powers of two at these particular exponents (0, 1,
// -1), so assert.equal (not a tolerance) is the right check here.
test("rateForPitch(0) is unity rate", () => {
  assert.equal(rateForPitch(0), 1);
});

test("rateForPitch(12) doubles the rate, an octave up", () => {
  assert.equal(rateForPitch(12), 2);
});

test("rateForPitch(-12) halves the rate, an octave down", () => {
  assert.equal(rateForPitch(-12), 0.5);
});
