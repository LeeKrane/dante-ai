# 21. Session kinds: review, tests, brainstorm, docs, security-review, implementation

**Verdict** LATER by the council; the owner wants six kinds. **Size** M to L, in four stages.
**Channel** 0.

## Goal

Six session kinds under `sessions/*.mjs`, each a prompt shape and nothing more: `review` (runs
the built-in `/code-review`), `tests` (unchanged), `brainstorm` (runs `/council-review` on the
interview brief), `docs` (runs `/technical-writing`, writes only documentation),
`security-review` (runs `/blast-radius`, then reports against the security seams), and
`implementation` (staged, test-first, one commit per green stage, fed by the brief a brainstorm
produced). Decisions taken with the owner on 2026-09-05.

## Why

A kind is the whole extension mechanism for what a session is asked to do; it names no tools
and grants nothing, so it is cheap and safe to add. Today only two ship. The owner's daily loop
is brainstorm a plan, implement it, review it, document it, and each of those is a fixed prompt
shape that should not be re-dictated by voice every time.

## Today (main at 73d2c40)

- Kind contract in `lib/sessions.js:44-90`: `id` and `systemPrompt` required; optional
  `triggers`, `model`, `effort` (one of `EFFORT_LEVELS`), `nameHint`. `loadSessionKinds`
  (`:102`) reads `sessions/*.mjs`, skipping `_`-prefixed files.
- `beginSession` (`server.js:2052-2138`) resolves `kind=` against the loaded map (`:2053`) and
  calls `startSession({ name, sessionId, cwd, task, brief, command, systemPrompt:
  kind?.systemPrompt?.({ task, alias }), model, effort })`. `buildStartArgs`
  (`lib/spawn-session.js:98-155`) puts `command || brief || task` last; `command` must start with
  `/` and is one line, so it drops the brief by design.
- `then=` on a start tag chains a follow-up: `chainAfter(memoryStore, id, { task: then, alias,
  depth })` (`server.js:2132`); the chained start runs with `kind: null` (`server.js:460`).
- The model learns kinds and triggers from `sessionsBlock` in `lib/brain.js` (~`:111-160`),
  pinned by `test/brain.test.js`.
- README, "It runs your skills" and the `sessions/*.mjs` paragraph (~line 318): "Ships `review`
  and `tests`". Claude Code's own commands are never sendable by voice.
- Branch `worktree-brainstorm-kind` (HEAD `20b6e97`, based on `cb7aea4`, 17 files, +1496/−51,
  three review passes applied, unmerged) adds: `sessions/brainstorm.mjs`; kind fields
  `prompt({ task, brief, alias, maxChars })` composing the whole positional prompt (a slash
  command on line one expands, later lines reach the skill as arguments, verified on CLI
  2.1.259 and pinned in `test/spawn-session.test.js`), `skill` (the start refuses when it is
  not among the discovered skills; `leadingSkill(prompt)` reads it off the composed prompt when
  the field is absent, `missingSkill` does the check), and `speaksVerdict` (a finished session
  of an opted-in kind speaks the transcript's "Do This First" line through `verdictFor` in
  `lib/transcript.js`, capped at 240 chars). Two findings deliberately left open: the 64 KB
  trailing cap in `lastAssistantTexts` can drop a heading in a huge message, and a completion
  reads the transcript twice.
- Skills Dante can see for this owner include `technical-writing`, `blast-radius`,
  `council-review`. `/code-review` is a CLI built-in, not a `skills/*/SKILL.md`, so the branch's
  skill check would refuse it.

## Stage 0: merge the brainstorm branch

`git merge worktree-brainstorm-kind` onto main. Expect conflicts in `server.js`, `lib/notify.js`,
`lib/watch.js`, `lib/transcript.js` and `README.md` against the watcher, repo-letters and
message-history merges that landed after `cb7aea4`. Resolve, `npm test` green, one commit. Do
not fix the two open findings in the same commit; note them in `docs/known-limitations.md` §6.

