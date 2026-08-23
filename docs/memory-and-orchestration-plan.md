# Jarvis: Memory Layer + Multi-Step Orchestration

## Context

`jarvis-demo` is a voice front-end to headless Claude Code. Today it has two holes the
repo's own README names as its intended growth paths:

1. **No memory.** `ask(text, sessionId)` in `lib/brain.js` threads a Claude Code session id,
   but that id lives only in `const sessions = new Map()` in `server.js` and dies on refresh.
   Every conversation starts blank; stated preferences never stick; every build is an orphan.
2. **No orchestration.** One `[ACTION:BUILD]` tag spawns exactly one `claude -p` in one fresh
   directory. There is no plan → build → verify decomposition.

`jarvis-memory-and-orchestration-guide.md` (in the repo root) specifies both. This plan
implements guide sections 1, 2.1–2.4, and deliberately **skips 2.5** (builds spawning their
own sub-builds) — that widens the sandbox, and the repo's whole posture is least privilege.

Intended outcome: "what did we build yesterday?" works; "I always want dark palettes" sticks
across restarts; a `marketing-site` primitive runs plan → build-pages → verify as one build;
the HUD shows step boundaries.

Four decisions are already fixed by the user:
- Preferences are written by a **second machine tag** from the brain (`[MEMORY:SET k=v]`),
  parsed like the build tag — not inferred, not extracted post-hoc.
- Full scope: memory + steps + tree HUD.
- Ship a **real** `primitives/marketing-site.mjs`.
- Execute with **sequential sub-agents, one per stage, TDD** (test first).

---

## Stage 0 — tooling setup (do first, then reload the session)

The repo currently has no `.codegraph/`, no `CLAUDE.md`, no `.claude/settings.json`, and no
claude-mem history. Set that up before any implementation stage, because stages 7–9 rewrite the
most intricate file in the repo (`lib/builder.js`) and the sub-agents doing it will otherwise
re-derive its call graph by grep on every dispatch.

1. **CodeGraph index.** `codegraph init` in `/home/krane/development/jarvis` (CLI is at
   `/home/krane/.local/bin/codegraph`, v1.5.0). Add `.codegraph/` to `.gitignore` — it is a local
   SQLite index, not project state. The MCP server picks a new index up live, no restart needed.
   Verify with `codegraph explore "run builder spawn"` returning real source.
2. **Project `CLAUDE.md`.** Short, and only what the repo does not already say: point at
   `lib/README.md` (which is the real README) for architecture, state the house rules the
   existing code enforces but never writes down — `node --test` only, no new dependencies,
   `node:` builtins only, comments explain *why* in the existing prose voice, deny-list changes
   in `lib/builder.js` are security-relevant and never casual.
3. **`.claude/settings.json` permissions.** Allow the read-only commands this work will run over
   and over — `npm test`, `node --test`, `codegraph explore`, `git diff/status/log` — so eleven
   sequential sub-agent stages do not each stop on a prompt. The `fewer-permission-prompts` skill
   generates this from actual transcript history; use it rather than guessing.
4. **claude-mem.** Run `/learn-codebase` (~5 min) to front-load the repo in one pass. Its memory
   injection only starts on the **second** session in a project, which is why a reload is needed.
5. **caveman.** `/caveman-init` drops the always-on activation rule into the repo so sub-agents
   inherit the compressed style instead of each being told separately.

**Then reload the session** (claude-mem injection and the repo `CLAUDE.md` both need a fresh
start) and resume at Stage 1. This plan file is the handoff.

---

## Stages

Eleven stages, strictly sequential. Each is one sub-agent's scope. Every stage must leave
`npm test` green and the browser working before the next starts.

