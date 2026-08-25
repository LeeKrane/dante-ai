import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, chmodSync, symlinkSync, realpathSync } from "node:fs";
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
  MAX_WORKSPACES,
  WORKSPACE_PREFIX,
  addWorkspace,
  aliasFromPath,
  applyWorkspaceTag,
  getWorkspace,
  getWorkspaces,
  nextSessionNumber,
  resolveWorkspacePath,
  sanitizeAlias,
  workspacePaths,
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

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------
//
// A whole fake $HOME in a temp directory, because the check under test is
// "genuinely inside the home directory once every symlink has been followed"
// and there is no way to test that against a home nobody owns. realpathSync on
// the way in because macOS hands out /var/folders paths that are themselves a
// symlink to /private/var.

function fakeHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "jarvis-home-")));
  mkdirSync(join(home, "development", "jarvis"), { recursive: true });
  mkdirSync(join(home, "development", "KraneticFitness"), { recursive: true });
  return home;
}

test("an alias is narrowed to something a person can say out loud", () => {
  assert.equal(sanitizeAlias("Jarvis"), "jarvis");
  assert.equal(sanitizeAlias("Kranetic Fitness"), "kranetic-fitness");
  assert.equal(sanitizeAlias("my_repo.v2"), "my-repo-v2");
  assert.equal(sanitizeAlias("  --weird--  "), "weird");
  assert.equal(sanitizeAlias("x".repeat(200)).length, 40);
});

test("an alias that is not an alias at all is refused rather than guessed at", () => {
  for (const bad of ["", "   ", "!!!", "---", "__proto__", "constructor", null, undefined, 42]) {
    assert.equal(sanitizeAlias(bad), "", JSON.stringify(bad));
  }
});

test("a directory names itself when nobody chose an alias", () => {
  assert.equal(aliasFromPath("/home/krane/development/KraneticFitness"), "kraneticfitness");
  assert.equal(aliasFromPath(42), "");
});