## Stage 1: three small kinds, one file each

Copy `sessions/_template.mjs`. Each is a prompt shape only.

**`review`** (rewrite `sessions/review.mjs`): `prompt: ({ task }) => ["/code-review", task ||
"the diff against the default branch"].join("\n\n")`; keep the current `systemPrompt` text
about not fixing and not committing; `model: "opus"`, `effort: "high"`, `nameHint: () =>
"review"`. `/code-review` is a built-in, so the skill check must let it through: add an optional
kind field `builtin: true` in `validateSessionKind` meaning "the leading command is a CLI
built-in written in this file, not a discovered skill"; `missingSkill` returns null when it is
set. This does not loosen the voice rule: `command=` from a spoken turn is still matched against
discovered skills only, and the built-in name lives in a file in the repository. Say so in the
field's comment and in the README paragraph that explains why CLI commands are not sendable.

**`docs`** (`sessions/docs.mjs`): `triggers: ["docs", "documentation", "write the docs",
"update the readme"]`; `prompt: ({ task, brief, maxChars }) => ["/technical-writing", brief ||
task]` fitted to `maxChars` the way `brainstorm.mjs` fits its body; `skill: "technical-writing"`;
`systemPrompt`: this session writes documentation only, under `docs/` and `README.md`; it reads
code to describe it and never edits code, tests or configuration; it commits with a subject line
only and never pushes; it ends by naming every file it changed. `nameHint: () => "docs"`. No
model override.

**`security-review`** (`sessions/security-review.mjs`): `triggers: ["security review", "audit",
"check the deny list", "review the sandbox"]`; `prompt: ({ task, brief, maxChars }) =>
["/blast-radius", brief || task || "the diff against the default branch"]`; `skill:
"blast-radius"`; `systemPrompt`: after the blast radius, review the diff against these seams and
report: `REACHES_OUTSIDE` and `denyRules` / `deniedDirs` / `deniedFiles` in `lib/builder.js`,
argument order in `buildSpawnArgs`, the upgrade check in `server.on("upgrade")` and `decodeJwt`
never being a verification in `lib/auth.js`, `builds/` gating, the two hooks, and
`--dangerously-*` / `bypassPermissions` never appearing on any spawn line; report only, fix
nothing, commit nothing, finish with a verdict someone can act on. `model: "opus"`, `effort:
"high"`, `speaksVerdict: true` only if its output ends with a "Do This First" heading the way
the council does; otherwise leave it unset. `nameHint: () => "security-review"`.

`tests` and `brainstorm` are unchanged.

## Stage 2: the implementation kind

**`sessions/implementation.mjs`**: `triggers: ["implement the plan", "implement the brief",
"implement it", "build the plan"]`; `prompt: ({ task, brief }) => brief || task` (no skill; the
brief is the prompt); `systemPrompt`: read the brief in full before touching anything; split the
work into stages, each with a test that fails first; one commit per green stage, subject line
only, never push, never open a pull request; if a stage cannot be made green say so and stop
rather than weaken the test; report per stage with the test count. `model` unset (the owner's
tiering says sonnet implements; leave the CLI default so `DANTE`-side config decides).
`nameHint: () => "implement"`.

**Chain after brainstorm.** Two paths, same mechanism:

1. **One utterance.** "Brainstorm the plan, then implement it" already yields `then=`. Extend
   the chain record: `chainAfter(store, id, { task, alias, depth, kind, briefFrom: id })`. At the
   chained start (`server.js:460`), pass `kind: chain.kind` and, when `chain.briefFrom` is set,
   `brief: briefFor(texts) ?? originalBrief`. The persona clause: when a `then=` names an
   implementation, the model emits `then_kind=implementation`. Keep the field optional so
   existing `then=` starts behave as today.