| # | Stage | Creates | Modifies |
|---|---|---|---|
| 1 | Memory store | `lib/memory.js`, `test/memory.test.js` | — |
| 2 | MEMORY tag parser | — | `lib/action.js`, `test/action.test.js` |
| 3 | Persona memory blocks | — | `lib/brain.js`, `test/brain.test.js` |
| 4 | Stale-resume recovery seam | `test/brain-resume.test.js` | `lib/brain.js` |
| 5 | server.js memory wiring | — | `server.js` |
| 6 | Client progress normalizer | `public/progress-policy.js`, `test/progress-policy.test.js` | `public/app.js` |
| 7 | builder.js refactor + envelope widening | — | `lib/builder.js`, `test/builder.test.js` |
| 8 | registry.js `steps` validation | — | `lib/registry.js`, `lib/outcome.js`, `primitives/_template.mjs`, `test/registry.test.js` |
| 9 | builder.js steps loop + `failedStep` | — | `lib/builder.js`, `lib/outcome.js`, `server.js`, `test/builder.test.js`, `test/outcome.test.js` |
| 10 | marketing-site primitive | `primitives/marketing-site.mjs` | `test/registry.test.js`, `test/builder.test.js` |
| 11 | Tree-shaped HUD | — | `public/build-hud.js`, `public/index.html`, `public/app.js`, `public/progress-policy.js`, `test/progress-policy.test.js` |

Two non-obvious orderings:
- **6 before 7.** Stage 7 changes the `{type:"progress", line}` wire shape from a string to an
  object. `npm test` would be green while the browser renders `[object Object]`. Stage 6 is
  pure client defence and a no-op until 7 lands.
- **8 before 9**, so stage 9's fixtures are shapes the registry already blesses.

---

## Stage 1 — `lib/memory.js`

Store: `~/.config/jarvis/memory.json`, keyed by `process.cwd()` at boot. Outside the repo, and
inside a directory `deniedDirs()` (`lib/builder.js:99`) already blocks builds from writing.

**Mutate, don't copy-on-write.** The guide's sketch is inconsistent (claims purity, mutates).
`server.js` holds one long-lived store for the process lifetime; a copy-on-write API means
`memoryStore = touchProject(...)` at every call site and one forgotten reassignment is a
silently lost preference. Mutate, return the store for chaining, and export the *interesting*
logic (`sanitizePreferences`, `capArtifacts`) as genuinely pure functions — that is what makes
it testable like `denyRules` in `lib/builder.js`.

```
DEFAULT_PATH, emptyStore()
loadStore(path)              impure, never throws, normalizes shape
saveStore(store, path)       impure, never throws, -> boolean
getProject(store, cwd)       pure read
touchProject(store, cwd, patch)   MUTATES
recordArtifact(store, cwd, entry) MUTATES
applyMemoryTag(store, cwd, memory) MUTATES, -> saved prefs | null
sanitizePreferences(bag)     PURE
capArtifacts(list)           PURE
```

**Fix the guide's `saveStore` bug.** Its `writeFileSync(path, readFileSync(tmp))` is not atomic
(it truncates the real file — the exact window it claims to close) and leaks the tmp file.
Correct: write a **sibling** tmp file (`${path}.${process.pid}.tmp` — not `/tmp`, rename across
filesystems is EXDEV), `renameSync` over the target, `unlinkSync` the tmp in the catch, mode
`0o600`. Never throws; returns whether it landed.

Caps (all constants, all commented): `MAX_ARTIFACTS_PER_PROJECT 10`, `MAX_PREFERENCE_KEYS 20`,
`MAX_KEY_CHARS 40`, `MAX_VALUE_CHARS 120`, `MAX_SUMMARY_CHARS 600`, plus the same `UNPRINTABLE`
class `lib/progress.js:38` uses. These are **security-relevant**, not tidiness: preference text
is read back into a system prompt on every future turn, so it is a persistence surface for
prompt injection.

`sanitizePreferences`: lowercase + strip + trim + clip keys; skip `__proto__`/`constructor`/
`prototype`; collapse whitespace and clip values; **drop empty values** (a malformed tag far
more often than an intent to forget — no deletion verb in v1); stop adding *new* keys past the
cap so existing preferences are stable and updating a present key always works.

`touchProject` merges preferences (never replaces), clips the summary, stamps `updatedAt`.

## Stage 2 — the MEMORY tag

