// Session kinds: one file per shape of work a spoken request can start.
//
// Deliberately the same mechanism as lib/registry.js and primitives/ — one file
// in, one new thing the assistant knows how to start, and the persona's list
// generated from the folder rather than written by hand. That pattern is proven
// here, and a second, different one would be a second thing to learn.
//
// The one thing it is NOT is a copy of the primitive rules. A primitive names
// the tools a build may use, because a build runs unattended in a throwaway
// directory and the tool list is the whole boundary. A session kind names none,
// because a session started by voice runs under your own settings, your own
// permissions and your own hooks — exactly as one started in a terminal does.
// Restricting it here would only make the voice-started session weaker than the
// one you would have typed, for no gain anyone asked for.

import { loadModuleDir } from "./module-dir.js";
import { MAX_BRIEF_CHARS } from "./spawn-session.js";

// Session kinds live next to lib/ so a fresh clone works with no configuration.
const DEFAULT_DIR = new URL("../sessions/", import.meta.url);

// The vocabulary `claude --effort` accepts. Checked at load rather than at
// spawn: a typo here would otherwise surface as a session that failed to start,
// minutes later, out loud, with nothing naming the file that caused it.
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

// A session name is spoken, typed into `claude --resume`, and read back off a
// roster. Long enough to say what the work is, short enough to say out loud.
export const MAX_NAME_CHARS = 60;

// How much of the task survives into the name. Four words is enough to tell two
// sessions in one repository apart, which is all the name has to do.
const MAX_NAME_WORDS = 4;

