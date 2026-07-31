import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Primitives live next to lib/ so a fresh clone works with no configuration.
const DEFAULT_DIR = new URL("../primitives/", import.meta.url);

// Optional fields every primitive gets whether or not it declares them, so
// callers can read `p.triggers` / `p.questions` / `p.mcp` without guarding.
const OPTIONAL_ARRAY_FIELDS = ["triggers", "questions", "mcp"];

// Arrays whose entries must each be a non-empty string, and the noun to use
// when telling someone which entry is wrong.
const STRING_ARRAY_LABELS = {
  allowedTools: "tool name",
  triggers: "trigger phrase",
  mcp: "MCP server name",
};

function fail(sourceName, message) {
  throw new Error(`${sourceName}: ${message}`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Throws a message naming the file and the field, so a stranger adding their
// own primitive is told exactly what to fix. Returns true when valid.
export function validatePrimitive(p, sourceName = "primitive") {
  if (!isPlainObject(p)) fail(sourceName, "default export must be a primitive config object");

  if (typeof p.id !== "string" || p.id.trim() === "") {
    fail(sourceName, '"id" must be a non-empty string');
  }
  if (typeof p.systemPrompt !== "function") {
    fail(sourceName, '"systemPrompt" must be a function taking the answers and returning a string');
  }
  if (!Array.isArray(p.allowedTools)) {
    fail(sourceName, '"allowedTools" must be an array of tool names');
  }
  if (typeof p.outputContract !== "string" || p.outputContract.trim() === "") {
    fail(sourceName, '"outputContract" must be a non-empty file path');
  }
  if (typeof p.doneLine !== "function") {
    fail(sourceName, '"doneLine" must be a function returning the spoken completion line');
  }
  if (typeof p.timeoutMs !== "number" || !Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0) {
    fail(sourceName, '"timeoutMs" must be a positive number of milliseconds');
  }

  for (const field of OPTIONAL_ARRAY_FIELDS) {
    if (p[field] !== undefined && !Array.isArray(p[field])) {
      fail(sourceName, `"${field}" must be an array when present`);
    }
  }

  // Every entry has to be a usable string. `allowedTools` and `mcp` are handed
  // straight to the build's command line, where a stray number or object would
  // become the literal argv token "42" or "[object Object]" - a silently wrong
  // tool grant rather than a loud error.
  for (const [field, label] of Object.entries(STRING_ARRAY_LABELS)) {
    for (const [i, value] of (p[field] ?? []).entries()) {
      if (typeof value !== "string" || value.trim() === "") {
        fail(sourceName, `"${field}[${i}]" must be a non-empty ${label}`);
      }
    }
  }

  const seenKeys = new Set();
  for (const [i, q] of (p.questions ?? []).entries()) {
    if (!isPlainObject(q)) fail(sourceName, `"questions[${i}]" must be an object`);
    if (typeof q.key !== "string" || q.key.trim() === "") {
      fail(sourceName, `"questions[${i}].key" must be a non-empty string`);
    }
    if (typeof q.ask !== "string" || q.ask.trim() === "") {
      fail(sourceName, `"questions[${i}].ask" must be a non-empty question to speak`);
    }
    // Answers are collected into one object keyed by `key`, so a repeat would
    // overwrite the earlier answer and one spoken question would be wasted.
    if (seenKeys.has(q.key)) {
      fail(sourceName, `"questions[${i}].key" repeats "${q.key}"; each question needs its own key`);
    }
    seenKeys.add(q.key);
  }

  return true;
}

function withDefaults(p) {
  return {
    ...p,
    // Copied, not aliased: the module cache hands back the same object on every
    // import, so a caller pushing to `triggers` would corrupt every later load.
    triggers: [...(p.triggers ?? [])],
    questions: (p.questions ?? []).map((q) => ({ ...q })),
    mcp: [...(p.mcp ?? [])],
  };
}

// A directory URL MUST end in a slash. Without one, resolving "poster.mjs"
// against it lands in the PARENT directory - which silently loads a different
// file of the same name if one happens to exist there.
function asDirUrl(url) {
  if (url.protocol !== "file:") {
    fail("loadRegistry", `directory must be a file: URL (got "${url.protocol}")`);
  }
  if (url.pathname.endsWith("/")) return url;
  const withSlash = new URL(url.href);
  withSlash.pathname += "/";
  return withSlash;
}

function toDirUrl(dirUrl) {
  if (dirUrl instanceof URL) return asDirUrl(dirUrl);
  if (typeof dirUrl !== "string" || dirUrl.trim() === "") {
    // Guessing here would scan the filesystem root and return an empty registry,
    // which reads as "no primitives exist" instead of "you passed a bad path".
    fail("loadRegistry", "directory must be a non-empty path string or a file: URL");
  }
  if (dirUrl.startsWith("file:")) return asDirUrl(new URL(dirUrl));
  // A plain path, resolved against process.cwd() when relative.
  return pathToFileURL(dirUrl.replace(/\/+$/, "") + "/");
}

// Loads every *.mjs in the directory into a Map keyed by primitive id.
// Files starting with "_" are skipped, which is what makes _template.mjs a
// copyable example rather than a live primitive. Dotfiles are skipped too, so
// macOS AppleDouble junk (._landing-page.mjs) can't crash a fresh clone.
export async function loadRegistry(dirUrl = DEFAULT_DIR) {
  const dir = toDirUrl(dirUrl);
  const dirPath = fileURLToPath(dir);
  const registry = new Map();

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`loadRegistry: cannot read primitives directory (${err.message})`, { cause: err });
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
      // Every other failure here names the file; a typo in a brand-new
      // primitive is the likeliest one of all, so it should not be the
      // exception that surfaces bare.
      throw new Error(`${file}: could not be imported (${err.message})`, { cause: err });
    }

    const p = mod.default;
    if (p === undefined) {
      fail(file, "missing a default export (a primitive must `export default { ... }`)");
    }

    validatePrimitive(p, file);

    // The filename is the id people see in the repo, so drift between the two
    // would make a primitive impossible to find by name.
    const expectedId = basename(file, ".mjs");
    if (p.id !== expectedId) {
      fail(file, `"id" is "${p.id}" but must match the filename ("${expectedId}")`);
    }
    if (registry.has(p.id)) fail(file, `duplicate id "${p.id}"`);

    registry.set(p.id, withDefaults(p));
  }

  return registry;
}