Grammar: `[MEMORY:SET palette=dark tone="confident, understated"]`. Verb after the colon is
tolerated and ignored, exactly as `BUILD` is (`lib/action.js:37`). Every pair is a preference —
no `primitive=` requirement. Caps live in `lib/memory.js`; the parser stays a text splitter.

**Generalize `lib/action.js`; do not add a sibling parser.** Two regexes that must agree about
what a tag looks like will drift, and the failure mode is the voice reading a machine tag aloud
— the exact thing `lib/action.js:1-9` and `lib/brain.js:77-79` exist to prevent. One scanner
means one seam-closing pass (`TAG_SEAM`) and inherits the catastrophic-backtracking fix
documented at `lib/action.js:6-9` for free.

```js
const TAG_SOURCE = String.raw`\[\s*(action|memory)\s*:([^\]]*)\]`;
```

Extract `parsePairs(body)` from today's `parseTagBody` (verb strip + `PAIR` loop + `unquote`,
all reused verbatim); add `toAction(bag)` (today's semantics) and `toMemory(bag)`.
`parseAction` keeps its name and export (`server.js:9`) but widens to
`{ reply, action, memory }`. First dispatchable ACTION wins (unchanged); MEMORY tags **merge**
across all matches.

**Breaking:** `assert.deepEqual` is strict here. Six whole-object assertions in
`test/action.test.js` (lines 119, 192, 194–197) must gain `memory: null`. Update them — do not
hide the key to avoid it.

## Stage 3 — persona

`lib/brain.js` gains two blocks, assembled as
`[VOICE, buildsBlock(primitives), memoryTagBlock(), memoryBlock(project), CLOSER].filter(Boolean).join(" ")`.
Capability first, then recalled facts, then `CLOSER` last, word for word.

- `memoryTagBlock()` — unconditional. Teaches the tag and, load-bearingly, **"if you are also
  starting a build, put this tag BEFORE the build tag"** (`buildsBlock` already promises "never
  put anything after it" about the ACTION tag). Must draw the line explicitly with examples:
  *"make this one dark"* is a one-off and gets no tag; *"I always want dark palettes"* is
  standing and gets one; when in doubt, don't emit.
- `memoryBlock(project)` — per guide §1.5, returning `""` when there is nothing to say, **plus**
  one line the guide omits: the most recent artifact's primitive id. That is the whole reason
  `artifacts` exists ("build on what we made yesterday" needs a handle).

`buildPersona(primitives)` with no project arg stays valid; no existing test asserts `PERSONA`'s
content.

## Stage 4 — stale `--resume` recovery

The guide proposes matching `/no.*session|not found/i` against
`claude exited <code>: <stderr sliced to 200 chars>` (`lib/brain.js:145`). **Reject that.** It
is unversioned CLI stderr from a weekly-updated tool, truncated; it fails silently three ways
(wording changes, the useful part falls past 200 chars, the message goes to stdout), and each
failure reinstates the permanent-failure loop with no test noticing.

Instead, add `askResilient(text, sessionId, opts)` in `lib/brain.js`, sitting directly on
`ask()` so it is testable with a fake `bin` like `builder.js`'s spawn path:

- success → `{ ...result, recovered: false }`
- failure **with** a sessionId → retry once with `null`, → `{ ..., recovered: true }`
- failure with no sessionId → rethrow unchanged (a cold failure is just a failure)
- both fail → set `err.sessionExhausted = true` and throw the second

Not conditioned on error text at all. Cost of being wrong: one extra haiku turn. Cost of being
right: a conversation that heals itself.

## Stage 5 — `server.js` wiring

- `const memoryStore = loadStore()`, `const PROJECT_KEY = process.cwd()`.
- **`persona` must become a `let`** (it is `const` at `server.js:49`). Add `refreshPersona()`.
  Without this the headline feature only takes effect after a restart, with no error anywhere.
  Comment the caveat: on a `--resume`d session the CLI may keep the system prompt it started
  with, so a refreshed persona is guaranteed correct on the next cold start.
- Seed the session id **per connection**, read fresh from the store (not a boot-time snapshot) —
  a second tab opened mid-conversation must get the current id. Track `conv.turns`.
- Call `askResilient`; on `recovered`, clear the stored id. In the **existing** catch, narrow on
  `e.sessionExhausted` to `sessions.delete(ws)` + clear the stored id — a Fish outage must not
  cost the conversation its context.
- `const { reply, action, memory } = parseAction(spoken)`. Apply `memory` **before** dispatch and
  with no await between: *"make it dark from now on and build me a landing page"* must have the
  preference on disk before the build starts. Both tags in one reply are independent; both apply.
- After `outcome.ok` in `build()`: `recordArtifact` with the **basename** (`dir`, already
  computed at `server.js:282`), not the absolute path — same token `/builds/` uses, and it keeps
  a home path out of a file that is read back into a system prompt.
- `ws.on("close")`: read `sessions.get(ws)` **before** the delete (only handle to the id), then
  fire-and-forget `summarizeOnClose(sessionId, conv.turns)`.

**End-of-session summary.** Threshold `turns >= 3` (successful brain calls only). Its own
bookkeeping persona, not the JARVIS voice — the forty-word spoken-reply rule would shape the
summary for a listener. Not awaited, no `send`, no `conv` access, errors fully swallowed and
logged at info level. One module-scope `summarizing` flag so a refresh storm produces at most
one extra process. **Do not store the session id returned by the summary call** — that would put
"Summarize this conversation" at the head of the next resume. No `beforeExit` hook.

No automated tests for this stage — `server.js` has none today, and stages 1–4 exist precisely
to drain the logic out of it. Verification is the manual smoke checklist below.

## Stage 6 — `public/progress-policy.js`

The repo already has this pattern: `public/stt-policy.js`, `public/visibility-policy.js` — tiny
pure modules in `public/`, imported by `app.js`, unit-tested with no DOM.

`normalizeProgress(line)` accepts **both** a bare string (so an older server cannot blank the
readout) and the new envelope, returns `{kind:"line", step, text}` / `{kind:"step", step, state,
index, of}` / `null`. `cleanProgressLine` (`app.js:43-45`) moves here. Also
`pushProgressEntry(buffer, entry, max)` + `PROGRESS_MAX = 5`.

`app.js` imports them; `progressBuffer` holds entries instead of strings; `renderProgress()`
renders step rows and indented line rows — still `textContent`, never HTML.

## Stage 7 — `builder.js` refactor + envelope

Three layers. Bottom one is the only place a child process exists:

```
spawnClaude({bin, args, cwd, logStream, timeoutMs, killGraceMs, onProgress, step})
  -> { code, result, timedOut }        rejects only when the CLI cannot start
runSingleShot(primitive, params, ctx)  today's semantics
runSteps(primitive, params, ctx)       stage 9
run(primitive, params, onProgress, opts)
```

`spawnClaude`'s body is today's `new Promise(...)` (`lib/builder.js:381-475`) with four changes:
the write stream becomes a parameter; `handleLine` reports an envelope; the deadline uses the
`timeoutMs` argument; `close` resolves `{code, result, timedOut}` only. `lineSplitter`, `safely`,
`signalBuild`, `closeLog` and the `spawnFailed` race guard (`lib/builder.js:444-452` — keep that
comment verbatim, it is a real fix) move in unchanged.

`run()` creates **one** `freshBuildDir`, **one** log, **one** settings file, and cleans up in a
`finally`. Two traps:
- Use a **lazy** log wrapper (`openLogLater`) that opens on first write. Hoisting
  `createWriteStream` out of the Promise makes a missing CLI leave an empty `build.log` — the
  exact thing `lib/builder.js:394` prevents.
- `return x` evaluates `x` **before** `finally` runs. Compute the outcome in the `try`, close in
  the `finally`, attach `log: existsSync(logPath) ? ... : null` **after** — today's code closes
  then stats (`lib/builder.js:461-471`) and a naive try/finally silently inverts that.

**Widen the envelope uniformly**, single-shot included. The payload is already opaque to the
server (`server.js:272`); two shapes means every consumer forever needs a `typeof` branch, and
`build-hud.js:892` calls `String(...)` so the shape you forgot renders as `[object Object]` —
a bug that ships silently because it looks like text. The string shape is pinned in exactly one
place: `test/builder.test.js:210`.

Wire shape (nested under `line`, so `server.js`'s callback body does not change at all;
discriminator is `kind`, not `type`, because the outer message already has a `type`):

```json
{"type":"progress","line":{"kind":"line","step":"plan","text":"Writing plan.md"}}
{"type":"progress","line":{"kind":"step","step":"plan","index":0,"of":3,"state":"start"}}
```

`lib/progress.js` is **not touched** — both features are designed so its parsing stays as-is.

## Stage 8 — `registry.js` validation

`steps` optional; when present, an array and **non-empty** (an empty array would take the steps
path, spawn nothing, and report a success that did no work). Per step: `id` (non-empty, unique
within the primitive — it names a log separator, a progress envelope and `failedStep`);
`systemPrompt` (function); `allowedTools` (array of non-empty strings, **required, not
inherited** — inheriting would silently hand a plan step `Edit`); `outputContract` (non-empty
and relative); `timeoutShareMs` optional positive finite; `mcp` optional.

**Timeout sum:** if *every* step declares a share, their sum must be `<= primitive.timeoutMs`,
failing with both numbers named. If any step omits its share, skip the check (an omitted share
means "whatever is left"). Keep this *in addition to* the live running total in stage 9 — they
fail at different times for different audiences.

**Last step's contract must equal `primitive.outputContract`.** This is a real bug in the
guide's own example (`verify.txt` vs `index.html`). `run()` decides success by
`primitive.outputContract` and `server.js:289` builds the `open` URL from it; without the rule
you get a chain that "succeeds" while the last step's promise is never checked, or a browser
opening a file the last step never touched.

Export the already-written `contractIsUsable` from `lib/outcome.js:22-26` and apply it to both
`p.outputContract` and every step's. Today an absolute contract passes validation and only
surfaces after a build has been paid for. **Deliberate, requested hardening** — not scope creep.

Also fix the existing inconsistency found during exploration: `startLine` is read by
`server.js:265` but never validated and never documented. Validate it as an optional function
and document it, plus `steps`, in `primitives/_template.mjs`.

`withDefaults` (`lib/registry.js:90-99`) must deep-copy `steps` — the module cache returns the
same object every import, which is the hazard its line-92 comment already warns about. Keep
`steps` **`undefined`** (never `[]`) when absent: `run()` branches on truthiness.

## Stage 9 — the steps loop

**Cold session per step, not `--resume`.** State already has a channel — the shared directory
(guide §2.2). Each step's prompt names the previous artifact; the step reads it from disk, which
is inspectable and reproducible. `--resume` would need the session id threaded out of
`spawnClaude`, would drag the planning transcript into a 540-second HTML step, and would put
session state into `buildSpawnArgs`, the one function this repo deliberately keeps pure
(`lib/builder.js:228-229`). The re-read *is* the feature: a verify step re-reading `index.html`
from disk is a verification rather than a recollection. Write this as a comment — it will be
questioned.

**`stepSpec(primitive, step)`** — small exported pure adapter, so `buildSpawnArgs` stays one
function. It puts `primitive.systemPrompt(params)` (the overall goal) in front of the step's own
prompt, passes the step's `allowedTools` through untouched, and inherits `primitive.mcp` only
when the step names none. **Tools are never inherited.**

**Budget:** `ceiling = primitive.timeoutMs`; `spent` accumulated on the **wall clock** around
each spawn so startup and flushing are charged; `budget = Math.min(share ?? remaining,
remaining)`. When `remaining <= 0`, return `{ok:false, timedOut:true, failedStep: step.id}`
without spawning — another step could only overrun further.

**`params.previous` is always an object**, even on the first step: `{dir, id:null,
artifact:null}`. `systemPrompt` is called synchronously inside `buildSpawnArgs`
(`lib/builder.js:231`), so a `null` turns a primitive-authoring typo into an unexplained
`TypeError` that rejects the whole build.

Each step's success uses `buildSucceeded`, not a bare `existsSync` — the guide's sketch drops
the `result.is_error` check the single-shot path has always applied. The chain's final check
does the same against `primitive.outputContract`.

`runSteps` writes `\n=== step: <id> ===\n` into the shared log before each spawn — cheap, and it
turns a 900-second combined log from unreadable into diagnosable.

**`failedStep`:** present on every `runSteps` outcome (`null` on success), **absent entirely**
from `runSingleShot` so today's return shape is byte-identical. `lib/outcome.js`'s
`describeFailure` appends `" It stopped at the <step> step."` only when it has both a base
message and a step id, speaking the id as words. Every existing `outcome.test.js` case passes no
`failedStep` and stays green. `server.js:303-309` passes it through.

## Stage 10 — `primitives/marketing-site.mjs`

Real primitive: `plan` (Write → `plan.md`) → `build-pages` (Write/Edit/Read → `index.html`) →
`verify` (Read/Edit/Write → `index.html`, edited in place). Last step's contract equals the
primitive's, per stage 8. `timeoutMs` 900000 with shares that sum inside it.

Known weakness to document **in the primitive's own comments** rather than paper over: steps
share a directory, so a step's contract can already exist when it starts (verify's `index.html`
was written by build-pages), and `buildSucceeded` will pass for that step even if it did
nothing. Contract-checking a shared directory is inherently weaker than checking a fresh one.

