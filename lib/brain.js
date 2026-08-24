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

// The second machine tag. It shares one scanner with the build tag in
// lib/action.js, so the syntax rules stated here are deliberately the same ones
// buildsBlock states - a prompt that taught a slightly different quoting rule
// would produce tags the parser drops on the floor, silently.
function memoryTagBlock() {
  return [
    "MEMORY: when Jesse tells you how he always wants things done, remember it by appending",
    "exactly one machine tag: [MEMORY:SET key=value ...].",
    "Use a short lowercase key and a short value, for example: [MEMORY:SET palette=dark].",
    "Any value containing a space must be wrapped in double quotes, for example:",
    'font="IBM Plex Sans".',
    "Emit it ONLY for a standing preference - something meant to hold from now on. An instruction",
    'about the one thing being made right now is not a preference: "make this one dark" gets no',
    'tag, "I always want dark palettes" gets one. When in doubt, do not emit it.',
    "Like the build tag it is stripped before your words are spoken and nobody ever sees or hears",
    "it: never mention it, never explain it, never read it aloud.",
    "If you are also starting a build, put this tag BEFORE the build tag - nothing may come after",
    "the build tag.",
  ].join(" ");
}

// What earlier sessions left behind, read back as prose. Everything here is
// defensive because the store is a hand-editable JSON file outside the repo
// (lib/memory.js): a field of the wrong type must cost the assistant its memory
// for that turn, never the whole prompt.
function memoryBlock(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) return "";

  const summary = isText(project.summary) ? project.summary.trim() : "";

  const preferences = project.preferences;
  const prefs = preferences && typeof preferences === "object"
    ? Object.entries(preferences).filter(([k, v]) => isText(k) && isText(v))
    : [];

  // Only the most recent one: the list exists to give "build on what we made
  // yesterday" a handle, and reciting ten of them would crowd out the voice.
  const artifacts = Array.isArray(project.artifacts) ? project.artifacts : [];
  const recent = [...artifacts]
    .reverse()
    .find((a) => a && typeof a === "object" && isText(a.primitive));

  if (!summary && prefs.length === 0 && !recent) return "";

  const parts = ["MEMORY: here is what you know from earlier sessions on this project."];
  if (summary) parts.push(summary);
  if (prefs.length > 0) {
    parts.push(`Standing preferences: ${prefs.map(([k, v]) => `${k}: ${v}`).join("; ")}.`);
  }
  if (recent) parts.push(`The most recent thing built here was "${recent.primitive}".`);
  parts.push("Use this naturally; never recite it verbatim or announce that you 'remember'.");
  return parts.join(" ");
}

// buildPersona(primitives, project?) -> the full system prompt.
// The list of builds is data, not prose, so the prompt can never drift out of
// sync with what is actually installed. Callers pass the loaded registry, and
// the project record from lib/memory.js when there is one.
// Capability first, then what is recalled, then CLOSER - which stays last.
// filter(Boolean) is what keeps a callerless buildPersona() byte-identical to
// what it produced before memory existed.
export function buildPersona(primitives, project = null) {
  return [VOICE, buildsBlock(primitives), memoryTagBlock(), memoryBlock(project), CLOSER]
    .filter(Boolean)
    .join(" ");
}

// The default for callers that have no registry to hand: the same assistant,
// honest about having nothing to build.
export const PERSONA = buildPersona();

// TOOLS_OFF + MODEL are pinned to the combination that was verified to work.
//
// `--tools ""`, not `--allowedTools ""`. An allowedTools list governs what may be
// USED; it leaves every tool's definition in the prompt regardless. This is the
// same lesson lib/builder.js records about --disallowedTools, arriving here as
// latency rather than as safety: measured on claude 2.1.241, the chat turn was
// carrying 12,082 input tokens and now carries 2,076.
const TOOLS_OFF = ["--tools", ""];
const MODEL = ["--model", "claude-haiku-4-5-20251001"];

// A voice turn cannot use an MCP server, and buildSpawnOptions passes no env, so
// without this the CLI reads the user's global ~/.claude.json -- whatever the cwd
// is -- and starts every server configured there, on every sentence spoken.
// lib/builder.js deliberately does NOT do this: a primitive may declare `mcp`,
// and marketing-site does.
const NO_MCP = ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} })];

