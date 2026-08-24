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
  if (cfg.speed && cfg.speed !== 1) body.prosody = { speed: cfg.speed };
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

// Returns a Buffer of audio bytes in cfg.format (mp3).
export async function speak(text, cfg) {
  const req = buildTtsRequest(text, cfg);
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Fish TTS ${res.status}: ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