## Stage 11 — tree-shaped HUD

**Extend the existing vocabulary; do not redesign.** Today: cyan = ambient, means nothing
(`build-hud.js:425`); amber = a line the build reported (`:890-903`, `:497`); red = fault. A step
boundary is neither ambient nor model chatter — it is the *orchestrator* speaking, and there is
already a fourth colour for that register: `WHITE = [224,244,255]` (`:37`), used for the outcome
ring at `:788` with a sprite at `:877`.

1. Step boundary = a **white** label. Add `tone: "step"|"line"` to the label record
   (`:466-472`); one line changes in `drawLabels` (`:497`). The stamp reads `step 1 of 3` instead
   of elapsed time. Red still overrides on failure.
2. Step boundary cuts a **deeper mark**: optional `scar.span` defaulting to `SCAR_ARC` (`:57`,
   consumed `:729-738`), boundary pushes `SCAR_ARC * 1.8` and one larger shock. The record
   visibly jumps at each boundary — three sections, no new layout, no new colour.
3. New `#bh-step-row` in `public/index.html` beside `bh-request-row`/`bh-detail-row`/
   `bh-file-row` (index.html:213-215), showing `plan · 1 of 3`, hidden when `step === null`.

New public `step(info)` method on the returned object (`:960-968`), which must also reset
`lastEventVt`/`nextQuietVt` — a boundary **is** activity, and without it the quiet counter climbs
through a step doing exactly what it should. `event(line, step)` gains a second parameter.
`start()` resets the new row alongside `fileRow` (`:864`); `stop()` and `inertHud()` (`:107`)
must include `step: noop`.

