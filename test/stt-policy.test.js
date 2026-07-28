import { test } from "node:test";
import assert from "node:assert/strict";
import * as speechPolicy from "../public/stt-policy.js";

const { isFatalSpeechError } = speechPolicy;

test("keeps a held conversation alive after recoverable Chrome speech errors", () => {
  for (const error of ["no-speech", "aborted", "network", "audio-capture"]) {
    assert.equal(isFatalSpeechError(error), false, `${error} should be recoverable`);
  }
});

test("stops listening when Chrome reports a microphone permission error", () => {
  for (const error of ["not-allowed", "service-not-allowed"]) {
    assert.equal(isFatalSpeechError(error), true, `${error} should be fatal`);
  }
});
