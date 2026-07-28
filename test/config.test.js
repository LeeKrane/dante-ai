import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadFishConfig } from "../lib/config.js";

test("loads fish config fields", () => {
  const cfg = loadFishConfig(fileURLToPath(new URL("./fixtures/speak.json", import.meta.url)));
  assert.equal(cfg.apiKey, "test-key");
  assert.equal(cfg.voiceId, "test-voice-id");
  assert.equal(cfg.model, "s2.1-pro-free");
  assert.equal(cfg.speed, 1.1);
});

test("throws when no api key", () => {
  assert.throws(() => loadFishConfig("/nonexistent/speak.json"));
});
