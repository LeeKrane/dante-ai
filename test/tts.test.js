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
