import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedHosts, allowedOrigins, loadFishConfig, serverIdentity } from "../lib/config.js";

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

test("serverIdentity defaults to a loopback host and no WireGuard IP when both are unset", () => {
  assert.deepEqual(serverIdentity({}), { host: "127.0.0.1", wgIp: "" });
});

test("serverIdentity treats an empty-string DANTE_HOST or DANTE_WG_IP the same as unset", () => {
  assert.deepEqual(serverIdentity({ DANTE_HOST: "", DANTE_WG_IP: "" }), { host: "127.0.0.1", wgIp: "" });
});

test("serverIdentity carries through an explicit DANTE_HOST and DANTE_WG_IP", () => {
  assert.deepEqual(serverIdentity({ DANTE_HOST: "0.0.0.0", DANTE_WG_IP: "192.168.82.1" }), {
    host: "0.0.0.0",
    wgIp: "192.168.82.1",
  });
});

test("allowedHosts on the default identity is just the localhost family, with no duplicate for the loopback host", () => {
  assert.deepEqual(
    allowedHosts({ host: "127.0.0.1", wgIp: "", port: 3210 }),
    new Set(["localhost:3210", "127.0.0.1:3210", "[::1]:3210"]),
  );
});

test("allowedHosts adds no entry for a wildcard bind address, since 0.0.0.0 is not a name a Host header would send", () => {
  assert.deepEqual(
    allowedHosts({ host: "0.0.0.0", wgIp: "", port: 3210 }),
    new Set(["localhost:3210", "127.0.0.1:3210", "[::1]:3210"]),
  );
});

test("allowedHosts adds an entry for a specific configured host", () => {
  assert.deepEqual(
    allowedHosts({ host: "192.168.1.50", wgIp: "", port: 3210 }),
    new Set(["localhost:3210", "127.0.0.1:3210", "[::1]:3210", "192.168.1.50:3210"]),
  );
});

test("allowedHosts adds an entry for the WireGuard IP when one is configured", () => {
  assert.deepEqual(
    allowedHosts({ host: "127.0.0.1", wgIp: "192.168.82.1", port: 3210 }),
    new Set(["localhost:3210", "127.0.0.1:3210", "[::1]:3210", "192.168.82.1:3210"]),
  );
});

test("allowedHosts brackets an IPv6 host or WireGuard address", () => {
  assert.deepEqual(
    allowedHosts({ host: "fd00::1", wgIp: "fd00::2", port: 3210 }),
    new Set(["localhost:3210", "127.0.0.1:3210", "[::1]:3210", "[fd00::1]:3210", "[fd00::2]:3210"]),
  );
});

test("allowedOrigins on the default identity is just the localhost family", () => {
  assert.deepEqual(
    allowedOrigins({ host: "127.0.0.1", wgIp: "", port: 3210 }),
    new Set(["http://localhost:3210", "http://127.0.0.1:3210"]),
  );
});

test("allowedOrigins adds no entry for a wildcard bind address", () => {
  assert.deepEqual(
    allowedOrigins({ host: "0.0.0.0", wgIp: "", port: 3210 }),
    new Set(["http://localhost:3210", "http://127.0.0.1:3210"]),
  );
});

test("allowedOrigins adds an entry for a specific configured host", () => {
  assert.deepEqual(
    allowedOrigins({ host: "192.168.1.50", wgIp: "", port: 3210 }),
    new Set(["http://localhost:3210", "http://127.0.0.1:3210", "http://192.168.1.50:3210"]),
  );
});

test("allowedOrigins adds an entry for the WireGuard IP when one is configured", () => {
  assert.deepEqual(
    allowedOrigins({ host: "127.0.0.1", wgIp: "192.168.82.1", port: 3210 }),
    new Set(["http://localhost:3210", "http://127.0.0.1:3210", "http://192.168.82.1:3210"]),
  );
});

test("allowedOrigins brackets an IPv6 host or WireGuard address", () => {
  assert.deepEqual(
    allowedOrigins({ host: "fd00::1", wgIp: "fd00::2", port: 3210 }),
    new Set([
      "http://localhost:3210",
      "http://127.0.0.1:3210",
      "http://[fd00::1]:3210",
      "http://[fd00::2]:3210",
    ]),
  );
});