test("a real directory inside the home directory is a workspace", () => {
  const home = fakeHome();
  try {
    const repo = join(home, "development", "jarvis");
    assert.equal(resolveWorkspacePath(repo, { home }), repo);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a path outside the home directory is never a workspace", () => {
  // This string becomes the working directory of a real Claude Code session
  // with file tools on. It is the one value in this file that is not merely
  // prompt text.
  const home = fakeHome();
  try {
    assert.equal(resolveWorkspacePath("/etc", { home }), null);
    assert.equal(resolveWorkspacePath("/", { home }), null);
    // The home directory itself is every repository at once, and "start a
    // session in home" is not a request anyone means to make by voice.
    assert.equal(resolveWorkspacePath(home, { home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a symlink out of the home directory does not smuggle a path back in", () => {
  // The reason this check is realpathSync and not a string comparison: the
  // link's own path starts with $HOME and would pass any prefix test, while
  // the session would have run in /etc.
  const home = fakeHome();
  try {
    const escape = join(home, "escape");
    symlinkSync("/etc", escape);
    assert.equal(resolveWorkspacePath(escape, { home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a file, a missing path and a path with a NUL are all refused", () => {
  const home = fakeHome();
  try {
    const file = join(home, "notes.txt");
    writeFileSync(file, "hello");
    assert.equal(resolveWorkspacePath(file, { home }), null);
    assert.equal(resolveWorkspacePath(join(home, "nope"), { home }), null);
    assert.equal(resolveWorkspacePath(join(home, "development") + "\0/jarvis", { home }), null);
    for (const bad of ["", "   ", null, undefined, 42, {}]) {
      assert.equal(resolveWorkspacePath(bad, { home }), null, JSON.stringify(bad));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("registering a repository gives it an alias and a counter", () => {
  const home = fakeHome();
  try {
    const store = emptyStore();
    const added = addWorkspace(store, join(home, "development", "jarvis"), null, { home });
    assert.equal(added.alias, "jarvis");
    assert.equal(added.path, join(home, "development", "jarvis"));
    assert.equal(added.counter, 0);
    assert.deepEqual(workspacePaths(store), { jarvis: join(home, "development", "jarvis") });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("registering the same repository twice does not accumulate aliases", () => {
  // The server registers its own cwd at every startup. Without this, a week of
  // restarts leaves jarvis, jarvis-2, jarvis-3 and a counter that resets.
  const home = fakeHome();
  try {
    const store = emptyStore();
    const repo = join(home, "development", "jarvis");
    const first = addWorkspace(store, repo, null, { home });
    nextSessionNumber(store, "jarvis");
    const second = addWorkspace(store, repo, "something-else", { home });
    assert.equal(second.alias, first.alias);
    assert.equal(second.counter, 1, "the counter must survive a re-registration");
    assert.equal(Object.keys(getWorkspaces(store)).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("two repositories with the same basename both get an alias", () => {
  const home = fakeHome();
  try {
    mkdirSync(join(home, "old", "jarvis"), { recursive: true });
    const store = emptyStore();
    assert.equal(addWorkspace(store, join(home, "development", "jarvis"), null, { home }).alias, "jarvis");
    assert.equal(addWorkspace(store, join(home, "old", "jarvis"), null, { home }).alias, "jarvis-2");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a chosen alias beats the directory basename", () => {
  const home = fakeHome();
  try {
    const store = emptyStore();
    const added = addWorkspace(store, join(home, "development", "KraneticFitness"), "Fitness", { home });
    assert.equal(added.alias, "fitness");
    assert.ok(getWorkspace(store, "fitness"));
    assert.equal(getWorkspace(store, "nope"), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a path that is not a workspace is never registered as one", () => {
  const home = fakeHome();
  try {
    const store = emptyStore();
    assert.equal(addWorkspace(store, "/etc", "etc", { home }), null);
    assert.deepEqual(getWorkspaces(store), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the number of remembered repositories is capped", () => {
  const home = fakeHome();
  try {
    const store = emptyStore();
    for (let i = 0; i < MAX_WORKSPACES + 3; i += 1) {
      const dir = join(home, `repo-${i}`);
      mkdirSync(dir, { recursive: true });
      addWorkspace(store, dir, null, { home });
    }
    assert.equal(Object.keys(getWorkspaces(store)).length, MAX_WORKSPACES);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("session numbers count per repository, so jarvis one and fitness one are both sayable", () => {
  const home = fakeHome();
  try {
    const store = emptyStore();
    addWorkspace(store, join(home, "development", "jarvis"), null, { home });
    addWorkspace(store, join(home, "development", "KraneticFitness"), "fitness", { home });

    assert.equal(nextSessionNumber(store, "jarvis"), 1);
    assert.equal(nextSessionNumber(store, "jarvis"), 2);
    assert.equal(nextSessionNumber(store, "fitness"), 1);
    assert.equal(nextSessionNumber(store, "nobody"), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a counter corrupted on disk starts over rather than producing a session named NaN", () => {
  const store = emptyStore();
  store.workspaces = { jarvis: { path: "/somewhere", counter: "seven" } };
  assert.equal(nextSessionNumber(store, "jarvis"), 1);
});

test("a store written before workspaces existed still reads", () => {
  assert.deepEqual(getWorkspaces({ version: 1, projects: {} }), {});
  assert.deepEqual(getWorkspaces(null), {});
  assert.deepEqual(workspacePaths({ workspaces: { a: "not an object", b: { counter: 1 } } }), {});
});

test("a spoken workspace tag registers the repository", () => {
  const home = fakeHome();
  try {
    const store = emptyStore();
    const saved = applyWorkspaceTag(
      store,
      { [`${WORKSPACE_PREFIX}fitness`]: join(home, "development", "KraneticFitness") },
      { home },
    );
    assert.deepEqual(saved, { fitness: join(home, "development", "KraneticFitness") });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a workspace tag naming somewhere unreachable saves nothing and says nothing", () => {
  const home = fakeHome();
  try {
    const store = emptyStore();
    assert.equal(applyWorkspaceTag(store, { [`${WORKSPACE_PREFIX}etc`]: "/etc" }, { home }), null);
    assert.equal(applyWorkspaceTag(store, { [WORKSPACE_PREFIX]: "/etc" }, { home }), null);
    assert.equal(applyWorkspaceTag(store, { palette: "dark" }, { home }), null);
    assert.equal(applyWorkspaceTag(store, null, { home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a workspace pair is never stored as a standing preference", () => {
  // It is a path, and a preference is folded into every future prompt. Storing
  // one there would be useless prose and a directory disclosed on every turn.
  const store = emptyStore();
  const saved = applyMemoryTag(store, "/cwd", {
    [`${WORKSPACE_PREFIX}fitness`]: "/home/you/dev/KraneticFitness",
    palette: "dark",
  });
  assert.deepEqual(saved, { palette: "dark" });
});

test("workspaces survive a save and a load", () => {
  const home = fakeHome();
  try {
    const path = join(home, "memory.json");
    const store = emptyStore();
    addWorkspace(store, join(home, "development", "jarvis"), null, { home });
    nextSessionNumber(store, "jarvis");
    assert.equal(saveStore(store, path), true);

    const reloaded = loadStore(path);
    assert.equal(getWorkspace(reloaded, "jarvis").counter, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a path someone dictated with a tilde still resolves", () => {
  // No shell is involved anywhere on this path, so nothing else would expand
  // it — and "~/development/jarvis" is exactly what a person says out loud.
  const home = fakeHome();
  try {
    assert.equal(
      resolveWorkspacePath("~/development/jarvis", { home }),
      join(home, "development", "jarvis"),
    );
    // A bare tilde is the home directory, which is still not a workspace.
    assert.equal(resolveWorkspacePath("~", { home }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
