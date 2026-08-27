import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFishConfig } from "../lib/config.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/speak.json", import.meta.url));

test("loads fish config fields", () => {
  const cfg = loadFishConfig(FIXTURE);
  assert.equal(cfg.apiKey, "test-key");
  assert.equal(cfg.voiceId, "test-voice-id");
  assert.equal(cfg.model, "s2.1-pro-free");
  assert.equal(cfg.speed, 1.1);
});

test("throws when no api key", () => {
  assert.throws(() => loadFishConfig("/nonexistent/speak.json"));
});

test("pitch defaults to 0 when absent from the config file", () => {
  const cfg = loadFishConfig(FIXTURE);
  assert.equal(cfg.pitch, 0);
});

test("volume defaults to 0 when absent from the config file", () => {
  // The fixture has no volume key. Before the fix in loadFishConfig this field
  // was dropped silently no matter what the file said, so this is really
  // asserting the field exists at all, not just what it falls back to.
  const cfg = loadFishConfig(FIXTURE);
  assert.equal(cfg.volume, 0);
});

test("an explicit pitch and volume are both carried through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-config-test-"));
  const path = join(dir, "speak.json");
  try {
    await writeFile(path, JSON.stringify({ apiKey: "k", pitch: -5, volume: 2.5 }));
    const cfg = loadFishConfig(path);
    assert.equal(cfg.pitch, -5);
    assert.equal(cfg.volume, 2.5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
