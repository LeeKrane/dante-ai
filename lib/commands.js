// Skills, spoken: "run the cleanup skill in jarvis", "send
// cleanup-session-codebase to fix-tests".
//
// Claude Code accepts a slash command wherever it accepts a prompt -- as the
// first thing a new session is given, or on `claude -p --resume` into one
// that already exists -- and expands it there. Dante can already start a
// session with a task and pass a sentence to a running one, so the only
// thing this module adds is the vetting between a spoken name and the line
// that actually reaches a session, and the sentences for when the vetting
// says no.
//
// What Dante may send is a SKILL and nothing else: a /<name> that resolves to
// a SKILL.md under ~/.claude/skills or a repository's own .claude/skills.
// Never one of the CLI's own commands (/compact, /clear, /permissions, /login
// ...): those act on the session or the CLI itself rather than on the work,
// and voice is a lossy channel -- "/clear" misheard for "/cleanup" throws a
// session's context away. Anything native is typed at a keyboard, where you
// can see what you asked for. Two lists carry that, and both are load-bearing
// in the way CLAUDE.md says lib/spawn-session.js's FORBIDDEN is, because the
// line this produces goes on the argv of a real session under the user's
// login:
//
// - `known` is the allow-list, built by loadCommands from the skills that are
//   actually on disk. A name not in it is refused by name rather than guessed
//   at, because "run the cleanup skill" heard as "run the clean skill" must
//   not become a name the model invents to fit.
// - NATIVE_COMMANDS is a deny-list underneath the allow-list: the CLI's own
//   command names. A skill directory that happens to share one of them (a
//   repo with a skill called "review") is not sendable either, because the
//   CLI resolves the native command first and Dante would be sending
//   something other than what it said.
//
// Split the usual way: everything above loadCommands is pure, loadCommands
// is the thin impure caller with `home` and `repos` as the seam a test points
// at a temp directory.

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// The CLI's own commands, as of 2.1.257 (`claude --help` and the in-session
// /help listing). Never sendable by voice, whatever discovery finds. Kept
// generous rather than exact: a name that turns out not to be native costs a
// spoken refusal and a correction, a native one that slipped through costs a
// session its context or its permissions.
export const NATIVE_COMMANDS = new Set([
  "add-dir", "agents", "bug", "clear", "compact", "config", "context", "cost", "doctor", "exit",
  "export", "help", "hooks", "ide", "init", "install-github-app", "login", "logout", "mcp", "memory",
  "model", "output-style", "permissions", "plugin", "pr-comments", "privacy-settings", "quit",
  "release-notes", "resume", "review", "rewind", "stats", "status", "tasks", "terminal-setup",
  "todos", "upgrade", "usage", "vim", "allowed-tools",
]);

// A skill name as Claude Code accepts one: what follows the slash, up to the
// first space. Namespaced skills carry a colon (plugin:skill).
const NAME = /^[a-z0-9][a-z0-9:_-]*$/i;

// Same class lib/spawn-session.js strips, for the same reason: this reaches
// a command line.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Arguments are one spoken clause -- "the auth module" -- and get the cap
// lib/confirm.js puts on a task read back inside a sentence. Collapsed to one
// line before the strip, as everywhere else: the command line has to be one
// line, because a second line would be the skill's arguments continuing
// rather than the command ending.
export const MAX_ARGS_CHARS = 140;

// The whole line, slash and name included. Room for a long namespaced skill
// name in front of the arguments; lib/confirm.js reads the line back with
// this same cap so that what is spoken is never a truncated copy of what runs.
export const MAX_COMMAND_CHARS = MAX_ARGS_CHARS + 80;

function clean(value, maxChars) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

// parseCommand(text, known) -> { name, args, line } or null.
//
// `text` is the whole command as it would be typed, slash included; `known`
// is the allow-list -- the Map loadCommands builds, or any Set of names. Null
// is a refusal a caller has to act on, not an exception to unwind past --
// same reasoning as buildStartArgs in lib/spawn-session.js -- and
// refuseCommand below says which refusal it was.
export function parseCommand(text, known) {
  const cleaned = clean(text, MAX_COMMAND_CHARS);
  if (!cleaned.startsWith("/")) return null;
  const [rawName, ...rest] = cleaned.slice(1).split(" ");
  if (!NAME.test(rawName)) return null;
  if (NATIVE_COMMANDS.has(rawName.toLowerCase())) return null;
  const name = canonicalName(rawName, known);
  if (!name) return null;
  const args = clean(rest.join(" "), MAX_ARGS_CHARS);
  return { name, args, line: args ? `/${name} ${args}` : `/${name}` };
}

// canonicalName(spoken, known) -> the skill's name as its directory spells
// it, or "" when it is not known. Matching is case-insensitive because the
// name arrived through speech and a model; the RESULT keeps the directory's
// own casing because Claude Code resolves a skill from its directory name,
// and "/cleanup-session" does not find "Cleanup-Session" on a filesystem
// that tells them apart. The Map loadCommands builds is keyed lowercase
// with the real name inside; a Set of names is matched as written.
function canonicalName(spoken, known) {
  const lower = spoken.toLowerCase();
  if (typeof known?.get === "function") {
    const record = known.get(lower);
    return record === undefined ? "" : record?.name || lower;
  }
  if (typeof known?.has === "function") return known.has(lower) ? lower : known.has(spoken) ? spoken : "";
  return "";
}

function isKnown(name, known) {
  return canonicalName(name, known) !== "";
}