**Explicitly not doing:** the guide says "collapsible tree", but the HUD is a canvas record with
a gutter — there is no scrolling list to collapse. The tree shape lives in `#progress` in
`app.js`, which *is* the list. `landing-page` must look byte-identical to today.

---

## Verification

Existing style is `node:test` + `node:assert/strict`, ESM, no framework, no mocking library,
real temp dirs, full-sentence test names. Fake CLIs are written at `before()` time as `.cjs`
files mode `0o755` and passed as `opts.bin` (`test/builder.test.js:138-151`) — **reuse that
`writeFake` helper, do not invent a second fixture mechanism.** `test/registry.test.js` has
`validPrimitive(overrides)` and `withTempPrimitives(files, fn)` — reuse those too.

**Automated** — `npm test` after every stage. Roughly 100 new cases:
- `test/memory.test.js` (~22): corrupt/absent file degrades to empty; save/load round-trip;
  rename leaves no temp file; a failed write returns false and leaves no temp file; preference
  merge; summary clipping; every cap; `__proto__` never reaches the prototype chain; artifact
  cap keeps the newest.
- `test/action.test.js` (~7 new + 6 edited): both tags in one reply; two memory tags merge;
  quoted values; a tag in an unknown namespace is left in the speech.
- `test/brain.test.js` (~6): no project says nothing about earlier sessions; summary +
  preferences fold in; the memory tag is taught before the build tag; `CLOSER` is still last.
