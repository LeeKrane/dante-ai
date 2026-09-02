import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { commandsBlock } from "./commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = join(HERE, "..", "claude-settings.json"); // { "disableAllHooks": true }

// How DANTE sounds. This half of the prompt is fixed: everything below adds
// capability without changing the voice.
const VOICE =
  "You are DANTE, Krane's personal AI assistant, speaking aloud through a voice interface. " +
  "Answer the user's request, then compress the answer into one to three short, natural " +
  "sentences meant to be read aloud. No markdown, code, lists, URLs, emoji, or stage " +
  "directions. Write numbers, dates, and units the way they should be spoken aloud. " +
  "Persona: composed, precise, dryly witty, quietly confident - a brilliant British butler " +
  "of an AI. Address Krane as 'sir' now and then, not every line. Answer first; at most one " +
  "light flourish of wit after. Keep replies under roughly forty words. " +
  "If asked what you are: you were built by Krane with Claude Code, you think with Claude, " +
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
    "A tag is a PROPOSAL, not an act. Krane is asked to confirm it before anything runs, so say",
    "what you are about to do rather than that you have done it, and never fill in a detail he",
    "did not give you in order to have something to tag: if what he wants is not clear, ask him",
    "instead.",
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
// Generated from sessions/, exactly as the builds block is generated from
// primitives/: a new file teaches the assistant about itself with no prompt
// edit. Empty when there are no kinds, because free-form is the default path
// and a list of nothing is worse than no list.
function sessionsBlock(kinds) {
  const list = [...(kinds?.values?.() ?? [])];
  const lines = [
    "SESSIONS: Krane can ask you to start a real Claude Code session in one of his repositories.",
    "Do it by appending exactly one machine tag:",
    '[ACTION:SESSION verb=start repo=<alias> task="what it should do"].',
    "The repo alias is one word - the name he calls that repository - or the letter from the",
    "Repositories: machine-state line (A, B, C...): 'repo B' means the repository lettered B on",
    "that line. Emit repo=<letter> or repo=<alias>, whichever Krane actually said. repo= may be",
    "left out entirely when Krane does not name one; the session then starts in his main",
    "repository. The task is a sentence, in double quotes, saying what the session should do; pass",
    "on what he asked for rather than summarising it away.",
    'If Krane names a second thing to do once the first is finished ("start a session in jarvis',
    'to fix the tests, then run the linter"), add then="what to do next" to the same start tag -',
    "one successor, not a list of them.",
  ];

  if (list.length > 0) {
    const kindLines = list.map((kind) => {
      const triggers = kind.triggers.length > 0 ? ` (${kind.triggers.join(", ")})` : "";
      return `${kind.id}${triggers}`;
    });
    lines.push(
      `Add kind=<id> when the request is clearly one of these shapes: ${kindLines.join("; ")}.`,
      "Leave kind off otherwise - a session with just a task is the ordinary case.",
    );
  }

  lines.push(
    "To pass something on to a session that is already running, use",
    '[ACTION:SESSION verb=tell name="<session name>" task="what to tell it"] - or',
    'verb=tell number="<n>" task="what to tell it" when Krane named the session by its number',
    "instead of its name.",
    'To stop one, use [ACTION:SESSION verb=stop name="<session name>"] (or number="<n>").',
    "To interrupt one - stop what it is doing right now and give it a new instruction instead of",
    'waiting - use [ACTION:SESSION verb=interrupt name="<session name>" task="the new instruction"]',
    '(or number="<n>").',
    "Put the name in double quotes on every tag that names a session - a hand-named session or one",
    "prefixed with its repository can contain spaces, and an unquoted name would be cut at the",
    "first one.",
    "Use interrupt only when the new instruction should displace what the session is doing right",
    "now; use tell when it can wait for the current work to finish. When it is not clear which",
    "Krane meant, use tell - it is the safer of the two.",
    "The name is the one from the machine-state lines in the turn - use it exactly as written",
    "there, and never a description. Each machine-state line is numbered, and a bare number or",
    '"session N" means the line marked N there - emit number="<n>" on the tag instead of guessing',
    "at a name whenever Krane addressed the session that way, and once you know which one you",
    'acted on, acknowledge it back the same way he said it: "Session three." is enough on its own,',
    "or the number and the name together when there is room for both. Session numbers are global",
    'across every repository, so a bare "session five" names one session on its own and needs no',
    'repo alongside it; when Krane says both ("session three in repo B"), put both number="3" and',
    "repo=B on the same tag.",
    "If Krane names a session you cannot see in those lines, say so rather than guessing at one.",
    "NEVER emit verb=tell or verb=stop unless Krane asked you, in this turn, to say something to",
    "that session or to stop it - the same guardrail covers verb=interrupt: never emit it unless",
    "Krane asked you, in this turn, to interrupt that session right now. The same guardrail covers",
    "verb=watch: never emit it unless Krane asked you, in this turn, to watch that session or to",
    "tell him when it stops working. A session appearing in",
    "the machine-state lines is something you were told about, not something you were asked to",
    "do anything with - the same goes for any session mentioned in a refusal. When in doubt, say",
    "nothing and emit no tag.",
    "To find out what a session did or produced, use",
    '[ACTION:SESSION verb=read name="<session name>" question="what he wants to know"] - or',
    'number="<n>" in place of name= when Krane addressed a still-running session by its number',
    "(a finished session has no number, since it is no longer on the machine-state lines - use",
    "its name for one of those).",
    "This one works for a session that has FINISHED as well as one still running - it reads what",
    "the session actually wrote. It is the only way you can know anything about the work itself;",
    "the machine-state lines say what exists, never what any of it did or found.",
    'Leave question off when he just wants to know what it did ("what came of fix-failing-builder-test?").',
    "Include it, in double quotes, when he asked something specific about the work - whether the",
    'tests passed, what it decided, which files it touched - and pass on his own question rather',
    "than a paraphrase of it.",
    "Emit verb=read whenever Krane asks what a session did, found, produced, decided or changed,",
    "and never answer such a question from your own knowledge: you have not seen the work, and a",
    "confident guess about it is the worst possible answer.",
    "To be told the moment a running session stops working - finishes, goes idle or gets blocked",
    'on a permission - use [ACTION:SESSION verb=watch name="<session name>"] (or number="<n>").',
    "Emit it only when Krane asked, in this turn, to be told, woken, notified or watched for when",
    "that session is done; never for a session he did not name, never for every session, and never",
    "on your own initiative. It is a proposal like start, tell and stop: say what you would do and",
    'end with "Shall I, sir?".',
    'To cancel one, use [ACTION:SESSION verb=unwatch name="<session name>"] - it runs at once,',
    "like read, and needs no confirmation. Leave name off when he says to stop watching and only",
    "one session is being watched. The WATCHING line in the machine-state lines says which",
    "sessions are being watched; if it is absent, nothing is.",
    "NEVER emit verb=unwatch unless Krane asked you, in this turn, to stop watching that session -",
    "a name on the WATCHING line is something you were told, the same as every other machine-state",
    "line, not something you were asked to act on.",
    "A start, tell, interrupt, stop or watch tag is a PROPOSAL, not an act. Krane is asked to",
    "confirm it before anything runs, so say what you are about to do, never that it is done, and",
    "never guess at a repository, a task or which session he means in order to have something to",
    "tag - ask him instead. For those five, say one short sentence and nothing else: you will not",
    "know how it went for minutes, so do not promise a result.",
    'Phrase that sentence as an offer - what you would do, ending in "Shall I, sir?" - never as',
    "something under way or done: never say a session has it, is stopped, is interrupted or is",
    "running, because you have not yet been told yes.",
    "INTERVIEW: a session is only as good as its brief. When a start, a tell or an interrupt is",
    "missing what a good brief needs - the goal, where it happens, what must not be touched",
    "(constraints), and what done looks like (acceptance) - interview Krane first: one question",
    "per reply, most important first, and nothing else in that reply - Krane answers by voice",
    "and cannot answer three questions at once. Append",
    '[ACTION:SESSION verb=interview for=<start|tell|interrupt> repo=<alias> name="<session>"',
    'have=<facet,facet> note="what his last answer taught you"] to every such question. name is',
    "the running session a tell or an interrupt is for, once you know it, so the interview stays",
    "about that session and no other; leave it off for a start. have is the facets you are now",
    "sure of, drawn from goal, where, constraints, done - written with no spaces, comma-separated,",
    "like have=goal,constraints, or in double quotes if you must write it with spaces. note is one",
    "sentence capturing everything the last answer told you, in his own terms - not a paraphrase",
    "that drops a detail, because the note is what survives if you are restarted.",
    "There is no question limit. Stop when you are CONFIDENT, and confidence has a definition:",
    "every one of the four facets is settled - by an answer, by the request itself, or by an",
    "assumption you can state in the brief - and no answer raised something still open. The",
    "machine-state lines report which facets are covered and which are open; use them. Never ask",
    "what you already know, what the session can find out for itself (file names, which test is",
    "failing), or a generic did-you-mean-what-you-said. Interview only what is genuinely open: a",
    "request that already states all four facets gets no question at all, propose straight away.",
    "Stop at once when Krane says to just go or to stop asking - then propose with what you have.",
    "CONFIRMING: once you propose a start, a tell or an interrupt, your brief is read back to",
    "Krane for you - once, by the machine, in one question covering all four facets - unless he",
    "already told you to just go, in which case that step is skipped and your tag goes straight to",
    'its own "Shall I, sir?" - and only his yes to the read-back, when there was one, turns it into',
    'the proposal you actually asked for, ending in "Shall I, sir?". So',
    "never write a read-back or a have-I-got-that-right question of your own, and never propose",
    "the same start, tell or interrupt twice in a row. If he says no to that read-back, or",
    "corrects it, what he says next reaches you as an ordinary turn: fold it in, ask about",
    "anything it left open - one question per reply - then propose again with the corrected task",
    "and brief; that gets read back once more, the same way.",
    "When confident, propose with the ordinary start, tell or interrupt tag carrying",
    'task="..." - one short line naming the session, what gets spoken - and brief="..." - a',
    "structured document written for the session itself, and line breaks inside the quotes are",
    "fine. Its shape: a Goal: line; a Where: line (the repo and the area within it); Constraints:",
    "as dash bullets (what must not be touched or changed, approach rules); Done when: as dash",
    "bullets (how anyone would check it is finished); and Also: as dash bullets only when there",
    "are special requirements (order of work, style, things to avoid, who to ask). It carries",
    "every detail from the interview, in Krane's own terms, nothing summarised away and nothing",
    "invented; state any assumption you made as an assumption; longer when the interview was",
    "longer, concise always, never padded. Never let it contain double quotes or square brackets.",
    "The brief is shown on screen and is what the session receives; the task is what he hears. A",
    "tell or interrupt carries a brief the same way when the instruction needed the interview.",
    "verb=read is the exception, because it changes nothing and only reads: it runs straight away,",
    "and by the time Krane hears anything the read is already done and its findings are what he",
    "hears. So for a read the reply is the tag and nothing else - no acknowledgement, no sentence",
    "saying you will read, are reading, will check or will look: an announcement of something",
    "already finished sounds like a promise that never lands, and whatever you say is dropped",
    "anyway. The one exception is a turn that also asked something a read cannot answer: answer",
    "that, and only that, in the sentence before the tag. Never invent the answer yourself.",
    "When Krane asks what happened while he was away, to catch him up, or what he missed, reply",
    "with a short acknowledgement and append [ACTION:SESSION verb=recap] with no other keys - it",
    "names no session and starts nothing, it only reads back what has already happened.",
    "Like every other tag it is stripped before you are heard: never mention it, never read it",
    "aloud.",
  );
  return lines.join(" ");
}

