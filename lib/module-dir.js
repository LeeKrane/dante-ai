// The shared mechanism behind lib/registry.js and lib/sessions.js: both load
// every *.mjs in a directory into a Map keyed by an id that must match the
// filename. This module knows nothing about primitives or session kinds —
// `validate` and `withDefaults` are handed in by the caller, which is what
// keeps this file a leaf with no dependency on either shape.

import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function fail(sourceName, message) {
  throw new Error(`${sourceName}: ${message}`);
}

// A directory URL MUST end in a slash. Without one, resolving "poster.mjs"
// against it lands in the PARENT directory - which silently loads a different
// file of the same name if one happens to exist there.
function asDirUrl(url, label) {
  if (url.protocol !== "file:") {
    fail(label, `directory must be a file: URL (got "${url.protocol}")`);
  }
  if (url.pathname.endsWith("/")) return url;
  const withSlash = new URL(url.href);
  withSlash.pathname += "/";
  return withSlash;
}

function toDirUrl(dirUrl, label) {
  if (dirUrl instanceof URL) return asDirUrl(dirUrl, label);
  if (typeof dirUrl !== "string" || dirUrl.trim() === "") {
    // Guessing here would scan the filesystem root and return an empty registry,
    // which reads as "no primitives exist" instead of "you passed a bad path".
    fail(label, "directory must be a non-empty path string or a file: URL");
  }
  if (dirUrl.startsWith("file:")) return asDirUrl(new URL(dirUrl), label);
  // A plain path, resolved against process.cwd() when relative.
  return pathToFileURL(dirUrl.replace(/\/+$/, "") + "/");
}

// Loads every *.mjs in dirUrl into a Map keyed by id, validating and
// defaulting each one with the caller-supplied `validate` and `withDefaults`.
// Files starting with "_" are skipped, which is what makes _template.mjs a
// copyable example rather than a live entry. Dotfiles are skipped too, so
// macOS AppleDouble junk (._poster.mjs) can't crash a fresh clone.
export async function loadModuleDir(dirUrl, { label, dirNoun, itemNoun, validate, withDefaults, optional = false }) {
  const dir = toDirUrl(dirUrl, label);
  const dirPath = fileURLToPath(dir);
  const map = new Map();

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Some directories (sessions/) are allowed not to exist: free-form is the
    // default path there, and a clone with none of them is a working clone.
    if (optional && err.code === "ENOENT") return map;
    throw new Error(`${label}: cannot read ${dirNoun} (${err.message})`, { cause: err });
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
      // entry is the likeliest one of all, so it should not be the
      // exception that surfaces bare.
      throw new Error(`${file}: could not be imported (${err.message})`, { cause: err });
    }

    const value = mod.default;
    if (value === undefined) {
      fail(file, `missing a default export (${itemNoun} must \`export default { ... }\`)`);
    }

    validate(value, file);

    // The filename is the id people see in the repo, so drift between the two
    // would make an entry impossible to find by name.
    const expectedId = basename(file, ".mjs");
    if (value.id !== expectedId) {
      fail(file, `"id" is "${value.id}" but must match the filename ("${expectedId}")`);
    }
    if (map.has(value.id)) fail(file, `duplicate id "${value.id}"`);

    map.set(value.id, withDefaults(value));
  }

  return map;
}
