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

import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
export const MAX_NAME_WORDS = 4;

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

  return true;
}

function withDefaults(kind) {
  return {
    ...kind,
    // Copied, not aliased: the module cache hands back the same object on every
    // import, so a caller pushing to `triggers` would corrupt every later load.
    triggers: [...(kind.triggers ?? [])],
  };
}

// A directory URL MUST end in a slash. Without one, resolving "review.mjs"
// against it lands in the PARENT directory — which silently loads a different
// file of the same name if one happens to exist there.
function asDirUrl(url) {
  if (url.protocol !== "file:") {
    fail("loadSessionKinds", `directory must be a file: URL (got "${url.protocol}")`);
  }
  if (url.pathname.endsWith("/")) return url;
  const withSlash = new URL(url.href);
  withSlash.pathname += "/";
  return withSlash;
}

function toDirUrl(dirUrl) {
  if (dirUrl instanceof URL) return asDirUrl(dirUrl);
  if (typeof dirUrl !== "string" || dirUrl.trim() === "") {
    fail("loadSessionKinds", "directory must be a non-empty path string or a file: URL");
  }
  if (dirUrl.startsWith("file:")) return asDirUrl(new URL(dirUrl));
  return pathToFileURL(dirUrl.replace(/\/+$/, "") + "/");
}

// Loads every *.mjs in the directory into a Map keyed by session kind id.
// Files starting with "_" are skipped, which is what makes _template.mjs a
// copyable example rather than a live kind. Dotfiles are skipped too, so macOS
// AppleDouble junk can't crash a fresh clone.
//
// Read once at startup, for the same reason the primitive registry is: a
// half-saved edit must not break a live conversation.
export async function loadSessionKinds(dirUrl = DEFAULT_DIR) {
  const dir = toDirUrl(dirUrl);
  const dirPath = fileURLToPath(dir);
  const kinds = new Map();

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Unlike primitives/, this directory is allowed not to exist: free-form is
    // the default path and a clone with no session kinds is a working clone.
    if (err.code === "ENOENT") return kinds;
    throw new Error(`loadSessionKinds: cannot read sessions directory (${err.message})`, { cause: err });
  }

  const files = entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => extname(name) === ".mjs" && !name.startsWith("_") && !name.startsWith("."))
    .sort();

  for (const file of files) {
    let mod;
    try {
      // Built from the path, not `new URL(file, dir)`: a filename containing
      // "#" or "?" would be read as a fragment or query, and "%" throws.
      mod = await import(pathToFileURL(join(dirPath, file)).href);
    } catch (err) {
      throw new Error(`${file}: could not be imported (${err.message})`, { cause: err });
    }

    const kind = mod.default;
    if (kind === undefined) {
      fail(file, "missing a default export (a session kind must `export default { ... }`)");
    }

    validateSessionKind(kind, file);

    // The filename is the id people see in the repo, so drift between the two
    // would make a kind impossible to find by name.
    const expectedId = basename(file, ".mjs");
    if (kind.id !== expectedId) {
      fail(file, `"id" is "${kind.id}" but must match the filename ("${expectedId}")`);
    }
    if (kinds.has(kind.id)) fail(file, `duplicate id "${kind.id}"`);

    kinds.set(kind.id, withDefaults(kind));
  }

  return kinds;
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
