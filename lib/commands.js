// Slash commands, spoken: "run the review command in jarvis", "send compact
// to fix-tests".
//
// Claude Code accepts a slash command wherever it accepts a prompt -- as the
// first thing a new session is given, or typed into one that is running --
// and it expands it there: a custom command or skill by that name runs, a
// built-in does what it does. Dante can already start a session with a task
// and pass a sentence to a running one, so the only thing this module adds
// is the vetting between a spoken name and the line that actually reaches a
// session, and the sentences for when the vetting says no.
//
// Two lists, and both are load-bearing in the way CLAUDE.md says lib/
// spawn-session.js's FORBIDDEN is: the command line this produces goes on
// the argv of a real session under the user's login, or into the peer socket
// of a running one, and it was authored by a model from speech.
//
// - `known` is an allow-list, built by loadCommands from what is actually
//   on disk plus a few built-ins known to work headless. A command not in it
//   is refused by name rather than guessed at, because "run the review
//   command" heard as "run the remove command" must not become a command the
//   model invents to fit.
// - FORBIDDEN_COMMANDS is a deny-list underneath the allow-list, for the
//   commands that change the CLI's own configuration or trust. Voice is a
//   lossy channel; those are typed where you can see what you asked for, and
//   no discovery can ever put one back on the allow-list.
//
// Split the usual way: everything above loadCommands is pure, loadCommands
// is the thin impure caller with `home` and `repos` as the seam a test points
// at a temp directory.

import { readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";

// Built-ins that make sense sent to a session by voice and are known to work
// in print mode, where every session Dante starts or resumes runs. Kept
// short on purpose: a built-in that only makes sense at a keyboard (/help,
// /clear on a session nobody is looking at) has no reason to be here.
export const BUILTIN_COMMANDS = new Set(["compact", "review", "init", "cost"]);

// Commands that change what the CLI is allowed to do, who it is signed in
// as, or how it is wired. Never sendable by voice, whatever discovery finds
// -- a skill named "permissions" in a repository does not un-forbid the
// built-in it would shadow.
export const FORBIDDEN_COMMANDS = new Set([
  "permissions", "config", "hooks", "mcp", "login", "logout", "allowed-tools",
  "terminal-setup", "vim", "exit", "quit", "bug", "doctor",
]);

// A command name as Claude Code accepts one: what follows the slash, up to
// the first space. Namespaced skills carry a colon (plugin:skill).
const NAME = /^[a-z0-9][a-z0-9:_-]*$/i;

// Same class lib/spawn-session.js strips, for the same reason: this reaches
// a command line.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Arguments are one spoken clause -- "high", "the auth module" -- and get the
// cap lib/confirm.js puts on a task read back inside a sentence. Collapsed to
// one line before the strip, as everywhere else: the command line has to be
// one line, because a second line would be the skill's arguments continuing
// rather than the command ending.
export const MAX_ARGS_CHARS = 140;

function clean(value, maxChars) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

// parseCommand(text, known) -> { name, args, line } or null.
//
// `text` is the whole command as it would be typed, slash included; `known`
// is the allow-list (any iterable of names, or a Map keyed by them). Null is
// a refusal a caller has to act on, not an exception to unwind past -- same
// reasoning as buildStartArgs in lib/spawn-session.js -- and refuseCommand
// below says which refusal it was.
export function parseCommand(text, known) {
  const cleaned = clean(text, MAX_ARGS_CHARS + 80);
  if (!cleaned.startsWith("/")) return null;
  const [rawName, ...rest] = cleaned.slice(1).split(" ");
  if (!NAME.test(rawName)) return null;
  const name = rawName.toLowerCase();
  if (FORBIDDEN_COMMANDS.has(name)) return null;
  if (!isKnown(name, known)) return null;
  const args = clean(rest.join(" "), MAX_ARGS_CHARS);
  return { name, args, line: args ? `/${name} ${args}` : `/${name}` };
}

function isKnown(name, known) {
  if (!known) return false;
  if (typeof known.has === "function") return known.has(name);
  for (const entry of known) {
    if ((typeof entry === "string" ? entry : entry?.name) === name) return true;
  }
  return false;
}

// refuseCommand(text, known) -> the sentence to say, or null when the command
// is fine. Which refusal it is matters out loud: "I do not know /foo" invites
// a correction, "I will not send /permissions by voice" does not.
export function refuseCommand(text, known) {
  const cleaned = clean(text, MAX_ARGS_CHARS + 80);
  if (!cleaned.startsWith("/")) return "I did not catch which command that was, sir.";
  const rawName = cleaned.slice(1).split(" ")[0];
  if (!NAME.test(rawName)) return "I did not catch which command that was, sir.";
  const name = rawName.toLowerCase();
  if (FORBIDDEN_COMMANDS.has(name)) return `I will not send /${name} by voice, sir.`;
  if (!isKnown(name, known)) return `I do not know a /${name} command, sir.`;
  return null;
}

// describeCommand(parsed) -> the clause lib/confirm.js reads back in the
// proposal: "running /review high". The exact line, because the rule there
// is to say back exactly what will run.
export function describeCommand(parsed) {
  return parsed?.line ? `running ${parsed.line}` : "";
}

// commandsBlock(known) -> the persona paragraph listing what may be sent, or
// "" when nothing is known -- the same shape sessionsBlock in lib/brain.js
// gives session kinds, and for the same reason: a list of nothing is worse
// than no list.
export function commandsBlock(known) {
  const names = [...namesOf(known)].sort();
  if (names.length === 0) return "";
  return [
    "COMMANDS: Krane can ask you to run a slash command, in a new session or in one already",
    "running. The commands that exist are:",
    names.map((name) => `/${name}`).join(", ") + ".",
    'Add command="/<name> <arguments>" to a start or a tell tag - the line exactly as it would',
    "be typed, arguments included, in double quotes - and the command is what runs; task= is",
    "then only the spoken label. A command always waits its turn in a running session, so it",
    "goes on a tell, never an interrupt. Never write a command that is not in this list: if he",
    "names one you cannot see here, say you do not know it rather than guessing at a name. Ask",
    "which arguments only when the command needs them and he gave none. The same guardrail as",
    "tell and stop applies: never send a command to a session unless he asked you to, in this",
    "turn.",
  ].join(" ");
}

function* namesOf(known) {
  if (!known) return;
  for (const entry of typeof known.keys === "function" ? known.keys() : known) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (typeof name === "string" && NAME.test(name) && !FORBIDDEN_COMMANDS.has(name.toLowerCase())) {
      yield name.toLowerCase();
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// Where Claude Code looks for custom commands and skills: <dir>/.claude/
// commands/<name>.md and <dir>/.claude/skills/<name>/SKILL.md, under the
// home directory and under each repository. Plugin-provided skills are not
// searched -- their layout under ~/.claude/plugins moves between CLI
// versions, and a list that is wrong is worse than one that is short.
function commandsUnder(dir) {
  const found = [];
  const commands = join(dir, ".claude", "commands");
  if (existsSync(commands)) {
    for (const entry of safeReaddir(commands)) {
      if (entry.isFile() && extname(entry.name) === ".md") found.push(basename(entry.name, ".md"));
    }
  }
  const skills = join(dir, ".claude", "skills");
  if (existsSync(skills)) {
    for (const entry of safeReaddir(skills)) {
      if (entry.isDirectory() && existsSync(join(skills, entry.name, "SKILL.md"))) found.push(entry.name);
    }
  }
  return found;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// loadCommands({ home, repos }) -> Map<name, { name, source }>.
//
// Built-ins first, then the home directory, then each repository, so a
// repository's own skill wins the `source` for a name it shares with a
// global one -- which is also the one Claude Code would run in that
// repository. A forbidden name is dropped here as well as in parseCommand:
// the persona list is built from this map, and a command it must never send
// has no business being advertised.
export function loadCommands({ home = homedir(), repos = [] } = {}) {
  const known = new Map();
  for (const name of BUILTIN_COMMANDS) known.set(name, { name, source: "builtin" });
  const dirs = [home, ...(Array.isArray(repos) ? repos : [])].filter((dir) => typeof dir === "string" && dir);
  for (const dir of dirs) {
    for (const raw of commandsUnder(dir)) {
      const name = raw.toLowerCase();
      if (!NAME.test(name) || FORBIDDEN_COMMANDS.has(name)) continue;
      known.set(name, { name, source: dir });
    }
  }
  return known;
}
