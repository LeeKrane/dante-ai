// Cross-session memory: one JSON file, keyed by the directory the server was
// started from. Mirrors lib/builder.js's shape on purpose — pure functions
// that are cheap to unit-test (denyRules, buildSettings there; sanitizePreferences,
// capArtifacts here), impure functions that never throw and degrade to a safe
// default (readSharedSettings there; loadStore/saveStore here).
//
// Mutate-in-place is deliberate, not an oversight: server.js holds one
// long-lived store for the process lifetime. A copy-on-write API would mean
// `memoryStore = touchProject(...)` at every call site, and one forgotten
// reassignment silently drops a preference. touchProject/recordArtifact/
// applyMemoryTag all mutate the store and return it so call sites can chain
// or ignore the return value.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_PATH = join(homedir(), ".config", "jarvis", "memory.json");

// Preference text and the summary are folded back into a system prompt on
// every future turn (see the persona wiring lib/brain.js will grow in Stage
// 3), which makes this store a persistence surface for prompt injection. The
// caps below are a security boundary, not a tidiness knob — do not loosen
// them without re-reading that sentence.
export const MAX_ARTIFACTS_PER_PROJECT = 10; // "what did we build lately" needs a handful, not a history
export const MAX_PREFERENCE_KEYS = 20; // bounds how much standing prose ends up in every future prompt
export const MAX_KEY_CHARS = 40; // a preference key is a short label, not a sentence
export const MAX_VALUE_CHARS = 120; // long enough for a real preference, short enough to bound the prompt
export const MAX_SUMMARY_CHARS = 600; // a couple of sentences, not a transcript (see the guide, 1.3)

// Same character class lib/progress.js:38 strips, redeclared here rather than
// imported (progress.js is a client-facing module with its own reasons to
// change independently). Control characters could forge fake structure the
// next time this text is rendered; bidi overrides could reverse how it reads
// on screen. Both are live risks for text that a model — or a user speaking
// through it — ultimately supplies.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Keys that would reach out of the plain object shape and into the prototype
// chain if ever assigned with bracket notation. Checked by both raw and
// cleaned form, since padding or case is an easy way to smuggle one past a
// naive check ("  __PROTO__  " lowercases and trims right back to it).
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function emptyStore() {
  return { version: 1, projects: {} };
}

function stripUnprintable(value) {
  return String(value).replace(UNPRINTABLE, "");
}

// Shared cleanup for anything that ends up back in a prompt: strip control
// characters first (so they can't survive inside a collapsed whitespace run),
// collapse whitespace so a multi-line injection attempt becomes one line,
// trim, then clip to the caller's cap.
function cleanText(value, maxChars) {
  return stripUnprintable(value).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

// Best-effort load: a parse error, a missing file, a non-object top level, or
// a missing/non-object `projects` all degrade to "no memory" rather than
// crashing startup — same posture as readSharedSettings() in lib/builder.js.
// Never throws.
export function loadStore(path = DEFAULT_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.projects &&
      typeof parsed.projects === "object" &&
      !Array.isArray(parsed.projects)
    ) {
      return parsed;
    }
  } catch {
    // Falls through to the empty store below: absent file, unreadable file,
    // and invalid JSON all land here identically.
  }
  return emptyStore();
}

// Atomic write. The tmp file is a sibling of the target (`${path}.<pid>.tmp`)
// rather than a system tmpdir, because renameSync across filesystems fails
// with EXDEV — a sibling is guaranteed to share a filesystem with the target.
// mode 0o600 because this file can carry standing preferences under the
// user's own $HOME/.config. On any failure the tmp file is removed
// best-effort and the function returns false; it never throws, so a bad
// write never takes the server down mid-turn.
export function saveStore(store, path = DEFAULT_PATH) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Either the write never got far enough to create it, or it's already
      // gone — nothing left to clean up.
    }
    return false;
  }
}

export function getProject(store, cwd) {
  return store?.projects?.[cwd] ?? null;
}

