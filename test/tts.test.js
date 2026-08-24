import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTtsRequest } from "../lib/tts.js";

const cfg = { apiKey: "k", voiceId: "v", model: "s2.1-pro-free", format: "mp3", speed: 1.1 };

test("builds fish tts request", () => {
  const r = buildTtsRequest("hello", cfg);
  assert.equal(r.headers.model, "s2.1-pro-free");
  assert.equal(r.headers.Authorization, "Bearer k");
  assert.equal(r.body.reference_id, "v");
  assert.equal(r.body.text, "hello");
  assert.deepEqual(r.body.prosody, { speed: 1.1 });
});

test("omits prosody at speed 1", () => {
  const r = buildTtsRequest("hi", { ...cfg, speed: 1 });
  assert.equal(r.body.prosody, undefined);
});

test("fish is asked to start sending before the clip is finished", () => {
  // "normal" holds the whole clip server-side and sends it in one go: measured
  // 2213 ms to the first byte against 2256 ms for the last. "balanced" puts the
  // first byte at 350 ms for the same reply. speak() still awaits the whole body,
  // so today that is worth about 250 ms; the rest of it is what a streaming
  // client spends, and it cannot spend it unless the bytes are already in flight.
  assert.equal(buildTtsRequest("hello", cfg).body.latency, "balanced");
});