- `test/brain-resume.test.js` (~6): new fakes that exit non-zero on `--resume`; a stale id is
  retried once and the answer arrives; a cold call is never retried; both-fail flags the error.
- `test/progress-policy.test.js` (~11): bare string still accepted; envelopes normalize; control
  chars stripped; unusable payload ignored rather than rendered; five-row budget.
- `test/builder.test.js` (~18 new + 1 edited): one invocation per step, in order; one dir and one
  log across the chain; a step reads what the step before wrote; a failing step names itself and
  the rest never run; the chain reports the primitive's contract; wall clock never exceeds
  `timeoutMs` however generous the shares; single-shot behaves exactly as before.
- `test/registry.test.js` (~24) and `test/outcome.test.js` (~4) per stage 8 / 9 above.
- One landmine catcher in stage 10: render every marketing-site step prompt with
  `previous: {dir, id:null, artifact:null}` and assert a non-empty string.

**Manual smoke** (stages 5, 10, 11 — no DOM harness in this repo, by design):
1. `node server.js`, open Chrome, say a standing preference → `~/.config/jarvis/memory.json`
   gains it, the debug line confirms it.
2. Refresh the tab → the log shows a seeded session id.
3. Corrupt `memory.json` by hand → the server still boots.
4. Put a garbage session id in `memory.json` → the first turn recovers and the id is cleared.
5. Hold four turns, close the tab → a summary lands seconds later.
6. Run `landing-page` → HUD and `#progress` are unchanged from today.
7. Run `marketing-site` → three white boundary labels, three deeper groove marks, a step row
   counting 1→3, one `build.log` with three `=== step: === ` separators, and the browser opens
   the `index.html` the verify step touched.