// refuseCommand(text, known) -> the sentence to say, or null when the command
// is fine. Which refusal it is matters out loud: "I do not know /foo" invites
// a correction, "that is a Claude command, not a skill" does not.
export function refuseCommand(text, known) {
  const cleaned = clean(text, MAX_COMMAND_CHARS);
  if (!cleaned.startsWith("/")) return "I did not catch which skill that was, sir.";
  const rawName = cleaned.slice(1).split(" ")[0];
  if (!NAME.test(rawName)) return "I did not catch which skill that was, sir.";
  const name = rawName.toLowerCase();
  if (NATIVE_COMMANDS.has(name)) return `I will not send /${name} by voice, sir. That is a Claude command, not a skill.`;
  if (!isKnown(name, known)) return `I do not know a /${name} skill, sir.`;
  return null;
}

// commandsBlock(known) -> the persona paragraph listing what may be sent, or
// "" when nothing is known -- the same shape sessionsBlock in lib/brain.js
// gives session kinds, and for the same reason: a list of nothing is worse
// than no list.
export function commandsBlock(known) {
  const names = [...namesOf(known)].sort();
  if (names.length === 0) return "";
  return [
    "SKILLS: Krane can ask you to run a skill - a slash command - in a new session or in one",
    "already running. The skills that exist are:",
    names.map((name) => `/${name}`).join(", ") + ".",
    'Add command="/<name> <arguments>" to a start or a tell tag - the line exactly as it would',
    "be typed, arguments included, in double quotes - and the skill is what runs; task= is then",
    "only the spoken label. A skill always waits its turn in a running session, so it goes on a",
    "tell, never an interrupt. Never write a name that is not in this list, and never one of",
    "Claude's own commands (compact, clear, permissions, and the like): if he names something",
    "you cannot see here, say you do not know that skill rather than guessing at a name. Ask",
    "which arguments only when the skill needs them and he gave none. The same guardrail as",
    "tell and stop applies: never send a skill to a session unless he asked you to, in this",
    "turn.",
  ].join(" ");
}

function* namesOf(known) {
  if (typeof known?.keys !== "function") return;
  for (const key of known.keys()) {
    const name = (typeof known.get === "function" && known.get(key)?.name) || key;
    if (typeof name === "string" && NAME.test(name) && !NATIVE_COMMANDS.has(name.toLowerCase())) {
      yield name;
    }
  }
}

// vetCommand(session, known) -> { session, refusal }, exactly one of which
// is meaningful: a refusal to speak, or the session tag with its command=
// normalised and the two rules that follow from carrying one applied. Pure,
// and the one place those rules live, so server.js stays wiring:
//
// - A tag that names a command it cannot send is refused outright, before it
//   is ever described or proposed: an unknown or native name is not
//   something to propose and let the yes find out about.
// - A bare command= with nothing in it is no command; the key is dropped and
//   the tag is an ordinary one.
// - A command interrupt becomes a command tell. The peer channel that makes
//   an interrupt an interrupt wraps what it delivers in a sentence about
//   where it came from, and a slash command inside that sentence is prose
//   to the session (verified live against CLI 2.1.257; see dispatchTell in
//   server.js), so a command always waits its turn -- and it is described
//   and confirmed as the tell it will actually be.
// - A command start with no task gets the line itself as its label, which
//   is what the roster and the recap will call it.
export function vetCommand(session, known) {
  const raw = session?.command;
  if (typeof raw !== "string" || !raw.trim()) {
    const { command, ...rest } = session ?? {};
    return { session: rest, refusal: null };
  }
  const refusal = refuseCommand(raw, known);
  if (refusal) return { session, refusal };
  const { line } = parseCommand(raw, known);
  const verb = typeof session.verb === "string" ? session.verb.toLowerCase() : "";
  const next = { ...session, command: line };
  if (verb === "interrupt") next.verb = "tell";
  if (verb === "start" && !(typeof session.task === "string" && session.task.trim())) next.task = `run ${line}`;
  return { session: next, refusal: null };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// Where Claude Code looks for skills: <dir>/.claude/skills/<name>/SKILL.md,
// under the home directory and under each repository. Not .claude/commands
// -- the older single-file form -- and not plugin-provided skills under
// ~/.claude/plugins: Krane's rule is that Dante sends skills he wrote, and
// the plugin layout moves between CLI versions besides. A list that is wrong
// is worse than one that is short.
function skillsUnder(dir) {
  const skills = join(dir, ".claude", "skills");
  if (!existsSync(skills)) return [];
  const found = [];
  for (const entry of safeReaddir(skills)) {
    if (entry.isDirectory() && existsSync(join(skills, entry.name, "SKILL.md"))) found.push(entry.name);
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
// The home directory first, then each repository, so a repository's own
// skill wins the `source` for a name it shares with a global one -- which is
// also the one Claude Code would run in that repository. A native name is
// dropped here as well as in parseCommand: the persona list is built from
// this map, and a name it must never send has no business being advertised.
export function loadCommands({ home = homedir(), repos = [] } = {}) {
  const known = new Map();
  const dirs = [home, ...(Array.isArray(repos) ? repos : [])].filter((dir) => typeof dir === "string" && dir);
  // Keyed lowercase so a spoken name matches however it was heard; the
  // record keeps the directory's own casing, which is the name the session
  // has to be sent (see canonicalName).
  for (const dir of dirs) {
    for (const name of skillsUnder(dir)) {
      const key = name.toLowerCase();
      if (!NAME.test(name) || NATIVE_COMMANDS.has(key)) continue;
      known.set(key, { name, source: dir });
    }
  }
  return known;
}