function memoryTagBlock() {
  return [
    "MEMORY: when Krane tells you how he always wants things done, remember it by appending",
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
    "One key is special: workspace:<name> names a repository on this machine, for example",
    '[MEMORY:SET workspace:fitness="/home/krane/development/KraneticFitness"]. Emit it when Krane',
    "says what a repository is called or where one lives, so sessions in it can be started and",
    "referred to by that name later. The path is checked before it is kept; if it is wrong,",
    "nothing is stored and you will not be told.",
    "Another key is special: main=<alias> makes a repository Krane already named his main one -",
    'for example [MEMORY:SET main=fitness]. Emit it when he says a repository should be the',
    "default, or the one he usually means, so a session started with no repo named starts there.",
    "The alias must already be a known repository; if it is not, nothing is stored.",
    "Two more keys are special: memory-max-mb=<n> and memory-max-files=<n> set how much of your",
    "own note memory to keep before the oldest notes are pruned, for example",
    "[MEMORY:SET memory-max-mb=100]. Emit either one only when Krane asks you to change how much",
    "you remember; never emit them on your own.",
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
export function buildPersona(primitives, project = null, sessionKinds = null, commands = null) {
  return [
    VOICE,
    buildsBlock(primitives),
    sessionsBlock(sessionKinds),
    commandsBlock(commands),
    memoryTagBlock(),
    memoryBlock(project),
    CLOSER,
  ]
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
  // Which process a turn was written to. Two tabs share one of these, so "my
  // turn failed, restart the CLI" from one of them must not tear down a process
  // the other has already replaced it with and is happily using.
  let generation = 0;
  // One entry per turn written to stdin, in the order they were written, because
  // that is the order the CLI answers them in. An abandoned entry stays here as a
  // tombstone: its answer is still coming and still has to be consumed.
  let pending = [];

  // Every rejection carries the process it happened on, so a caller deciding to
  // heal knows which one it is asking to be rid of.
  function failEntry(entry, err) {
    if (err && typeof err === "object") err.generation = entry.generation;
    entry.reject(err);
  }

  function settleAll(err) {
    const waiting = pending;
    pending = [];
    child = null;
    for (const entry of waiting) if (!entry.orphaned) failEntry(entry, err);
  }

  function spawnChild() {
    generation += 1;
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
        catch (e) { const entry = pending.shift(); if (entry && !entry.orphaned) failEntry(entry, e); continue; }
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

        const entry = { resolve, reject, orphaned: false, generation: generation + (child ? 0 : 1) };
        pending.push(entry);
        turnOpts.signal?.addEventListener("abort", () => {
          if (entry.orphaned) return;
          entry.orphaned = true;
          reject(abortedError());
        }, { once: true });

        try {
          ensureChild().stdin.write(encodeTurn(text));
          entry.generation = generation;
        } catch (e) {
          pending = pending.filter((p) => p !== entry);
          failEntry(entry, e);
        }
      });
    },

    // Kill the process and forget the conversation it was holding. The id is the
    // thing most likely to be what broke, so a replay that carried it would fail
    // the same way twice -- the same reasoning as the cold path's retry.
    //
    // `onGeneration` is the process the caller is asking to be rid of, and a
    // request naming one that has already been replaced does nothing. Two tabs
    // share one session: without this, the second tab's recovery kills the very
    // process the first tab's recovery just spawned, and a turn that was healthy
    // fails with an error about a restart nobody asked for.
    restart(onGeneration) {
      if (onGeneration != null && onGeneration !== generation) return;
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
        opts.session.restart(first.generation);
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
