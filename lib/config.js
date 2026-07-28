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
