import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyStore,
  loadStore,
  saveStore,
  getProject,
  touchProject,
  recordArtifact,
  applyMemoryTag,
  sanitizePreferences,
  capArtifacts,
  MAX_ARTIFACTS_PER_PROJECT,
  MAX_PREFERENCE_KEYS,
  MAX_KEY_CHARS,
  MAX_VALUE_CHARS,
  MAX_SUMMARY_CHARS,
} from "../lib/memory.js";

// loadStore/saveStore are the only impure functions here; everything else is
// tested as plain data in/data out, the same way test/builder.test.js tests
// denyRules/buildSettings. Every disk-touching test gets its own temp dir via
// mkdtempSync and cleans up in a try/finally, so nothing here ever reads or
// writes the real ~/.config/jarvis/memory.json.

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-memory-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- loadStore --------------------------------------------------------

test("a corrupt memory.json degrades to an empty store rather than throwing", () => {
  withTempDir((dir) => {
    const path = join(dir, "memory.json");
    writeFileSync(path, "{ not valid json");
    assert.deepEqual(loadStore(path), emptyStore());
  });
});

test("an absent memory.json degrades to an empty store rather than throwing", () => {
  withTempDir((dir) => {
    const path = join(dir, "does-not-exist", "memory.json");
    assert.deepEqual(loadStore(path), emptyStore());
  });
});

test("a JSON file that is not an object degrades to an empty store", () => {
  withTempDir((dir) => {
    const path = join(dir, "memory.json");
    writeFileSync(path, JSON.stringify(["not", "an", "object"]));
    assert.deepEqual(loadStore(path), emptyStore());
  });
});

test("a store missing the projects field degrades to an empty store", () => {
  withTempDir((dir) => {
    const path = join(dir, "memory.json");
    writeFileSync(path, JSON.stringify({ version: 1 }));
    assert.deepEqual(loadStore(path), emptyStore());
  });
});

test("a store whose projects field is not an object degrades to an empty store", () => {
  withTempDir((dir) => {
    const path = join(dir, "memory.json");
    writeFileSync(path, JSON.stringify({ version: 1, projects: "nope" }));
    assert.deepEqual(loadStore(path), emptyStore());
  });
});

test("a well-formed store loads back unchanged", () => {
  withTempDir((dir) => {
    const path = join(dir, "memory.json");
    const store = { version: 1, projects: { "/p": { sessionId: "abc", summary: "", preferences: {}, artifacts: [] } } };
    writeFileSync(path, JSON.stringify(store));
    assert.deepEqual(loadStore(path), store);
  });
});

// --- saveStore --------------------------------------------------------

test("a save/load round-trip returns exactly what was saved", () => {
  withTempDir((dir) => {
    const path = join(dir, "nested", "memory.json");
    let store = emptyStore();
    store = touchProject(store, "/p", { sessionId: "abc123" });
    assert.equal(saveStore(store, path), true);
    assert.deepEqual(loadStore(path), store);
  });
});

test("a successful save leaves no temp file behind", () => {
  withTempDir((dir) => {
    const path = join(dir, "memory.json");
    assert.equal(saveStore(emptyStore(), path), true);
    assert.deepEqual(readdirSync(dir), ["memory.json"]);
  });
});

test("a save whose directory cannot be created returns false and leaves no temp file", () => {
  withTempDir((dir) => {
    // A file where a directory needs to go: mkdirSync(dirname(path)) fails
    // with ENOTDIR, before any tmp file is ever written.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "i am a file, not a directory");
    const path = join(blocker, "sub", "memory.json");

    assert.equal(saveStore(emptyStore(), path), false);
    assert.deepEqual(readdirSync(dir), ["blocker"]);
  });
});

test("a save to a read-only directory returns false and leaves no temp file", () => {
  // Skipped when running as root: permission bits don't block root's writes
  // (common in containers/CI), and the ENOTDIR case above already exercises
  // the "failed write" path deterministically regardless of user.
  if (process.getuid && process.getuid() === 0) return;

  withTempDir((dir) => {
    const readOnlyDir = join(dir, "locked");
    mkdirSync(readOnlyDir);
    chmodSync(readOnlyDir, 0o500);
    const path = join(readOnlyDir, "memory.json");
    try {
      assert.equal(saveStore(emptyStore(), path), false);
      assert.equal(existsSync(path), false);
    } finally {
      chmodSync(readOnlyDir, 0o700);
    }
  });
});

// --- getProject ---------------------------------------------------------

