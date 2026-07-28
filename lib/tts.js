const TTS_URL = "https://api.fish.audio/v1/tts";

export function buildTtsRequest(text, cfg) {
  const body = { text, format: cfg.format, latency: "normal" };
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
