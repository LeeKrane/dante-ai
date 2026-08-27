import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".config", "fish-audio", "speak.json");

export function loadFishConfig(path = DEFAULT_PATH) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new Error(`Cannot read Fish config at ${path}: ${e.message}`); }
  const apiKey = process.env.FISH_API_KEY || cfg.apiKey || "";
  if (!apiKey) throw new Error("No Fish API key (FISH_API_KEY or apiKey in speak.json)");
  return {
    apiKey,
    voiceId: process.env.FISH_VOICE_ID || cfg.voiceId || "",
    model: cfg.model || "s2.1-pro-free",
    format: cfg.format || "mp3",
    speed: Number.isFinite(cfg.speed) ? cfg.speed : 1,
  };
}

const SUPABASE_PATH = join(homedir(), ".config", "dante", "supabase.json");

// Same shape as loadFishConfig above, and read at startup for the same reason:
// a missing key should be a startup error naming what is missing, not a login
// that fails at the moment someone first tries to use it.
//
// The file is optional -- environment variables alone are enough -- because the
// two values differ in kind. The project URL is public; the anon key is not a
// secret in the way a password is (it is meant to be shipped to browsers) but it
// is still a credential this server holds, and a file with sane permissions is a
// better home for it than a shell history.
export function loadSupabaseConfig(path = SUPABASE_PATH, env = process.env) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path, "utf8")); }
  catch { cfg = {}; } // optional: the environment may carry both values
  const url = env.SUPABASE_URL || cfg.url || "";
  const anonKey = env.SUPABASE_ANON_KEY || cfg.anonKey || "";
  if (!url) throw new Error(`No Supabase URL (SUPABASE_URL, or "url" in ${path})`);
  if (!anonKey) throw new Error(`No Supabase anon key (SUPABASE_ANON_KEY, or "anonKey" in ${path})`);
  // Opt-in rather than inferred: this server speaks plain HTTP, and a Secure
  // cookie is never sent over http:// at all. See sessionCookie in lib/auth.js.
  return { url, anonKey, secure: env.SECURE_COOKIE === "1" };
}