test("getProject returns null for a project that was never touched", () => {
  assert.equal(getProject(emptyStore(), "/never-seen"), null);
});

// --- touchProject ---------------------------------------------------------

test("touchProject creates a project record with defaults when absent", () => {
  const store = touchProject(emptyStore(), "/p", { sessionId: "abc" });
  const project = getProject(store, "/p");
  assert.equal(project.sessionId, "abc");
  assert.equal(project.summary, "");
  assert.deepEqual(project.preferences, {});
  assert.deepEqual(project.artifacts, []);
  assert.equal(typeof project.updatedAt, "string");
  assert.equal(new Date(project.updatedAt).toISOString(), project.updatedAt);
});

test("touchProject merges preferences across two calls instead of replacing them", () => {
  let store = emptyStore();
  store = touchProject(store, "/p", { preferences: { palette: "dark" } });
  store = touchProject(store, "/p", { preferences: { tone: "warm" } });
  assert.deepEqual(getProject(store, "/p").preferences, { palette: "dark", tone: "warm" });
});

test("touchProject clips the summary to MAX_SUMMARY_CHARS", () => {
  const store = touchProject(emptyStore(), "/p", { summary: "x".repeat(MAX_SUMMARY_CHARS + 50) });
  assert.equal(getProject(store, "/p").summary.length, MAX_SUMMARY_CHARS);
});

test("touchProject strips unprintable control characters from the summary", () => {
  const store = touchProject(emptyStore(), "/p", { summary: "hello\u0007\u200eworld" });
  assert.equal(getProject(store, "/p").summary, "helloworld");
});

test("touchProject mutates the store it is given rather than copying it", () => {
  const store = emptyStore();
  const returned = touchProject(store, "/p", { sessionId: "abc" });
  assert.equal(returned, store);
  assert.equal(getProject(store, "/p").sessionId, "abc");
});

// --- recordArtifact ---------------------------------------------------------

test("recordArtifact appends an artifact stamped with the current time", () => {
  const store = touchProject(emptyStore(), "/p", {});
  recordArtifact(store, "/p", { primitive: "landing-page", dir: "builds/1" });
  const [artifact] = getProject(store, "/p").artifacts;
  assert.equal(artifact.primitive, "landing-page");
  assert.equal(artifact.dir, "builds/1");
  assert.equal(typeof artifact.at, "string");
});

test("recordArtifact creates the project record when it does not already exist", () => {
  const store = emptyStore();
  recordArtifact(store, "/p", { primitive: "landing-page" });
  assert.ok(getProject(store, "/p"));
  assert.equal(getProject(store, "/p").artifacts.length, 1);
});