function baseArgs(persona) {
  return ["-p", "--output-format", "json", "--settings", SETTINGS,
          "--system-prompt", persona, ...MODEL, ...TOOLS_OFF, ...NO_MCP];
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

// ---------------------------------------------------------------------------
// One warm CLI instead of a cold one per turn
// ---------------------------------------------------------------------------
//
// Everything above spawns a process, asks it one question and lets it exit. Two
// thirds of what that costs is the process rather than the question: measured on
// this machine, the fork itself is 3 ms but the CLI takes about 1080 ms to get a
// request out and about 550 ms to shut down afterwards with the answer already in
// hand. A long-lived CLI pays both once. Measured, same process, three turns in a
// row: 1908 ms, 739 ms, 777 ms.
//
// The protocol is `--input-format stream-json` in and `--output-format
// stream-json` out: one JSON object per line each way, prompts written to stdin,
// events read off stdout. `--verbose` is not optional -- the CLI refuses
// stream-json output without it.
//
// THE TRADE, measured rather than assumed: a sentence written to stdin while a
// turn is running is QUEUED, not interrupting. There is no way to tell a shared
// process to forget a turn, so the SIGTERM abort the cold path uses cannot exist
// here. What survives is the promise the server actually makes -- that a
// superseded answer is never spoken -- because ask() rejects immediately and the
// answer that eventually arrives is consumed by a tombstone rather than handed to
// whoever is next in line. An interrupted turn is about 800 ms slower for it;
// every ordinary turn is about 1700 ms faster.

// Not `--` and not a prompt: there is no sentence yet, and every sentence arrives
// later down stdin.
export function buildSessionArgs(persona, resumeId = null) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
                "--verbose", "--settings", SETTINGS, "--system-prompt", persona,
                ...MODEL, ...TOOLS_OFF, ...NO_MCP];
  if (resumeId) args.push("--resume", resumeId);
  return args;
}

// The line IS the frame, so JSON.stringify is doing real work here: a newline
// inside a spoken sentence would otherwise be read as the start of another turn.
export function encodeTurn(text) {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

// Stdout arrives in chunks that have nothing to do with lines: one read can carry
// two events and half of a third. Stateful on purpose -- the half event has to
// wait somewhere for the rest of itself.
export function createLineReader() {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      const lines = [];
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) lines.push(line);
      }
      return lines;
    },
  };
}

// readResult(event) -> { reply, sessionId } for a turn that has finished, or null
// for anything else.
//
// `system/init` arrives once per TURN, not once per process, which is measured
// and is a trap in both directions: waiting for it before sending would hang, and
// treating it as the end of a turn would answer the wrong sentence. Only the
// terminal result event ends a turn.
export function readResult(event) {
  if (!event || event.type !== "result") return null;
  if (event.is_error) {
    throw new Error(`claude: ${String(event.result || event.subtype || "failed").slice(0, 200)}`);
  }
  return { reply: String(event.result || "").trim(), sessionId: event.session_id || null };
}

// createBrainSession({ persona, bin, resume, cwd }) -> { ask, restart, close,
// sessionId, resumeId }.
//
// The child is spawned lazily and respawned after a death, so a CLI that dies at
// three in the morning costs one turn rather than every turn after it.
export function createBrainSession(opts = {}) {
  const persona = opts.persona || PERSONA;
  let resumeId = opts.resume || null;
  let sessionId = null;
  let child = null;
  let closed = false;
  // One entry per turn written to stdin, in the order they were written, because
  // that is the order the CLI answers them in. An abandoned entry stays here as a
  // tombstone: its answer is still coming and still has to be consumed.
  let pending = [];

  function settleAll(err) {
    const waiting = pending;
    pending = [];
    child = null;
    for (const entry of waiting) if (!entry.orphaned) entry.reject(err);
  }

  function spawnChild() {
    const proc = spawn(opts.bin || "claude", buildSessionArgs(persona, resumeId),
                       { cwd: opts.cwd || HERE, stdio: ["pipe", "pipe", "pipe"] });
    const read = createLineReader();
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      for (const line of read.push(d)) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        let answer;
        try { answer = readResult(event); }
        catch (e) { const entry = pending.shift(); if (entry && !entry.orphaned) entry.reject(e); continue; }
        if (!answer) continue;
        if (answer.sessionId) sessionId = answer.sessionId;
        const entry = pending.shift();
        if (entry && !entry.orphaned) entry.resolve(answer);
      }
    });
    proc.stderr.on("data", (d) => (err += d));
    // A write to a dead child raises EPIPE on the stream rather than throwing at
    // the call site, and an unhandled one takes the server down with it.
    proc.stdin.on("error", () => {});
    proc.on("error", (e) => settleAll(e));
    proc.on("close", (code) => {
      if (child !== proc) return;
      settleAll(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
    });
    return proc;
  }

  function ensureChild() {
    if (!child) child = spawnChild();
    return child;
  }

  return {
    get sessionId() { return sessionId; },
    get resumeId() { return resumeId; },

    ask(text, turnOpts = {}) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new Error("the brain session is closed"));
        // Checked before the write, not after: a turn already abandoned must not
        // be queued behind the one in flight, where it would be answered anyway
        // and cost the person a turn's wait for nothing.
        if (turnOpts.signal?.aborted) return reject(abortedError());

        const entry = { resolve, reject, orphaned: false };
        pending.push(entry);
        turnOpts.signal?.addEventListener("abort", () => {
          if (entry.orphaned) return;
          entry.orphaned = true;
          reject(abortedError());
        }, { once: true });

        try { ensureChild().stdin.write(encodeTurn(text)); }
        catch (e) { pending = pending.filter((p) => p !== entry); reject(e); }
      });
    },

    // Kill the process and forget the conversation it was holding. The id is the
    // thing most likely to be what broke, so a replay that carried it would fail
    // the same way twice -- the same reasoning as the cold path's retry.
    restart() {
      const dying = child;
      child = null;
      resumeId = null;
      sessionId = null;
      settleAll(new Error("the brain session was restarted"));
      dying?.kill("SIGTERM");
    },

    close() {
      closed = true;
      const dying = child;
      child = null;
      settleAll(new Error("the brain session is closed"));
      dying?.stdin.end();
      dying?.kill("SIGTERM");
    },
  };
}

