export function loadFishConfig(env = process.env) {
  const apiKey = env.FISH_API_KEY || "";
  if (!apiKey) throw new Error("No Fish API key (set FISH_API_KEY)");
  return {
    apiKey,
    voiceId: env.FISH_VOICE_ID || "",
    model: env.FISH_MODEL || "s2.1-pro-free",
    format: env.FISH_FORMAT || "mp3",
    speed: env.FISH_SPEED !== "" && Number.isFinite(Number(env.FISH_SPEED)) ? Number(env.FISH_SPEED) : 1,
    // Semitones, 0 is neutral. Fish's prosody object has no pitch field at all
    // (only speed, volume, normalize_loudness), so this never reaches the TTS
    // request -- it is carried through to the browser instead, which applies it
    // by resampling the clip it already has.
    pitch: env.FISH_PITCH !== "" && Number.isFinite(Number(env.FISH_PITCH)) ? Number(env.FISH_PITCH) : 0,
    // A bug fix: volume has been documented in the README and shipped in the
    // setup snippet since it was added, and lib/tts.js has always had a live
    // code path for it, but this loader once dropped the field on the floor --
    // only the tests ever exercised that branch. It has never once reached Fish.
    volume: env.FISH_VOLUME !== "" && Number.isFinite(Number(env.FISH_VOLUME)) ? Number(env.FISH_VOLUME) : 0,
  };
}

// Read at startup for the same reason as loadFishConfig above: a missing key
// should be a startup error naming what is missing, not a login that fails at
// the moment someone first tries to use it. The values themselves come from
// the environment -- a gitignored `.env` in development, or whatever the
// service manager sets in production.
export function loadSupabaseConfig(env = process.env) {
  const url = env.SUPABASE_URL || "";
  const anonKey = env.SUPABASE_ANON_KEY || "";
  if (!url) throw new Error("No Supabase URL (set SUPABASE_URL)");
  if (!anonKey) throw new Error("No Supabase anon key (set SUPABASE_ANON_KEY)");
  // Opt-in rather than inferred: this server speaks plain HTTP, and a Secure
  // cookie is never sent over http:// at all. See sessionCookie in lib/auth.js.
  return { url, anonKey, secure: env.SECURE_COOKIE === "1" };
}