function fail(sourceName, message) {
  throw new Error(`${sourceName}: ${message}`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Throws a message naming the file and the field, so a stranger adding their own
// session kind is told exactly what to fix. Returns true when valid.
export function validateSessionKind(kind, sourceName = "session kind") {
  if (!isPlainObject(kind)) fail(sourceName, "default export must be a session kind config object");

  if (typeof kind.id !== "string" || kind.id.trim() === "") {
    fail(sourceName, '"id" must be a non-empty string');
  }
  if (typeof kind.systemPrompt !== "function") {
    fail(sourceName, '"systemPrompt" must be a function taking the request and returning a string');
  }

  if (kind.triggers !== undefined && !Array.isArray(kind.triggers)) {
    fail(sourceName, '"triggers" must be an array when present');
  }
  for (const [i, trigger] of (kind.triggers ?? []).entries()) {
    // Handed to the model as prose it matches spoken requests against, where a
    // stray number would arrive as the literal phrase "42".
    if (typeof trigger !== "string" || trigger.trim() === "") {
      fail(sourceName, `"triggers[${i}]" must be a non-empty trigger phrase`);
    }
  }

  // Both go straight onto a command line, so the failure mode for a wrong type
  // is the argv token "[object Object]" rather than a loud error.
  if (kind.model !== undefined && (typeof kind.model !== "string" || kind.model.trim() === "")) {
    fail(sourceName, '"model" must be a non-empty model name or alias when present');
  }
  if (kind.effort !== undefined) {
    if (typeof kind.effort !== "string" || !EFFORT_LEVELS.has(kind.effort)) {
      fail(sourceName, `"effort" must be one of ${[...EFFORT_LEVELS].join(", ")} when present`);
    }
  }

  if (kind.nameHint !== undefined && typeof kind.nameHint !== "function") {
    fail(sourceName, '"nameHint" must be a function returning a short word for the session name');
  }

  if (kind.prompt !== undefined && typeof kind.prompt !== "function") {
    fail(sourceName, '"prompt" must be a function composing the session\'s whole positional prompt when present');
  }

  // Gates extractDoThisFirst's lookup (lib/transcript.js) for this kind's
  // sessions -- see speaksVerdict below. A wrong type here would otherwise
  // fail open or closed silently, at the moment a finished session's own
  // transcript is about to be spoken as an authoritative verdict.
  if (kind.speaksVerdict !== undefined && typeof kind.speaksVerdict !== "boolean") {
    fail(sourceName, '"speaksVerdict" must be a boolean when present');
  }

  // The skill this kind's `prompt` hook expects to run (see missingSkill
  // below) -- checked here only for shape; whether it actually exists is a
  // launch-time question, because it depends on which repositories are open
  // and is asked again every time a repository is named.
  if (kind.skill !== undefined && (typeof kind.skill !== "string" || kind.skill.trim() === "")) {
    fail(sourceName, '"skill" must be a non-empty skill name when present');
  }

  return true;
}

// ---------------------------------------------------------------------------
// Whether a finished session's transcript may be spoken as a verdict
// ---------------------------------------------------------------------------

// speaksVerdict(kind) -> whether a session started with this kind is trusted
// to have extractDoThisFirst's finding (lib/transcript.js) lifted into a
// spoken "The council says, do this first: ..." sentence, and into the
// recap log and the "catch me up" paragraph.
//
// False for every kind unless it opts in, and false is the default a kind
// with no `speaksVerdict` field gets, or one loaded from a Map miss (an
// ordinary, kind-less session). The reason this exists at all: a session
// transcript holds whatever that session read off disk or off the web (see
// the security half of SUMMARY_PERSONA in lib/transcript.js), which makes it
// the most attacker-reachable text in this program. extractDoThisFirst does
// no sanitizing beyond stripping markdown -- it lifts raw prose into a
// sentence spoken with Dante's own authority -- so before this existed, every
// finished session's last words were eligible, kind-less ones included.
// sessions/brainstorm.mjs is the one kind that actually asks the council for
// a verdict, and is the one that sets this true.
export function speaksVerdict(kind) {
  return kind?.speaksVerdict === true;
}

// ---------------------------------------------------------------------------
// Whether a kind's own skill is actually installed
// ---------------------------------------------------------------------------

// leadingSkill(prompt) -> the skill name a composed prompt actually opens
// with, or null.
//
// A kind's `skill` field is hand-typed by whoever wrote the .mjs file, and
// nothing ever checked it against what the kind's own `prompt` hook actually
// produces -- so a typo or a forgotten update there would pass validation
// and pass missingSkill's old check, and only fail once the CLI tried and
// failed to expand a slash command that was never really there. The rule
// here is the same one buildStartArgs and the CLI itself both use: a slash
// command only expands from the first line of the positional prompt, so
// only the first line is ever read, and only when it opens with "/".
const LEADING_SKILL = /^\/([A-Za-z0-9_-]+)(?:\s|$)/;

export function leadingSkill(prompt) {
  if (typeof prompt !== "string") return null;
  const firstLine = prompt.split("\n", 1)[0];
  const match = LEADING_SKILL.exec(firstLine);
  return match ? match[1] : null;
}

// missingSkill(kind, known, prompt) -> the skill name that is not among the
// ones loadCommands (lib/commands.js) actually found on disk, or null when
// nothing is named, or the named one IS known.
//
// A kind's `prompt` hook can compose a prompt that opens with a slash
// command -- sessions/brainstorm.mjs's /council-review -- and nothing before
// this checked that the skill actually exists before spawning a session
// around it. `known` is the same Map loadCommands returns and vetCommand
// matches a spoken command= against, so a kind's declared skill is held to
// the same allow-list a person's own voice is. Matching is case-insensitive,
// the same as canonicalName in lib/commands.js, because a kind's `skill`
// field is typed by whoever wrote the .mjs file, not spoken -- but it still
// has to agree with the exact casing loadCommands keyed its Map by.
//
// `kind.skill` wins when it is set: a kind that names one is being explicit
// about what it needs, and is checked exactly as before. `prompt` is only
// ever consulted as a fallback, for a kind that composes a slash command but
// never wrote down which one -- leadingSkill above reads it off the same
// composed prompt beginSession (server.js) is about to hand the CLI, so this
// checks what the session will actually run rather than trusting a separate,
// hand-typed field to agree with it.
//
// `known` is required to be that Map -- loadCommands always returns one, and
// beginSession (server.js) is this function's sole caller, so a `known` that
// is anything else is a programming error, not a shape worth quietly
// guessing at. This used to also accept a bare Set (`known.has`), which
// nothing ever called it with, and fell through to reporting the skill
// missing for any other shape at all -- silently, indistinguishable from an
// honest "not found". Throwing here would surface that error mid spoken
// turn, the moment a request first names a kind with a `skill` field, with
// nothing for a person to act on -- so a non-Map is instead treated as "no
// skills known", which reports missing exactly as an actually-empty Map
// would, and is at least an honest answer to the question asked.
export function missingSkill(kind, known, prompt) {
  const declared = kind?.skill;
  const name = (typeof declared === "string" && declared.trim() !== "") ? declared : leadingSkill(prompt);
  if (typeof name !== "string" || name.trim() === "") return null;
  if (!(known instanceof Map)) return name;
  return known.get(name.trim().toLowerCase()) ? null : name;
}

// ---------------------------------------------------------------------------
// What a session is remembered as having started under
// ---------------------------------------------------------------------------

// recordedKind({ kindId, command }) -> the value rememberSession (server.js)
// stores against a session's `kind` field.
//
// Null whenever a command= is present, regardless of whether `kindId` even
// names a kind with its own `prompt` hook: buildStartArgs (lib/spawn-
// session.js) runs the command instead of the brief -- or the kind's own
// composed prompt -- whenever one is given, with no exception, so a session
// started this way never actually ran whatever `kindId` would otherwise have
// composed. Recording the kind anyway would leave speaksVerdict's gate
// (above) open for a transcript that never asked the council for anything:
// a person could say "brainstorm this" and then override it with an
// arbitrary command=, and the finished session's ordinary last words would
// be lifted into a spoken "the council says" sentence they never earned.
// Remembering null keeps that gate closed for exactly the sessions that
// didn't run the kind's own prompt, and costs nothing for the ordinary case
// where no command was ever given.
export function recordedKind({ kindId, command } = {}) {
  return command ? null : (kindId ?? null);
}

function withDefaults(kind) {
  return {
    ...kind,
    // Copied, not aliased: the module cache hands back the same object on every
    // import, so a caller pushing to `triggers` would corrupt every later load.
    triggers: [...(kind.triggers ?? [])],
  };
}

// Loads every *.mjs in the directory into a Map keyed by session kind id, via
// the mechanism shared with lib/registry.js (lib/module-dir.js): the
// trailing-slash handling, the "_"/dotfile skip, and the per-file
// import/validate/id-match rules all live there now. `optional: true` is what
// makes a missing sessions/ an empty Map rather than an error — unlike
// primitives/, free-form is the default path here, and a clone with no
// session kinds at all still works.
//
// Read once at startup, for the same reason the primitive registry is: a
// half-saved edit must not break a live conversation.
export async function loadSessionKinds(dirUrl = DEFAULT_DIR) {
  return loadModuleDir(dirUrl, {
    label: "loadSessionKinds",
    dirNoun: "sessions directory",
    itemNoun: "a session kind",
    validate: validateSessionKind,
    withDefaults,
    optional: true,
  });
}

// ---------------------------------------------------------------------------
// Composing a session's prompt
// ---------------------------------------------------------------------------

// promptFor(kind, { task, brief, alias, maxChars }) -> the positional prompt
// a session is started with.
//
// A kind with no `prompt` hook is untouched: the brief passes straight
// through, exactly as it did before this field existed, so every kind
// written before now keeps starting byte-for-byte the same session it always
// did. A kind that supplies one gets to replace the brief entirely -- see
// sessions/brainstorm.mjs for why that is worth having: a slash command only
// expands when it is the first line of the prompt, and the brief has to
// follow it on later lines as the skill's own arguments, which neither
// systemPrompt (appended, not positional) nor command= (one line by
// construction -- see buildStartArgs in lib/spawn-session.js, which drops
// the brief on purpose when a command is given) can do.
//
// `maxChars` defaults to MAX_BRIEF_CHARS -- the same cap buildStartArgs
// re-applies to the composed prompt's raw character length once it reaches
// lib/spawn-session.js -- and is handed to the hook so a kind that COMPOSES
// the prompt (preamble plus brief) can trim the part that is safe to lose
// itself, before that blunt re-cap gets to choose for it and cut off
// whatever the preamble happened to push past the edge. See
// sessions/brainstorm.mjs's own `prompt` for the kind that actually needs
// this.
//
// Pure and kept here rather than in server.js, so the composition itself is
// the thing under test; server.js only calls it.
export function promptFor(kind, { task, brief, alias, maxChars = MAX_BRIEF_CHARS } = {}) {
  return kind?.prompt ? kind.prompt({ task, brief, alias, maxChars }) : brief;
}

// ---------------------------------------------------------------------------
// Naming a session
// ---------------------------------------------------------------------------

// The words a task string is made of that say nothing about which task it is.
// Dropped so "fix the failing builder test" names itself "fix-failing-builder-
// test" rather than "fix-the-failing-builder".
const FILLER = new Set(["a", "an", "and", "for", "in", "of", "on", "the", "to", "with"]);

// Lowercase, alphanumeric, dash-separated, first few meaningful words only.
// Everything else is dropped rather than transliterated: this string is spoken
// back, passed to `claude -n`, and read off a roster, and none of those places
// want a name that has to be quoted.
export function slugify(text, maxWords = MAX_NAME_WORDS) {
  if (typeof text !== "string") return "";
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word && !FILLER.has(word));
  // Every word was filler, which is a real sentence ("do the thing") and not
  // worth failing over — the alias and number alone still name the session.
  if (words.length === 0) return "";
  return words.slice(0, Math.max(1, maxWords)).join("-");
}

// buildName(spec, taken) -> the name a new session carries.
//
// Just the task, now: no `<alias>-<n>-` counter in front of it. The number a
// session used to carry was never really about the session -- it was a slot
// in a per-repository sequence, and now that a session's position in the
// panel is numbered globally, by lib/agents.js's orderRoster, on every tick,
// a second, permanent number baked into the name would only disagree with
// that one the moment anything else started or stopped. "session three" said
// out loud means the panel's own number from here on; a name is now purely a
// label, chosen once and never renumbered.
//
// A kind's own hint beats the task text -- "review" is a better name for a
// review than the first four words of whatever was said about it -- and
// "session" is the fallback when neither survives slugify (a request that was
// entirely filler words, "do the thing").
//
// Pure, and `taken` is passed in rather than read from a roster, because the
// list of names already in use is exactly the kind of thing that should be a
// parameter of a function this easy to test.
export function buildName(spec = {}, taken = []) {
  const wanted = (slugify(spec.hint) || slugify(spec.task) || "session").slice(0, MAX_NAME_CHARS);

  const used = new Set((Array.isArray(taken) ? taken : []).filter((name) => typeof name === "string"));
  if (!used.has(wanted)) return wanted;

  // A collision is far more likely now than it was with a per-repository
  // counter in front of every name: two sessions started for the same kind of
  // work ("fix the tests") in the same repository now want the same bare
  // slug. Suffixing beats reusing: two live sessions with one name makes every
  // later "tell fix-tests to also run the linter" ambiguous, and that command
  // signals a real process.
  for (let n = 2; n <= 99; n += 1) {
    const suffix = `-${n}`;
    const candidate = wanted.slice(0, MAX_NAME_CHARS - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
  return wanted;
}