// The error an abandoned turn fails with. It carries a flag rather than a
// recognisable message because the one caller that must react to it -
// askResilient - would otherwise be matching on prose again, which is the trap
// its own comment below is about.
function abortedError() {
  const err = new Error("the turn was superseded before it answered");
  err.aborted = true;
  return err;
}

// ask(text, sessionId?) -> { reply, sessionId }.  THE SEAM.
// Pass `opts.persona` (from buildPersona(registry)) to tell this session what it
// can build; without it the assistant is chat-only.
// Pass `opts.signal` (an AbortSignal) to abandon the turn: the child is asked to
// stop and the promise rejects with `err.aborted`. Nothing here decides WHEN
// that is right - the caller holding the conversation does.
export function ask(text, sessionId, opts = {}) {
  // A warm session already holds the conversation, so the id is its business
  // rather than the caller's. Everything below is the cold path, unchanged, and
  // still what lib/builder.js and the closing summary use.
  if (opts.session) return opts.session.ask(text, opts);

  const args = buildClaudeArgs(text, sessionId, opts.persona);
  return new Promise((resolve, reject) => {
    // Checked before the spawn, not after: a turn already abandoned must not
    // cost a process, and a caller that aborts between deciding and calling is
    // the ordinary case rather than a race.
    if (opts.signal?.aborted) return reject(abortedError());

    const child = spawn(
      opts.bin || "claude",
      args,
      buildSpawnOptions(opts.cwd || HERE),
    );
    let out = "", err = "";
    let aborted = false;
    const t = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs || 30000);

    // SIGTERM, the same ask-politely the timeout uses. The flag is set first and
    // synchronously, so the close handler below knows why the child went away
    // rather than reporting an abandoned turn as an ordinary non-zero exit.
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // Every exit path runs this. A listener left on a controller the caller
    // reuses would fire into a promise that settled minutes ago.
    const done = () => {
      clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { done(); reject(aborted ? abortedError() : e); });
    child.on("close", (code) => {
      done();
      if (aborted) return reject(abortedError());
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
      try { resolve(parseClaudeJson(out)); } catch (e) { reject(e); }
    });
  });
}

// askResilient(text, sessionId?, opts) -> { reply, sessionId, recovered }.
// A resumed session can die between turns: the CLI owns that session store, not
// us, and ids expire. Deciding *which* failure means that from the error text
// would mean matching truncated stderr from a tool that ships weekly - it would
// fail silently the first time the wording changed, and the conversation would
// be stuck in a permanent-failure loop with no test noticing. So this does not
// look at the error at all: any failure of a resumed call earns exactly one
// cold retry. Being wrong costs one extra haiku turn; being right heals the
// conversation.
export async function askResilient(text, sessionId, opts = {}) {
  try {
    return { ...(await ask(text, sessionId, opts)), recovered: false };
  } catch (first) {
    // The one failure that must never earn a retry. Nobody is waiting on this
    // answer any more, and the turn that superseded it is already on its way -
    // a retry here would put two children on the same session id, which is the
    // race the abort exists to avoid.
    if (first.aborted) throw first;

    // A warm session has no "nothing was resumed" case to fall back on: the
    // process itself may simply have died, which is a thing that costs the
    // conversation nothing to heal and everything to give up on. So it always
    // earns exactly one replay, through a process spawned fresh.
    if (opts.session) {
      try {
        opts.session.restart();
        return { ...(await ask(text, sessionId, opts)), recovered: true };
      } catch (second) {
        second.sessionExhausted = true;
        throw second;
      }
    }

    // Nothing was resumed, so there is no stale id to blame - this failure is
    // the real answer, and retrying it would just fail twice as slowly.
    if (!sessionId) throw first;

    try {
      return { ...(await ask(text, null, opts)), recovered: true };
    } catch (second) {
      // The caller clears the stored session id on this flag. Without it, it
      // would have to guess "was that a dead session or a dead CLI" from a
      // generic spawn error - the same string-matching trap, one layer up.
      second.sessionExhausted = true;
      throw second;
    }
  }
}