---

## Gotchas for the implementing agents

1. `assert.deepEqual` is strict here — widening `parseAction`'s return breaks six existing
   assertions. Update them; do not hide the key.
2. `return x` evaluates `x` before `finally` runs (stage 7 log-stat ordering).
3. Do not eagerly create the log write stream — a missing CLI must leave no empty `build.log`.
4. `--allowedTools` / `--disallowedTools` are **variadic** and swallow every following token
   until one starts with `-` (`lib/builder.js:250-259`). Keep the argument order exactly as it is;
   `--` is load-bearing.
5. `writeBuildSettings` once per chain, cleaned up once. Per-step regeneration means a step whose
   settings file was already deleted runs under the machine's default policy — a security
   regression, not a leak.
6. `primitive.steps` must be `undefined`, never `[]`, when absent.
7. The client breaks before its tests do — that is why stage 6 exists and must not be merged
   into 7 or reordered.
8. `persona` is `const` at `server.js:49` and must become `let`.
9. Never store the session id the summary call returns.
10. Read `sessions.get(ws)` before `sessions.delete(ws)` in the close handler.
11. Seed the session id per connection, not from a boot-time snapshot.
12. The `spawnFailed` flag (`lib/builder.js:444-452`) is a real race fix — Node emits both
    `error` and `close` for an unstartable CLI. Move it verbatim, comment included.
13. `params.previous` is always an object, never `null`.
14. Steps share a directory, so a step's contract may pre-exist. Document, don't paper over.
15. Preference text is re-fed to the model forever — the caps, the `UNPRINTABLE` strip, and
    `0600` under `~/.config` are non-negotiable.
16. `memory.json` lives outside the repo on purpose. Do not "helpfully" relocate it into the
    working tree — that would leak it into git and put it where builds can write.
17. Do not touch `lib/progress.js`. Both features are designed so its parsing stays as-is.
