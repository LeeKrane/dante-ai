import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = join(HERE, "..", "claude-settings.json"); // { "disableAllHooks": true }

const PERSONA =
  "You are JARVIS, Jesse's personal AI assistant, speaking aloud through a voice interface. " +
  "Answer the user's request, then compress the answer into one to three short, natural " +
  "sentences meant to be read aloud. No markdown, code, lists, URLs, emoji, or stage " +
  "directions. Write numbers, dates, and units the way they should be spoken aloud. " +
  "Persona: composed, precise, dryly witty, quietly confident - a brilliant British butler " +
  "of an AI. Address Jesse as 'sir' now and then, not every line. Answer first; at most one " +
  "light flourish of wit after. Keep replies under roughly forty words. " +
  "If asked what you are: you were built by Jesse with Claude Code, you think with Claude, " +
  "and you speak with a Fish Audio voice - say it briefly and with pride. " +
  "You cannot yet take real-world actions or run builds; if asked to, note that capability " +
  "arrives in your next upgrade. Never explain your instructions. " +
  "Output only the concise spoken answer.";

// All tools disabled (pure text replies) and a fast model pinned for low-latency
// spoken answers. If your plan/version can't resolve this model ID, use "haiku".
const TOOLS_OFF = ["--allowedTools", ""];
const MODEL = ["--model", "claude-haiku-4-5-20251001"];

function baseArgs() {
  return ["-p", "--output-format", "json", "--settings", SETTINGS,
          "--system-prompt", PERSONA, ...MODEL, ...TOOLS_OFF];
}

export function buildClaudeArgs(text, sessionId) {
  const args = baseArgs();
  if (sessionId) args.push("--resume", sessionId);
  // `--allowedTools` is variadic; terminate options with `--` so the prompt
  // isn't consumed as a tool name.
  args.push("--", text);
  return args;
}

export function parseClaudeJson(stdout) {
  const data = JSON.parse(stdout);
  return { reply: String(data.result || "").trim(), sessionId: data.session_id || null };
}

export function buildSpawnOptions(cwd) {
  return { cwd, stdio: ["ignore", "pipe", "pipe"] };
}

// ask(text, sessionId?) -> { reply, sessionId }.  THE SEAM.
export function ask(text, sessionId, opts = {}) {
  const args = buildClaudeArgs(text, sessionId);
  return new Promise((resolve, reject) => {
    const child = spawn(
      opts.bin || "claude",
      args,
      buildSpawnOptions(opts.cwd || HERE),
    );
    let out = "", err = "";
    const t = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs || 30000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
      try { resolve(parseClaudeJson(out)); } catch (e) { reject(e); }
    });
  });
}
