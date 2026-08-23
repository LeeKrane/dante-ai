# Jarvis: Memory Layer + Multi-Step Orchestration — Implementation Guide

## 0. What these two features unlock

Today: `ask(text, sessionId)` in `lib/brain.js` remembers only within a page load (Claude Code's own `--resume sessionId`, held in a `Map` in `server.js`, dies on refresh). Every build in `lib/builder.js` is one `claude -p` invocation in a fresh directory, with no relationship to any other build.

Add both features and you get:
- "What did we build yesterday?" — memory layer persists session id + summary + a per-project preference blob, keyed by working directory, reloaded on connect.
- "You always want dark palettes" — sticks because it's read into the persona before the first turn, not because the model remembers it (it can't, across processes).
- "Build me a marketing site" as *plan → build pages → build nav → verify links* — orchestration turns one `[ACTION:BUILD]` tag into a DAG of sub-builds, each with the previous step's artifact folder available to it.

Neither feature touches the conversation layer's wire format (`{reply, action?}` from `brain.js`, `{ok, dir, artifact, result, log, timedOut}` from `builder.js`) — that's what makes them additive rather than a rewrite.

---

## 1. Memory Layer

### 1.1 Where it goes

New file: `lib/memory.js`. Two call sites change: `server.js` (load on connect, save on close/after each turn) and `lib/brain.js` (accept prior context, fold it into the persona).

### 1.2 Storage choice: JSON file, not SQLite

For this app's actual write pattern — one process, low write volume, no concurrent writers to the same key — a single JSON file beats SQLite: zero new dependency (README brags "one npm dependency"), human-readable/editable, trivial to `git ignore`. Move to SQLite only if you outgrow "one file, read-modify-write" (e.g. want to query across projects, or expect concurrent server instances).

```
~/.config/jarvis/memory.json
```

Not inside the repo — same reasoning as `~/.config/fish-audio/speak.json`: it's user state, not project state, and the repo's own `deniedDirs()` in `builder.js` already blocks builds from writing into `~/.config/**`, so this is also *safe from a build ever corrupting it*.

### 1.3 Data shape

Keyed by working directory (the directory the server was started from — `process.cwd()` at boot, not the build's throwaway dir):

```json
{
  "version": 1,
  "projects": {
    "/home/jesse/sites/ember-coffee": {
      "sessionId": "abc123-...",
      "updatedAt": "2026-08-22T19:04:11.000Z",
      "summary": "Built a landing page for Ember, a coffee shop. User asked for a dark, moody palette and asked to redo the hero twice.",
      "preferences": {
        "palette": "dark",
        "tone": "confident, understated"
      },
      "artifacts": [
        { "primitive": "landing-page", "dir": "builds/2026-08-22T19-01-55-000Z", "outputContract": "index.html", "at": "2026-08-22T19:04:00.000Z" }
      ]
    }
  }
}
```

Design choices worth keeping:
- **`summary` is a short human string, not the transcript.** Claude Code's own `--resume` already carries full conversation state *for that process's lifetime*; what dies on restart is just the *session id* pointing at it and any cross-session narrative. Don't try to reconstruct a transcript — regenerate a summary (see 1.5) and let the model work from that plus a fresh `--resume` chain if the underlying session is still resumable, or a cold start if not.
- **`preferences` is a flat key/value bag**, deliberately not typed — it's read back as prose into the system prompt, not branched on in code. Keeps `memory.js` from needing to know what a "palette" is.
- **`artifacts` is a small rolling list** (cap it — see below), so "build on what we made yesterday" has a real path to hand to a primitive/build step.

### 1.4 `lib/memory.js`

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PATH = join(homedir(), ".config", "jarvis", "memory.json");
const MAX_ARTIFACTS_PER_PROJECT = 10;

function emptyStore() {
  return { version: 1, projects: {} };
}

// Best-effort load: a missing or corrupt file degrades to "no memory" rather
// than crashing startup — same posture as readSharedSettings() in builder.js.
export function loadStore(path = DEFAULT_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.projects) return parsed;
  } catch {
    // Falls through.
  }
  return emptyStore();
}

export function saveStore(store, path = DEFAULT_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  // Write to a temp file and rename, so a crash mid-write can't leave a
  // truncated JSON file that loadStore() then silently discards.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  writeFileSync(path, readFileSync(tmp)); // rename() would be better cross-platform-safe; fine here
}