test("recordArtifact caps the list at MAX_ARTIFACTS_PER_PROJECT, keeping the newest", () => {
  const store = touchProject(emptyStore(), "/p", {});
  for (let i = 0; i < MAX_ARTIFACTS_PER_PROJECT + 5; i++) {
    recordArtifact(store, "/p", { n: i });
  }
  const artifacts = getProject(store, "/p").artifacts;
  assert.equal(artifacts.length, MAX_ARTIFACTS_PER_PROJECT);
  assert.deepEqual(
    artifacts.map((a) => a.n),
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
});

// --- capArtifacts (pure) ---------------------------------------------------

test("capArtifacts keeps only the newest MAX_ARTIFACTS_PER_PROJECT entries", () => {
  const list = Array.from({ length: MAX_ARTIFACTS_PER_PROJECT + 3 }, (_, i) => ({ n: i }));
  const capped = capArtifacts(list);
  assert.equal(capped.length, MAX_ARTIFACTS_PER_PROJECT);
  assert.equal(capped[0].n, 3);
  assert.equal(capped.at(-1).n, list.length - 1);
});

test("capArtifacts treats a non-array as empty", () => {
  assert.deepEqual(capArtifacts(null), []);
  assert.deepEqual(capArtifacts(undefined), []);
});

// --- sanitizePreferences (pure) --------------------------------------------

test("sanitizePreferences lowercases, trims and clips keys", () => {
  const out = sanitizePreferences({ "  Palette  ": "dark" });
  assert.deepEqual(out, { palette: "dark" });
});

test("sanitizePreferences clips a key to MAX_KEY_CHARS", () => {
  const longKey = "k".repeat(MAX_KEY_CHARS + 20);
  const out = sanitizePreferences({ [longKey]: "v" });
  const [key] = Object.keys(out);
  assert.equal(key.length, MAX_KEY_CHARS);
});

test("sanitizePreferences collapses runs of whitespace in a value to one space", () => {
  const out = sanitizePreferences({ tone: "  confident,   understated  " });
  assert.deepEqual(out, { tone: "confident, understated" });
});

test("sanitizePreferences clips a value to MAX_VALUE_CHARS", () => {
  const longValue = "v".repeat(MAX_VALUE_CHARS + 20);
  const out = sanitizePreferences({ k: longValue });
  assert.equal(out.k.length, MAX_VALUE_CHARS);
});

test("sanitizePreferences drops entries whose value is empty after cleaning", () => {
  const out = sanitizePreferences({ palette: "", tone: "   ", real: "kept" });
  assert.deepEqual(out, { real: "kept" });
});

test("sanitizePreferences strips unprintable control characters from keys and values", () => {
  const out = sanitizePreferences({ "pal\u0007ette": "da\u200erk" });
  assert.deepEqual(out, { palette: "dark" });
});

test("sanitizePreferences skips __proto__, constructor and prototype outright", () => {
  const bag = JSON.parse('{"__proto__": "evil", "constructor": "evil", "prototype": "evil", "real": "kept"}');
  const out = sanitizePreferences(bag);
  assert.deepEqual(out, { real: "kept" });
});

test("sanitizePreferences skips a reserved key even after padding and case changes are cleaned off", () => {
  const out = sanitizePreferences({ "  __PROTO__  ": "evil", real: "kept" });
  assert.deepEqual(out, { real: "kept" });
});

test("sanitizePreferences never lets __proto__ reach the real prototype chain", () => {
  const bag = JSON.parse('{"__proto__": {"polluted": true}}');
  const out = sanitizePreferences(bag);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(out, {});
});

test("sanitizePreferences returns an empty object for a non-object bag", () => {
  assert.deepEqual(sanitizePreferences(null), {});
  assert.deepEqual(sanitizePreferences(undefined), {});
  assert.deepEqual(sanitizePreferences("nope"), {});
});

// --- applyMemoryTag ---------------------------------------------------------

test("applyMemoryTag returns null when nothing survives sanitization", () => {
  const store = emptyStore();
  const result = applyMemoryTag(store, "/p", { palette: "", "__proto__": "evil" });
  assert.equal(result, null);
  assert.equal(getProject(store, "/p"), null);
});

test("applyMemoryTag returns the saved subset and merges it into the project", () => {
  const store = emptyStore();
  const result = applyMemoryTag(store, "/p", { palette: "dark", tone: "confident" });
  assert.deepEqual(result, { palette: "dark", tone: "confident" });
  assert.deepEqual(getProject(store, "/p").preferences, { palette: "dark", tone: "confident" });
});

test("applyMemoryTag stops adding new keys once MAX_PREFERENCE_KEYS is reached", () => {
  let store = emptyStore();
  const full = {};
  for (let i = 0; i < MAX_PREFERENCE_KEYS; i++) full[`k${i}`] = `v${i}`;
  store = touchProject(store, "/p", { preferences: full });

  const result = applyMemoryTag(store, "/p", { newkey: "should not fit" });
  assert.equal(result, null);
  assert.equal(Object.keys(getProject(store, "/p").preferences).length, MAX_PREFERENCE_KEYS);
});

test("applyMemoryTag still allows updates to a key already present once the cap is reached", () => {
  let store = emptyStore();
  const full = {};
  for (let i = 0; i < MAX_PREFERENCE_KEYS; i++) full[`k${i}`] = `v${i}`;
  store = touchProject(store, "/p", { preferences: full });

  const result = applyMemoryTag(store, "/p", { k5: "updated" });
  assert.deepEqual(result, { k5: "updated" });
  assert.equal(getProject(store, "/p").preferences.k5, "updated");
  assert.equal(Object.keys(getProject(store, "/p").preferences).length, MAX_PREFERENCE_KEYS);
});

test("applyMemoryTag saves the keys that fit and drops only the ones past the cap in one call", () => {
  let store = emptyStore();
  const full = {};
  for (let i = 0; i < MAX_PREFERENCE_KEYS - 1; i++) full[`k${i}`] = `v${i}`;
  store = touchProject(store, "/p", { preferences: full });

  // One update to an existing key, plus two brand-new keys with only one slot free.
  const result = applyMemoryTag(store, "/p", { k0: "updated", newa: "a", newb: "b" });
  assert.equal(Object.keys(getProject(store, "/p").preferences).length, MAX_PREFERENCE_KEYS);
  assert.equal(getProject(store, "/p").preferences.k0, "updated");
  assert.deepEqual(result, { k0: "updated", newa: "a" });
});
