import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTtsRequest, speakStream } from "../lib/tts.js";

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

test("sends volume in prosody when set", () => {
  const r = buildTtsRequest("hi", { ...cfg, speed: 1, volume: 5 });
  assert.deepEqual(r.body.prosody, { volume: 5 });
});

test("carries both speed and volume together", () => {
  const r = buildTtsRequest("hi", { ...cfg, volume: -3 });
  assert.deepEqual(r.body.prosody, { speed: 1.1, volume: -3 });
});

test("never sends pitch to fish -- there is no such prosody field", () => {
  const r = buildTtsRequest("hi", { ...cfg, speed: 1, pitch: 7 });
  // Whole-object comparison on purpose: a leaked pitch key would still pass a
  // narrower assertion that only checked for the fields fish does define.
  assert.deepEqual(r.body.prosody, undefined);
  const withVolume = buildTtsRequest("hi", { ...cfg, speed: 1, volume: 2, pitch: 7 });
  assert.deepEqual(withVolume.body.prosody, { volume: 2 });
});

test("omits volume 0 from prosody, fish's own default", () => {
  const r = buildTtsRequest("hi", { ...cfg, speed: 1, volume: 0 });
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

// --- streaming the clip out as it arrives -----------------------------------

// A stand-in for the Fish response. `body` is an async iterable of chunks, which
// is what undici hands back, so the loop under test is the real one.
function fakeFetch(chunks, { ok = true, status = 200, detail = "" } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      text: async () => detail,
      body: (async function* () { for (const c of chunks) yield Buffer.from(c); })(),
    };
  };
  fn.calls = calls;
  return fn;
}

test("a streamed clip reaches the caller in pieces rather than as one buffer at the end", () => {
  const seen = [];
  const fetch = fakeFetch(["one", "two", "three"]);
  return speakStream("hello", cfg, (c) => seen.push(c.toString()), { fetch }).then(() => {
    assert.deepEqual(seen, ["one", "two", "three"]);
  });
});

test("a streamed clip is sent with exactly the request the buffered call uses", async () => {
  const fetch = fakeFetch(["x"]);
  await speakStream("hello", cfg, () => {}, { fetch });
  const { url, init } = fetch.calls[0];
  const expected = buildTtsRequest("hello", cfg);
  assert.equal(url, expected.url);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, expected.headers);
  assert.deepEqual(JSON.parse(init.body), expected.body);
});

test("a streamed clip reports how many bytes went through it", async () => {
  // The one thing the caller cannot count for itself once the buffer is gone,
  // and the log line has said it since before there was a stream.
  const fetch = fakeFetch(["abc", "de"]);
  assert.equal(await speakStream("hello", cfg, () => {}, { fetch }), 5);
});

test("a refused streaming request throws exactly as the buffered one does", async () => {
  const fetch = fakeFetch([], { ok: false, status: 402, detail: "out of credit" });
  await assert.rejects(
    () => speakStream("hello", cfg, () => {}, { fetch }),
    /Fish TTS 402: out of credit/,
  );
});

test("a clip with no bytes in it completes rather than hanging", async () => {
  // Fish can answer 200 with nothing. The caller has already told the browser a
  // clip is coming, so this has to return and let it be ended.
  const fetch = fakeFetch([]);
  assert.equal(await speakStream("hello", cfg, () => {}, { fetch }), 0);
});

test("a streaming request carries the abort signal it was given", async () => {
  // What makes an overtaken clip stop being synthesized rather than merely go
  // unsent. Nothing else in the request changes.
  const fetch = fakeFetch(["x"]);
  const abort = new AbortController();
  await speakStream("hello", cfg, () => {}, { fetch, signal: abort.signal });
  assert.equal(fetch.calls[0].init.signal, abort.signal);
});

test("a streaming request with no signal does not invent one", async () => {
  const fetch = fakeFetch(["x"]);
  await speakStream("hello", cfg, () => {}, { fetch });
  assert.equal("signal" in fetch.calls[0].init, false);
});