2. **Later, by voice.** "Implement the brainstorm" yields `[ACTION:SESSION verb=start
   kind=implementation from=<name or number>]`. `beginSession` resolves `from` through
   `findTarget` (`lib/confirm.js:117`), reads that session's transcript, and uses `briefFor`
   as the brief. A start with `from=` whose source has no readable brief refuses with a spoken
   sentence, never falls back to the spoken task alone.

**`briefFor(texts)`** in `lib/transcript.js`, beside `verdictFor`: finds the last block in the
brainstorm's assistant texts shaped like the interview brief (Goal / Where / Constraints / Done
when) and returns it cleaned and capped at `MAX_BRIEF_CHARS`, or `null`. Validate with
`parseBrief` from `lib/interview.js` so a malformed block is rejected rather than half-used.
The text comes from a session transcript, so it is untrusted: `clean` and the unprintable strip
apply, and it never reaches the warm brain, only the spawn line. Store it on the brainstorm's
session record (`rememberSession(store, id, { improvedBrief })`) at completion so the `from=`
path does not re-read the transcript.

**The offer.** In the completion path for a brainstorm, after the spoken "Do This First" line,
append "Say implement it to start on it, sir." when `briefFor` found a brief. One sentence, no
proposal object: the owner's next turn is an ordinary start with `from=`, confirmed the usual
way.

**Interview.** A start with `kind=implementation` and a brief from `briefFor` has all four facets
by construction, so `readyToPropose` holds and no question is asked; the machine read-back
still runs once. `FACETS`, `docs/interview.md` and the persona paragraph do not change; if the
implementing agent finds they must, stop and say why.

## Stage 3: docs and persona

- `README.md`: the `sessions/*.mjs` paragraph lists six kinds with one clause each; the "It runs
  your skills" paragraph gets the `builtin` exception sentence; "It asks first" gets one sentence
  on `from=`.
- `docs/voice-reference.md`: trigger phrases for the four new or changed kinds and the chain.
- `sessions/_template.mjs`: document `builtin` beside `skill`.
- `lib/brain.js` `sessionsBlock`: the `from=` and `then_kind=` clauses. Pin in
  `test/brain.test.js`.

## Tests

- `test/sessions.test.js`: `loadSessionKinds` on the real `sessions/` directory yields exactly
  the six ids; each kind's `prompt` (where present) opens with its slash command, fits
  `maxChars` keeping the command line whole, and `missingSkill` accepts `builtin: true` while
  still refusing an unknown `skill` name; `validateSessionKind` rejects `builtin: "yes"`.
- `test/spawn-session.test.js`: argv for a `docs` start ends with a positional prompt whose
  first line is `/technical-writing`; for `implementation` the positional prompt is the brief
  itself; `FORBIDDEN` still refuses on every kind.
- `test/transcript.test.js`: `briefFor` finds the last well-formed brief, ignores a malformed
  one, caps, strips unprintables, returns `null` on none.
- `test/memory.test.js`: `chainAfter` round-trips `kind` and `briefFrom`; an old record without
  them still loads.
- `test/brain.test.js`: persona pins.
- `test/confirm.test.js`: `findTarget` resolves `from=` by name and by number.

## Done when

- `claude agents` shows `jarvis-N-brainstorm` finishing, Dante speaks the Do This First line and
  the offer, "implement it" proposes an implementation session in the same repository whose
  brief is the brainstorm's rewritten one, the read-back names its goal, and yes starts it.
- "Review this" starts a session whose first prompt line is `/code-review`; "write the docs for
  this" starts one whose first line is `/technical-writing` and whose diff touches only `docs/`
  and `README.md`; "security review" starts one whose first line is `/blast-radius` and that
  commits nothing.
- `npm test` green; no new dependency; no change to `FACETS` or `docs/interview.md`.

## Out of scope

A kind that grants tools (that is a primitive). Running two kinds in one session. Auto-starting
the implementation without a yes.
