const TTS_URL = "https://api.fish.audio/v1/tts";

// "balanced", not "normal". Fish holds a whole clip server-side under "normal"
// and sends it in one piece -- measured on a three-sentence reply, 2213 ms to the
// first byte against 2256 ms for the last, so nearly the entire wait is spent
// waiting for a clip that was already synthesized. Under "balanced" the first
// byte arrives at 350 ms. speak() still awaits the complete body, so the saving
// here is only the ~250 ms the whole clip finishes earlier; the rest is what a
// streaming client can spend, and it has nothing to spend unless the bytes are
// already in flight.
export function buildTtsRequest(text, cfg) {
  const body = { text, format: cfg.format, latency: "balanced" };
  if (cfg.voiceId) body.reference_id = cfg.voiceId;
  if (cfg.speed && cfg.speed !== 1) body.prosody = { ...body.prosody, speed: cfg.speed };
  if (cfg.volume) body.prosody = { ...body.prosody, volume: cfg.volume };
  return {
    url: TTS_URL,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      model: cfg.model,
    },
    body,
  };
}

function fishRequest(text, cfg, signal) {
  const req = buildTtsRequest(text, cfg);
  const init = { method: "POST", headers: req.headers, body: JSON.stringify(req.body) };
  if (signal) init.signal = signal;
  return [req.url, init];
}

async function orThrow(res) {
  if (res.ok) return res;
  const detail = await res.text().catch(() => "");
  throw new Error(`Fish TTS ${res.status}: ${detail.slice(0, 200)}`);
}

// Returns a Buffer of audio bytes in cfg.format (mp3).
export async function speak(text, cfg) {
  const res = await orThrow(await fetch(...fishRequest(text, cfg)));
  return Buffer.from(await res.arrayBuffer());
}

// speakStream(text, cfg, onChunk, opts) -> the number of bytes that went through.
//
// The same request as speak(), read as it arrives instead of at the end. Paired
// with the "balanced" latency the builder asks for, the first chunk lands around
// 450 ms into a clip that takes two seconds to finish — so this is where the wait
// between a reply existing and a reply being heard actually goes.
//
// `onChunk` is called synchronously per chunk and must not throw; the caller is
// writing to a WebSocket, and a throw here would abandon the response body
// mid-clip with no way to resume it.
//
// `opts.signal` aborts the request. A clip overtaken before its first byte
// reaches the browser is not merely unsent, it stops being synthesized -- which
// the buffered call could never do, because by the time it knew, Fish had
// already finished.
//
// `opts.fetch` is the injectable override the rest of the repo uses for the
// impure half of a module (opts.bin, opts.root, opts.settings). speak() keeps the
// bare global because nothing needed to test it; this has a loop worth testing.
export async function speakStream(text, cfg, onChunk, opts = {}) {
  const fetchFn = opts.fetch || fetch;
  const res = await orThrow(await fetchFn(...fishRequest(text, cfg, opts.signal)));
  let bytes = 0;
  // `res.body` is empty rather than absent on a 200 with no audio, which Fish
  // does answer with. for-await over it simply ends, and the caller gets 0.
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);
    bytes += buf.length;
    onChunk(buf);
  }
  return bytes;
}
