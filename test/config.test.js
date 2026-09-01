import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFishConfig } from "../lib/config.js";

test("loads fish config fields from the environment", () => {
  const cfg = loadFishConfig({
    FISH_API_KEY: "test-key",
    FISH_VOICE_ID: "test-voice-id",
    FISH_MODEL: "s2.1-pro-free",
    FISH_SPEED: "1.1",
  });
  assert.equal(cfg.apiKey, "test-key");
  assert.equal(cfg.voiceId, "test-voice-id");
  assert.equal(cfg.model, "s2.1-pro-free");
  assert.equal(cfg.speed, 1.1);
});

test("throws when no api key", () => {
  assert.throws(() => loadFishConfig({}), /FISH_API_KEY/);
});

test("the full default shape when only the required key is set", () => {
  assert.deepEqual(loadFishConfig({ FISH_API_KEY: "k" }), {
    apiKey: "k",
    voiceId: "",
    model: "s2.1-pro-free",
    format: "mp3",
    speed: 1,
    pitch: 0,
    volume: 0,
  });
});

test("pitch defaults to 0 when absent from the environment", () => {
  const cfg = loadFishConfig({ FISH_API_KEY: "k" });
  assert.equal(cfg.pitch, 0);
});

test("volume defaults to 0 when absent from the environment", () => {
  // Before a fix in loadFishConfig this field was dropped silently no matter
  // what the config said, so this is really asserting the field exists at
  // all, not just what it falls back to.
  const cfg = loadFishConfig({ FISH_API_KEY: "k" });
  assert.equal(cfg.volume, 0);
});

test("an explicit pitch and volume are both carried through", () => {
  const cfg = loadFishConfig({ FISH_API_KEY: "k", FISH_PITCH: "-5", FISH_VOLUME: "2.5" });
  assert.equal(cfg.pitch, -5);
  assert.equal(cfg.volume, 2.5);
});

test("a non-numeric speed, pitch or volume falls back to its default rather than becoming NaN", () => {
  const cfg = loadFishConfig({ FISH_API_KEY: "k", FISH_SPEED: "fast", FISH_PITCH: "low", FISH_VOLUME: "loud" });
  assert.equal(cfg.speed, 1);
  assert.equal(cfg.pitch, 0);
  assert.equal(cfg.volume, 0);
});

test("an empty-string variable is treated as unset, not as an explicit zero", () => {
  // Number("") is 0, so a naive Number(env.FISH_SPEED) would turn an empty
  // .env line into a silent speed of 0 instead of the intended default of 1.
  const cfg = loadFishConfig({ FISH_API_KEY: "k", FISH_SPEED: "", FISH_PITCH: "", FISH_VOLUME: "" });
  assert.equal(cfg.speed, 1);
  assert.equal(cfg.pitch, 0);
  assert.equal(cfg.volume, 0);
});

test("environment values win over the defaults", () => {
  const cfg = loadFishConfig({
    FISH_API_KEY: "k",
    FISH_VOICE_ID: "v1",
    FISH_MODEL: "custom-model",
    FISH_FORMAT: "wav",
    FISH_SPEED: "1.5",
    FISH_PITCH: "3",
    FISH_VOLUME: "10",
  });
  assert.deepEqual(cfg, {
    apiKey: "k",
    voiceId: "v1",
    model: "custom-model",
    format: "wav",
    speed: 1.5,
    pitch: 3,
    volume: 10,
  });
});
