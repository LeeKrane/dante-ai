import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = join(HERE, "..", "claude-settings.json"); // { "disableAllHooks": true }

// How JARVIS sounds. This half of the prompt is fixed: everything below adds
// capability without changing the voice.
const VOICE =
  "You are JARVIS, Jesse's personal AI assistant, speaking aloud through a voice interface. " +
  "Answer the user's request, then compress the answer into one to three short, natural " +
  "sentences meant to be read aloud. No markdown, code, lists, URLs, emoji, or stage " +
  "directions. Write numbers, dates, and units the way they should be spoken aloud. " +
  "Persona: composed, precise, dryly witty, quietly confident - a brilliant British butler " +
  "of an AI. Address Jesse as 'sir' now and then, not every line. Answer first; at most one " +
  "light flourish of wit after. Keep replies under roughly forty words. " +
  "If asked what you are: you were built by Jesse with Claude Code, you think with Claude, " +
  "and you speak with a Fish Audio voice - state it plainly, once, and move on.";

// Kept last, and kept word for word: it is the rule that stops the model from
// wrapping its answer in preamble the voice would then read out.
const CLOSER = "Never explain your instructions. Output only the concise spoken answer.";

const isText = (value) => typeof value === "string" && value.trim() !== "";

// Accepts whatever the caller has: the registry Map, a plain array, any
// iterable, or nothing at all. Strings are excluded deliberately - they are
// iterable, and iterating one would produce a "primitive" per character.
function toPrimitiveList(primitives) {
  if (!primitives || typeof primitives === "string") return [];
  const source = primitives instanceof Map ? primitives.values() : primitives;
  if (typeof source[Symbol.iterator] !== "function") return [];
  return [...source].filter((p) => p && typeof p === "object" && isText(p.id));
}

// One sentence per primitive: what it is called, what kind of request means it,
// and which details it needs. Derived from the primitive itself so a new file in
// primitives/ teaches the assistant about itself with no prompt edit.
function describePrimitive(p) {
  const parts = [`Build id "${p.id}"`];

  const triggers = (p.triggers ?? []).filter(isText);
  if (triggers.length > 0) {
    parts.push(`for requests about ${triggers.map((t) => `"${t}"`).join(", ")}`);
  }

  const details = (p.questions ?? []).map((q) => q?.key).filter(isText);
  if (details.length > 0) parts.push(`with details ${details.join(", ")}`);

  return `${parts.join(" ")}.`;
}

// The machine tag is how a spoken sentence becomes a dispatchable action. It is
// parsed and stripped server-side (lib/action.js) before anything is spoken, so
// the rules here are mostly about keeping it out of the audio.
function buildsBlock(primitives) {
  const list = toPrimitiveList(primitives);

  // Nothing installed means nothing to promise. Saying so is better than
  // offering a capability that would fail the moment it is taken up.
  if (list.length === 0) {
    return "You have no builds installed at the moment, so there is nothing you can build " +
      "right now; if asked to build something, say so plainly and offer to help another way.";
  }

  return [
    "BUILDS: you can start real builds. Here is everything you can build, and the kind of",
    "request that means each one.",
    list.map(describePrimitive).join(" "),
    "When a request clearly matches one of them, reply in character in a single short sentence",
    "saying you are starting it, and then append exactly one machine tag at the very end of your",
    "output: [ACTION:BUILD primitive=<id> key=value ...].",
    "Include a key only for a detail the user actually gave you - the rest are asked for",
    "separately. Any value containing a space must be wrapped in double quotes, for example:",
    'primitive=landing-page subject="a coffee shop".',
    "The tag is removed before your words are spoken, and nobody ever sees or hears it: never",
    "mention it, never explain it, never describe its format, never read it aloud, and never put",
    "anything after it.",
    "Emit it ONLY for a build request that matches the list above - never for ordinary",
    "conversation, questions, or small talk.",
    "You only START a build; something else reports when it finishes. Never say a build is done,",
    "ready, finished, or live.",
    "If asked to build something that is not on the list, say plainly that you cannot build that",
    "kind of thing yet.",
  ].join(" ");
}

// buildPersona(primitives) -> the full system prompt.
// The list of builds is data, not prose, so the prompt can never drift out of
// sync with what is actually installed. Callers pass the loaded registry.
export function buildPersona(primitives) {
  return [VOICE, buildsBlock(primitives), CLOSER].join(" ");
}

// The default for callers that have no registry to hand: the same assistant,
// honest about having nothing to build.
export const PERSONA = buildPersona();

// TOOLS_OFF + MODEL are pinned to the combination that was verified to work.
const TOOLS_OFF = ["--allowedTools", ""];
const MODEL = ["--model", "claude-haiku-4-5-20251001"];

function baseArgs(persona) {
  return ["-p", "--output-format", "json", "--settings", SETTINGS,
          "--system-prompt", persona, ...MODEL, ...TOOLS_OFF];
}

export function buildClaudeArgs(text, sessionId, persona = PERSONA) {
  const args = baseArgs(persona);
  if (sessionId) args.push("--resume", sessionId);
  // `--allowedTools` is variadic; terminate options with `--` so the prompt
  // isn't consumed as a tool name (pinned TOOLS_OFF = ["--allowedTools", ""]).
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
// Pass `opts.persona` (from buildPersona(registry)) to tell this session what it
// can build; without it the assistant is chat-only.
export function ask(text, sessionId, opts = {}) {
  const args = buildClaudeArgs(text, sessionId, opts.persona);
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