export function getProject(store, cwd) {
  return store.projects[cwd] ?? null;
}

export function touchProject(store, cwd, patch) {
  const existing = store.projects[cwd] ?? {
    sessionId: null, summary: "", preferences: {}, artifacts: [],
  };
  store.projects[cwd] = {
    ...existing,
    ...patch,
    preferences: { ...existing.preferences, ...(patch.preferences ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  return store;
}

export function recordArtifact(store, cwd, entry) {
  const project = store.projects[cwd] ?? touchProject(store, cwd, {}).projects[cwd];
  project.artifacts = [...(project.artifacts ?? []), { ...entry, at: new Date().toISOString() }]
    .slice(-MAX_ARTIFACTS_PER_PROJECT);
  return store;
}
```

Pure functions taking/returning the store — mirrors `builder.js`'s style (`denyRules`, `buildSettings` are pure; only `run()` touches the filesystem/process). Makes it directly unit-testable like `test/builder.test.js` does for `denyRules`.

### 1.5 Wiring into `brain.js`

`ask()`'s signature doesn't need to change — `opts.persona` already exists as the injection point. Add a `buildPersona` variant that takes prior context:

```js
// lib/brain.js — add alongside buildPersona()

function memoryBlock(project) {
  if (!project || (!project.summary && Object.keys(project.preferences ?? {}).length === 0)) {
    return "";
  }
  const parts = ["MEMORY: here is what you know from earlier sessions on this project."];
  if (project.summary) parts.push(project.summary);
  const prefs = Object.entries(project.preferences ?? {});
  if (prefs.length > 0) {
    parts.push("Standing preferences: " + prefs.map(([k, v]) => `${k}: ${v}`).join("; ") + ".");
  }
  parts.push("Use this naturally; never recite it verbatim or announce that you 'remember'.");
  return parts.join(" ");
}

export function buildPersona(primitives, project = null) {
  return [VOICE, buildsBlock(primitives), memoryBlock(project), CLOSER]
    .filter(Boolean)
    .join(" ");
}
```

`memoryBlock` returns `""` when there's nothing to say, and `.filter(Boolean)` keeps `buildPersona(registry)` (no project arg) byte-identical to today — the existing `export const PERSONA = buildPersona();` default and every existing test of `buildPersona` keep passing unchanged.

### 1.6 Wiring into `server.js`

```js
import { loadStore, saveStore, getProject, touchProject, recordArtifact } from "./lib/memory.js";

const memoryStore = loadStore();
const PROJECT_KEY = process.cwd(); // one server = one project, for this app's shape
const project = getProject(memoryStore, PROJECT_KEY);
const persona = buildPersona(registry, project);
```

Resuming the Claude Code session itself: if `project.sessionId` exists, seed `sessions.set(ws, project.sessionId)` on connect so the *first* turn of a new page load tries `--resume <old id>` instead of starting cold. Claude Code sessions do expire / can become unresumable — wrap it defensively:

```js
wss.on("connection", (ws) => {
  const conv = { pending: null };
  if (project?.sessionId) sessions.set(ws, project.sessionId);
  ...
```

`ask()` in `brain.js` already throws on a bad `--resume` (non-zero exit → rejected promise); catch that specific case in the message handler and retry once with `sessionId` cleared, same shape as the existing `try/catch` around the whole handler — don't add a second one, just don't let a stale id become a fatal error on the very first message of a new page load. Simplest version: on any `ask()` rejection whose message matches `/no.*session|not found/i`, clear `sessions.set(ws, null)` and retry `ask()` once.

Persist after each turn (cheap — `writeFileSync` on a small file) and after each build:

```js
// after: const { reply: spoken, sessionId } = await ask(...)
touchProject(memoryStore, PROJECT_KEY, { sessionId });
saveStore(memoryStore);
```

```js
// after outcome.ok in build()
if (outcome.ok) {
  recordArtifact(memoryStore, PROJECT_KEY, {
    primitive: primitive.id, dir: outcome.dir, outputContract: primitive.outputContract,
  });
  saveStore(memoryStore);
}
```

### 1.7 Where the summary comes from

Don't hand-roll summarization. Two honest options:
- **Cheapest**: on `ws.on("close")`, if the turn count this session exceeded some threshold, fire one more `ask()` call with a system-prompt-only request: *"Summarize this conversation in two sentences for future reference."* — reuses the exact same `ask()` seam, same session id (so it has the real context via `--resume`), costs one extra haiku turn only at the end of a session rather than per-turn.
- **Free but worse**: keep a rolling last-N-turns buffer in `conv` and join it verbatim, capped to a few hundred chars, as the "summary". No extra model call, but it degrades to word soup fast.

Go with the first — it's one more call to a seam that already exists (`ask`), at session end only, so cost is bounded and predictable.

### 1.8 Testing (`test/memory.test.js`)

Follow the existing style exactly — `test/builder.test.js` tests `denyRules`/`buildSettings` as pure functions with no real filesystem or subprocess. Do the same:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { touchProject, recordArtifact, getProject } from "../lib/memory.js";

test("touchProject merges preferences instead of replacing them", () => {
  let store = { version: 1, projects: {} };
  store = touchProject(store, "/p", { preferences: { palette: "dark" } });
  store = touchProject(store, "/p", { preferences: { tone: "warm" } });
  assert.deepEqual(getProject(store, "/p").preferences, { palette: "dark", tone: "warm" });
});

test("recordArtifact caps the list at MAX_ARTIFACTS_PER_PROJECT", () => { /* ... */ });
```

`loadStore`/`saveStore` are the only impure functions — test them with a `path` override into a temp dir (`node:test`'s `t.mock` or a real `mkdtemp`), same pattern `builder.test.js` presumably uses for `writeBuildSettings`-adjacent behavior via injected `opts.root`.

---

## 2. Multi-Step Orchestration

### 2.1 The shape

A primitive gains an optional `steps` array. When present, `run()` in `builder.js` doesn't spawn one `claude -p` — it spawns one per step, in sequence, each getting the previous step's build directory as read-accessible context, and reports one combined outcome.

```js
// primitives/marketing-site.mjs
export default {
  id: "marketing-site",
  triggers: ["marketing site", "full site"],
  questions: [{ key: "subject", ask: "What's the site for?" }],
  systemPrompt: (params) => `Overall goal: a marketing site for ${params.subject}.`,
  allowedTools: ["Write", "Edit", "Read"],
  outputContract: "index.html", // the FINAL step's contract
  doneLine: (params) => `Your site for ${params.subject} is ready.`,
  timeoutMs: 900000, // ceiling for the WHOLE chain

  // NEW — each step is shaped like a mini primitive: its own prompt, tools,
  // output contract, and timeout share. Omit `systemPrompt` to fall back to
  // a generated one that includes the previous step's artifact path.
  steps: [
    {
      id: "plan",
      systemPrompt: (params) =>
        `Plan the site for ${params.subject}. Write plan.md describing pages and sections. Do not write HTML yet.`,
      allowedTools: ["Write"],
      outputContract: "plan.md",
      timeoutShareMs: 120000,
    },
    {
      id: "build-pages",
      // receives { ...params, previous: { dir, artifact } } from the plan step
      systemPrompt: (params) =>
        `Read ${params.previous.artifact} for the plan. Build index.html for ${params.subject} following it.`,
      allowedTools: ["Write", "Edit", "Read"],
      outputContract: "index.html",
      timeoutShareMs: 480000,
    },
    {
      id: "verify",
      systemPrompt: (params) =>
        `Read index.html at ${params.previous.artifact}. Check it has no broken relative links or empty sections. If you find a problem, fix it in place. Then write verify.txt with "ok" or a one-line description of what you fixed.`,
      allowedTools: ["Read", "Edit", "Write"],
      outputContract: "verify.txt",
      timeoutShareMs: 180000,
    },
  ],
};
```

### 2.2 Passing artifacts forward: shared directory, not copying

Don't copy files between step directories — run every step in the **same** build directory (`freshBuildDir()` called once for the whole chain, not once per step), so `Read` in step N can see what step N-1 wrote without any extra plumbing, and the final `outputContract` check just looks in one place. This also means `params.previous` only needs to carry the *contract filename*, not a path across directories:

```js
{ ...params, previous: { dir, artifact: primitive.steps[i-1].outputContract } }
```

The deny-list in `builder.js` (`deniedDirs`/`deniedFiles`) is keyed to the *build's own directory* being writable and everything else denied — running all steps in one dir means that policy doesn't need to change at all per step. Only the settings file (`writeBuildSettings`) needs to be generated once and reused across steps, not regenerated per step (same throwaway temp dir, same rules).

### 2.3 The orchestration loop in `builder.js`

`run()` currently: make one dir → spawn one `claude` → stream progress → check `outputContract` → resolve `{ok, dir, artifact, result, log, timedOut}`.

New version: if `primitive.steps` exists, loop; otherwise fall through to today's single-shot path unchanged (backward compatible — every existing primitive with no `steps` field behaves identically).

```js
// lib/builder.js — sketch, slots into the existing run()

async function runStep(step, params, dir, generatedSettings, onProgress, opts) {
  const args = buildSpawnArgs(step, params, {
    ...opts,
    settings: generatedSettings.path,
    mcpServers: opts.mcpServers ?? configuredMcpServers(),
  });
  // ... identical spawn/log/timeout machinery to today's run(), parameterized
  // by step.timeoutShareMs instead of primitive.timeoutMs, and reporting
  // through onProgress with a step-scoped prefix (see 2.4).
  // Resolves { ok, artifact, result, timedOut } — NOT a fresh `dir`, since
  // all steps share one.
}

export async function run(primitive, params, onProgress, opts = {}) {
  const dir = await freshBuildDir(opts.root ?? join(REPO, "builds"));
  const log = join(dir, "build.log"); // one combined log for the whole chain
  const generated = opts.settings ? null : await writeBuildSettings(opts);
  const settingsRef = opts.settings ? { path: opts.settings } : generated;

  if (!primitive.steps) {
    return runSingleShot(primitive, params, dir, log, settingsRef, onProgress, opts); // today's logic, extracted
  }

  let stepParams = { ...params };
  let lastOutcome = null;
  for (const [i, step] of primitive.steps.entries()) {
    safely(onProgress, { type: "step-start", id: step.id, index: i, of: primitive.steps.length });
    const outcome = await runStep(step, stepParams, dir, settingsRef, onProgress, opts);
    lastOutcome = outcome;
    if (!outcome.ok) {
      return { ok: false, dir, artifact: null, result: outcome.result, log, timedOut: outcome.timedOut, failedStep: step.id };
    }
    safely(onProgress, { type: "step-done", id: step.id, artifact: outcome.artifact });
    stepParams = { ...stepParams, previous: { dir, artifact: step.outputContract } };
  }

  const finalContract = primitive.outputContract;
  const ok = existsSync(join(dir, finalContract));
  return { ok, dir, artifact: ok ? join(dir, finalContract) : null, result: lastOutcome?.result, log, timedOut: false };
}
```

Key invariants preserved from today's `run()`:
- **One `dir` per top-level request** (`freshBuildDir` called once) — a `steps` primitive is still "one build" from `server.js`'s point of view; `MAX_BUILDS = 1` and the slot-claim logic in `server.js` needs zero changes.
- **A failed step is an outcome, not a thrown exception** — same contract as today (`ok: false` resolves, doesn't reject), so `server.js`'s existing `if (outcome.ok) { ... } else { describeFailure(...) }` branch keeps working without modification. Add `failedStep` to the outcome so `describeFailure` (in `lib/outcome.js`) can optionally say *which* step broke.
- **`primitive.timeoutMs` is still the hard ceiling for the whole chain**; `step.timeoutShareMs` values are sub-budgets. Validate in `registry.js`'s `validatePrimitive` that `steps` sum of `timeoutShareMs` doesn't exceed `timeoutMs` (or just enforce it live with a running total — simpler, and self-correcting if someone edits one number without the other).

### 2.4 Tree-shaped progress instead of flat lines

`progress.js` today turns one `stream-json` line into one flat string (`"Writing index.html"`). For a tree, change the *shape* of what `onProgress` receives rather than reinventing `progress.js`'s parsing:

- Keep `progressLines()`/`createProgressStream()` exactly as-is — they still turn raw model output into `"Writing plan.md"` style strings per step.
- Wrap each call in a step-tagged envelope at the `runStep` level: `onProgress({ type: "line", step: step.id, text })` instead of raw string.
- `server.js` forwards this envelope over the WebSocket unchanged (`send({ type: "progress", ...line })`); it was already forwarding an opaque object shape via `(line) => send({ type: "progress", line })`, so widening `line` from a string to `{step, text}` is a client-side (`public/build-hud.js`) change, not a server-shape break — `server.js`'s callback body doesn't need to change at all.
- `public/build-hud.js` groups incoming lines by `step` into a collapsible tree instead of one scrolling list — this is the one genuinely new piece of code; the README already notes *"The HUD already distinguishes ambient activity from reported events, so it has somewhere to put the structure"*, meaning the event-vs-ambient split it does today is the right seam to extend, not replace.

### 2.5 What NOT to build first (scope discipline)

The README's "harder and more interesting" version — a build spawning its *own* sub-builds recursively — is real scope creep for a v1. It requires a build session to have `Task` or a way to shell back into `claude -p` itself, which directly fights the `REACHES_OUTSIDE` deny list (`Task` is explicitly denied for exactly this reason — a build reaching further than its own directory). Skip it. A primitive-defined `steps: [...]` array, driven by the orchestrator process (not by the model inside a build), gets 90% of the value with none of the sandbox-widening risk.

### 2.6 Testing (`test/builder.test.js` additions)

Mirror the existing tests for `buildSpawnArgs`/`denyRules` — pure-function tests first:
- `buildSpawnArgs(step, params, opts)` produces correct args per step (reuse today's assertions, parameterized).
- A `steps` primitive with a deliberately failing step 2 → orchestrator returns `{ok: false, failedStep: "build-pages"}` and never runs step 3. (Use a fake `bin` that's a tiny script exiting nonzero — same technique likely already used to fake `claude` in the existing builder tests; check `test/builder.test.js` for the current fake-binary fixture and reuse it rather than inventing a second one.)
- A `steps` primitive where every step succeeds → final `artifact` points at `primitive.outputContract` (the *last* step's file), not an intermediate one.
- Timeout budget: total wall-clock across steps never exceeds `primitive.timeoutMs` even if each `timeoutShareMs` is generous (guards against a mis-authored primitive).

---

## 3. Integration points, summarized

| Feature | New file | Files touched | Wire-format changes |
|---|---|---|---|
| Memory | `lib/memory.js` | `server.js` (load/save, pass `project` to `buildPersona`), `lib/brain.js` (`memoryBlock`, `buildPersona(primitives, project)`) | None — `buildPersona(registry)` with no `project` arg is unchanged |
| Orchestration | none (extends `lib/builder.js`) | `lib/builder.js` (`run()` branches on `primitive.steps`), `lib/registry.js` (`validatePrimitive` accepts optional `steps`), `lib/outcome.js` (`describeFailure` can read `failedStep`), `public/build-hud.js` (render tree) | `onProgress` payload widens from string to `{step, text}` for `steps` primitives only — single-step primitives untouched |

Both features are additive to `registry.js` validation (`steps` optional) and to `run()`'s return shape (`failedStep` optional) — no existing primitive or test needs to change to keep working.

## 4. Priority order

1. **Memory layer first.** Smaller surface, no change to the security-critical `builder.js` deny logic, immediately demoable ("remember I like dark palettes"), and it's a prerequisite for orchestration being *useful* ("build on what we made yesterday" needs both features together, but memory alone already pays for itself).
2. **Orchestration, `steps` field only** (2.1–2.3) — the mechanical loop, single shared build directory, flat progress still fine at this stage. Ship this before touching the HUD.
3. **Tree-shaped progress** (2.4) — purely additive UI, do last since it's the part users see but nothing else depends on it.
4. **Skip recursive build-spawns-builds** (2.5) indefinitely unless a concrete use case demands it — it's a sandbox question, not a feature question, and this repo's whole design posture (read the "What a build is allowed to do" section) is least-privilege by default.

---

**Note on scope**: no files in `/home/krane/development/jarvis` were modified — this guide is derived from reading `lib/README.md`, `lib/brain.js`, `lib/builder.js`, `lib/registry.js`, `lib/progress.js`, `server.js`, and `primitives/_template.mjs` directly. Implementing it is a separate task.
