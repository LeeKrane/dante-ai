import { test } from "node:test";
import assert from "node:assert/strict";
import * as speechPolicy from "../public/stt-policy.js";

const { isFatalSpeechError, applyResults, interimOf, mergeTranscript } = speechPolicy;

// A SpeechRecognitionResultList is array-like and each entry is indexed, so a
// plain array of `{ isFinal, 0: { transcript } }` is the whole shape the policy
// functions touch.
const result = (transcript, isFinal) => ({ isFinal, 0: { transcript } });

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

test("a phrase Chrome on Android re-delivers at a growing length is not repeated", () => {
  // Exactly what a phone sends: resultIndex pinned at 0, one final result whose
  // transcript grows with every event. Appending each of these produced
  // "How How are How are you How are you Jarvis".
  const events = [
    [result("How", true)],
    [result("How are", true)],
    [result("How are you", true)],
    [result("How are you Jarvis", true)],
  ];
  let finals = [];
  for (const results of events) finals = applyResults(finals, 0, results);
  assert.equal(mergeTranscript("", finals), "How are you Jarvis");
});

test("desktop Chrome's one-final-per-index stream still accumulates every phrase", () => {
  let finals = [];
  finals = applyResults(finals, 0, [result("How are you", true)]);
  finals = applyResults(finals, 1, [result("How are you", true), result("Jarvis", true)]);
  assert.deepEqual(finals, ["How are you", "Jarvis"]);
  assert.equal(mergeTranscript("", finals), "How are you Jarvis");
});

test("an interim transcript is shown after the finals but never committed", () => {
  const results = [result("How are you", true), result("Jarv", false)];
  const finals = applyResults([], 0, results);
  assert.deepEqual(finals, ["How are you"]);
  assert.equal(interimOf(0, results), "Jarv");
  assert.equal(mergeTranscript("", finals, interimOf(0, results)), "How are you Jarv");
});

test("an interim transcript that is later finalised replaces it rather than joining it", () => {
  let finals = applyResults([], 0, [result("Jarv", false)]);
  assert.deepEqual(finals, []);
  finals = applyResults(finals, 0, [result("Jarvis", true)]);
  assert.equal(mergeTranscript("", finals), "Jarvis");
});

test("restarting the recogniser mid-hold keeps the phrases the earlier session heard", () => {
  // Android ends the session after each phrase, and the restarted one numbers
  // its results from 0 again, so the earlier phrase has to be committed first.
  let finals = applyResults([], 0, [result("How are you", true)]);
  const committed = mergeTranscript("", finals);
  finals = applyResults([], 0, [result("Jarvis", true)]);
  assert.equal(mergeTranscript(committed, finals), "How are you Jarvis");
});

test("applyResults leaves the array it was given untouched", () => {
  const finals = ["How"];
  const next = applyResults(finals, 0, [result("How are you", true)]);
  assert.deepEqual(finals, ["How"]);
  assert.deepEqual(next, ["How are you"]);
});

test("a merge of nothing at all is the empty string, not stray whitespace", () => {
  assert.equal(mergeTranscript("", []), "");
  assert.equal(mergeTranscript("", [], "   "), "");
  assert.equal(mergeTranscript("  ", ["  "], ""), "");
});