// The interesting, pure logic: turns an arbitrary parsed key/value bag (the
// [MEMORY:SET ...] tag's payload, eventually) into text that is safe to keep
// and safe to re-feed to a model forever. Per-entry only — it has no notion
// of "already present" preferences, so the MAX_PREFERENCE_KEYS cap (which
// needs that context to keep updates to existing keys working) is enforced
// by applyMemoryTag, the one caller that has the project in hand.
export function sanitizePreferences(bag) {
  const out = {};
  if (!bag || typeof bag !== "object") return out;

  for (const rawKey of Object.keys(bag)) {
    if (RESERVED_KEYS.has(rawKey)) continue;

    const key = stripUnprintable(rawKey).toLowerCase().trim().slice(0, MAX_KEY_CHARS);
    if (!key || RESERVED_KEYS.has(key)) continue;

    // An empty value is a malformed tag far more often than an intent to
    // forget a preference — there is no deletion verb in v1, so silently
    // dropping it is safer than writing an empty string over a real value.
    const value = cleanText(bag[rawKey], MAX_VALUE_CHARS);
    if (!value) continue;

    out[key] = value;
  }
  return out;
}

// Keeps only the newest entries. Artifacts are always appended in
// chronological order, so "newest" is just "the tail of the array."
export function capArtifacts(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(-MAX_ARTIFACTS_PER_PROJECT);
}

// Mutates store.projects[cwd]; creates the record with defaults when absent.
// Preferences are merged, never replaced, so a patch that only sets
// `sessionId` can never clobber standing preferences. The summary is clipped
// and stripped here (not in sanitizePreferences, which is preference-shaped)
// because it is the same injection surface: this text also gets read back
// into a system prompt on every future turn.
export function touchProject(store, cwd, patch = {}) {
  const existing = store.projects[cwd] ?? {
    sessionId: null,
    summary: "",
    preferences: {},
    artifacts: [],
  };

  const next = { ...existing, ...patch };
  next.preferences = { ...existing.preferences, ...(patch.preferences ?? {}) };
  if (typeof patch.summary === "string") {
    next.summary = stripUnprintable(patch.summary).slice(0, MAX_SUMMARY_CHARS);
  }
  next.updatedAt = new Date().toISOString();

  store.projects[cwd] = next;
  return store;
}

// Mutates store.projects[cwd].artifacts; creates the project record via
// touchProject when absent so recordArtifact never has to duplicate the
// default-shape logic.
export function recordArtifact(store, cwd, entry) {
  if (!store.projects[cwd]) touchProject(store, cwd, {});
  const project = store.projects[cwd];
  project.artifacts = capArtifacts([
    ...(project.artifacts ?? []),
    { ...entry, at: new Date().toISOString() },
  ]);
  return store;
}

// The seam Stage 2's [MEMORY:SET ...] tag calls. Runs the already-parsed
// key/value bag through sanitizePreferences, then enforces MAX_PREFERENCE_KEYS
// against the project's *existing* preference count: keys already present can
// always be updated (so a standing preference never becomes unstable just
// because the bag happens to arrive after nineteen others), but a new key is
// refused once the cap is reached. Mutates the store via touchProject when
// anything survives. Returns the subset actually saved, or null when nothing
// survived sanitization or the cap — so the caller (eventually brain.js) can
// stay quiet instead of narrating a no-op.
export function applyMemoryTag(store, cwd, memory) {
  const cleaned = sanitizePreferences(memory);
  if (Object.keys(cleaned).length === 0) return null;

  const existing = getProject(store, cwd)?.preferences ?? {};
  let keyCount = Object.keys(existing).length;

  const toSave = {};
  for (const [key, value] of Object.entries(cleaned)) {
    // hasOwnProperty, not `key in existing`: `in` walks the prototype chain,
    // so an inherited name would read as "already present" and slip past the
    // new-key cap.
    const isNew = !Object.prototype.hasOwnProperty.call(existing, key);
    if (isNew) {
      if (keyCount >= MAX_PREFERENCE_KEYS) continue;
      keyCount += 1;
    }
    toSave[key] = value;
  }

  if (Object.keys(toSave).length === 0) return null;

  touchProject(store, cwd, { preferences: toSave });
  return toSave;
}
