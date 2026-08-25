# Jarvis Roadmap: from artifact builder to voice control plane for Claude Code

## Context

`jarvis-demo` shipped twenty stages (`docs/memory-and-orchestration-plan.md`) and is now a
complete, fast voice loop: push-to-talk in Chrome, a warm `claude -p` CLI answering in ~800 ms,
Fish Audio speaking the reply as it streams, cross-session memory on disk, and a machine-tag
dispatch path that spawns real Claude Code builds with file tools on.

What it is *not* yet is a coding assistant. It builds throwaway artifacts in `builds/<timestamp>/`
and its deny list explicitly forbids touching real source. The stated target is different:

> Jarvis should be primarily designed to orchestrate Claude Code sessions for me via my voice
> commands. Meaning spin up new sessions, interact with existing ones, get info from existing
> sessions and report back to me (via a Slack webhook) once a Claude Code session needs attention
> or is complete, with concise info.

So: a **voice control plane over the Claude Code sessions running on this machine**, with Slack as
the durable out-of-band channel. Jarvis stays read-only on repositories; the sessions it starts do
the writing, under the user's own permissions.

### Decisions fixed in the interview

| | |
|---|---|
| Jarvis's own repo access | **Read-only.** It never edits your source itself. |
| Code output | **Voice only.** No code panel, no editor hand-off, no reading symbols aloud. |
| Spawned session permissions | **Your normal default** — voice-started and hand-started sessions behave identically. |
| Session naming | `jarvis-1-builder-test-fix` — repo alias, per-workspace counter, task-derived slug. |
| Follow-up to a busy session | **Queue it**, deliver the moment it goes idle. |
| Concurrency | **Cap of five** voice-started sessions. |
| Session kinds | A `sessions/*.mjs` registry mirroring `primitives/`. |
| Chaining | **Conditional** — chain on success, report on failure. |
| Slack | Bot token + `chat.postMessage`, **one thread per session**. Outbound only, no inbound. |
| Slack events | started, needs-attention, complete, failed — all four. |
| Voice vs Slack | **Slack always; voice too if the page is open and the floor is free.** |
| Completion summaries | A cheap **Haiku pass** over the session transcript. |
| Voice approval | **Yes, scoped** to file writes outside the repo and publishing git operations. |
| Hook install | **You paste it**; the README documents it. Jarvis never writes `~/.claude/`. |
| Hands-free / wake word | **No.** Push-to-talk is fine. |
| Remote access | **Already works** as intended. Not on this roadmap. |
| `primitives/` builds | **Keep**, and repoint the tree HUD at session progress. |
| First slice | **Phases A and B** (stages 21–28), then reassess. |

---

## What jarvis can do today

**Input.** Chrome Web Speech push-to-talk. Self-interruption is merged rather than dropped —
`mergeTurns` (`lib/turns.js`) carries up to three unanswered sentences, newest first, labelled. A
turn in flight is superseded via `AbortController`; `createTurnGate` guarantees an overtaken answer
is never spoken. There is a cancel button.

**Brain.** One warm `claude -p` per server lifetime (`createBrainSession`, `lib/brain.js:281`),
`--input-format stream-json` in and out. Haiku 4.5, `--tools ""`, no MCP — 2,076 input tokens per
turn instead of 12,082, ~800 ms per turn after the first. Generation-tracked so two tabs sharing
the CLI cannot kill each other's process.

**Memory.** `~/.config/jarvis/memory.json`, keyed by the server's cwd (`lib/memory.js`): resumable
`sessionId`, a rolling `summary` written on socket close after three turns, standing `preferences`
from a `[MEMORY:SET k=v]` tag, and the last ten `artifacts`. Everything that re-enters a prompt is
sanitized and capped — the store is treated as a prompt-injection surface, deliberately.

**Dispatch.** `parseAction` (`lib/action.js`) strips `[ACTION:BUILD ...]` and `[MEMORY:SET ...]`
before anything is spoken. Actions resolve against `lib/registry.js`, which auto-loads
`primitives/*.mjs` — and the persona's list of buildable things is *generated from that registry*,
so a new file teaches the assistant about itself with no prompt edit.

**Builds.** `lib/builder.js` spawns real Claude Code with file tools in a fresh
`builds/<timestamp>/`, streams progress into a tree HUD, enforces a timeout, judges success by
`outputContract`. Two deny layers. `steps: [...]` chains plan → build → verify. One at a time.

**Output.** Fish Audio S2.1 in `balanced` mode, streamed over MediaSource so first sound lands
~1.5 s in. Reactive orb, build HUD, diagnostics panel.

**Constraints.** One npm dependency (`ws`). `node:test` only. Pure functions are the test seam;
everything impure takes an injectable override.

### The four gaps

1. **No visibility** — jarvis has no idea what Claude Code sessions exist.
2. **No spawn verb** — the only thing it can start is a throwaway build.
3. **No way back in** — nothing can send a follow-up to a running session.
4. **No out-of-band channel** — walk away and everything it knows is lost.

---

## The load-bearing discovery

`tmux` is **not installed** here, and is not needed. Claude Code ships the control plane
natively:

| Need | Command | Status |
|---|---|---|
| List every live session | `claude agents --json` | **Verified** — returns an array of session records |
| Filter to one repo | `claude agents --json --cwd <path>` | documented |
| Include finished | `claude agents --json --all` | documented |
| Start detached | `claude --bg -n "<name>" --session-id <uuid>` | **Verified** — `--bg`, `-n`, `--session-id`, `--model`, `--effort` and `--append-system-prompt` are all present in `claude --help` |
| Send a follow-up | `claude -p --resume <id> --output-format json` | already the cold path in `lib/brain.js` |
| Stop one | `SIGTERM` the `pid` from the roster | — |

`claude agents --json` explicitly "does not require a TTY (for scripting)" — a plain
`child_process` call, the shape `lib/builder.js` already uses. It sees sessions jarvis did not
start, which is exactly what tmux would have bought, without a system dependency.
`--session-id <uuid>` lets jarvis assign the id at spawn rather than scraping it back out.

**The record shape, as actually observed.** A live listing on this machine returned six sessions,
and the important detail is how much of the record is *optional*:

```json
{
  "pid": 1308510,
  "id": "3b139d5b",
  "cwd": "/home/krane/development/jarvis",
  "kind": "background",
  "startedAt": 1787659118525,
  "sessionId": "3b139d5b-d998-4168-9a8c-6afae89909b8",
  "name": "roadmap-expansion",
  "status": "busy",
  "state": "working"
}
```

- `sessionId`, `pid`, `cwd`, `kind`, `startedAt` and `name` were present on every record. Only
  `sessionId` is treated as required by the parser; everything else has a fallback.
- `id` (the short form) appears on background agents and is **absent on interactive ones**.
- `state` is absent on some interactive sessions, and is not limited to `working`/`done` — a live
  session reported `"blocked"`. Treat it as an open vocabulary.
- `status` was absent on one interactive session entirely.
- `startedAt` is **epoch milliseconds as a number**, not an ISO string.

That is why `parseRoster` normalises rather than validates: a record missing half its fields is
still a session that exists, and dropping it would make jarvis confidently wrong about what is
running.

---

## Roadmap

Numbering continues the existing plan doc. **Stages 21–28 are the committed first slice.**

| # | Stage | Creates | Modifies |
|---|---|---|---|
| **A** | **See the sessions** — read-only | | |
| 21 | `lib/agents.js` — the roster | `lib/agents.js`, `test/agents.test.js` | — |
| 22 | Roster reaches the model | — | `lib/turns.js`, `test/turns.test.js`, `server.js` |
| 23 | Workspaces and aliases | — | `lib/memory.js`, `test/memory.test.js` |
| **B** | **Drive the sessions** | | |
| 24 | `sessions/*.mjs` registry | `lib/sessions.js`, `sessions/*.mjs`, `test/sessions.test.js` | `lib/brain.js`, `test/brain.test.js` |
| 25 | `verb=start` | `lib/spawn-session.js`, `test/spawn-session.test.js` | `lib/action.js`, `server.js` |
| 26 | The roster poller | — | `lib/agents.js`, `test/agents.test.js`, `server.js` |
| 27 | `verb=tell` + idle queue | — | `lib/spawn-session.js`, `test/spawn-session.test.js`, `server.js` |
| 28 | `verb=stop` | — | `lib/spawn-session.js`, `test/spawn-session.test.js` |
| **C** | **Report back** | | |
| 29 | `lib/slack.js` — threaded sink | `lib/slack.js`, `test/slack.test.js` | `server.js` |
| 30 | `lib/transcript.js` + Haiku summaries | `lib/transcript.js`, `test/transcript.test.js` | `server.js` |
| 31 | `lib/notify.js` — event prose | `lib/notify.js`, `test/notify.test.js` | `server.js` |
| 32 | The hook bridge | `hooks/jarvis-notify.mjs` | `server.js`, `README.md` |
| 33 | Voice approval | `lib/approval.js`, `hooks/jarvis-approve.mjs`, `test/approval.test.js` | `server.js`, `public/app.js` |
| **D** | **Polish** | | |
| 34 | Interjection policy | — | `public/playback-policy.js`, `test/playback-policy.test.js`, `public/app.js` |
| 35 | Sessions in the tree HUD | — | `public/build-hud.js`, `public/app.js`, `public/progress-policy.js` |
| 36 | Conditional chaining | — | `lib/sessions.js`, `test/sessions.test.js`, `server.js` |
| 37 | "Catch me up" | — | `lib/notify.js`, `lib/memory.js`, `server.js` |
| 38 | Read-only repo questions | `primitives/ask-repo.mjs` | — |

---

### Phase A — see the sessions

#### Stage 21 — `lib/agents.js`

Wrap `claude agents --json` in the split the repo already uses: a pure parser, a thin impure
runner with an injectable `opts.bin`, tested against a fake CLI written to disk (`writeFake` in
`test/builder.test.js`).

```
parseRoster(stdout)              -> [{ sessionId, id, name, cwd, kind, status, state, pid, startedAt }]
listAgents(opts)                 -> Promise<roster>
describeRoster(roster, aliases)  -> one short spoken line
diffRoster(previous, next)       -> events[]        // added in Stage 26
```

`parseRoster` must never throw. A CLI version that renames a field costs jarvis its roster for one
turn, never the turn itself: a non-array top level, malformed JSON, or a missing `sessionId`
degrades to `[]` — the posture of `loadStore` and `readSharedSettings`.

`describeRoster` is where voice-only bites: `"three running: jarvis-1 fixing the builder test, four
minutes; fitness-2 idle; htmltest-1 done"`. Never a uuid, never a pid, never a path. Cap the list —
ten sessions recited aloud is a hostage situation.

#### Stage 22 — the roster reaches the model

`server.js:62` records the trap: a warm CLI keeps the system prompt it was spawned with, so a
rebuilt persona does not reach the model until the next cold start. The roster changes every few
seconds, so it **cannot** live in the persona.

It goes in the turn. `lib/turns.js` already owns "what a call carries" — `mergeTurns` frames
self-interruption there rather than in the persona precisely because it then costs nothing on turns
that do not need it. Same seam, same reason:

```
mergeTurns(texts, { roster }) -> the one thing to ask
```

With a roster supplied, the merged turn is prefixed by one `describeRoster` line and a sentence
saying this is current machine state, not conversation. Absent, the function is byte-identical to
today — which is what keeps every existing `turns.test.js` assertion valid.

`server.js` calls `listAgents()` just before `mergeTurns` (~50 ms of `child_process`); a failed
listing passes `null` and the turn proceeds without it.

After this stage, with **no new tag and no tools**, "what's running?", "is fitness done?" and "how
long has jarvis been at it?" all answer correctly.

#### Stage 23 — workspaces and aliases

A `cwd` is not a thing anyone says aloud. Add `workspaces` to the memory store —
`{ jarvis: "/home/krane/development/jarvis", fitness: "/home/krane/development/KraneticFitness" }`
— defaulting each alias to the directory basename, settable by voice through the existing
`[MEMORY:SET]` path. Also holds the per-workspace session counter that makes `jarvis-1`, `jarvis-2`.

Existing `sanitizePreferences` caps apply, plus one new rule that is a **security boundary**, not
tidiness: a workspace path must be an existing directory under `$HOME`, fully resolved, with no
symlink escape. It becomes a real `cwd` for a real Claude Code session in Stage 25.

---

### Phase B — drive the sessions

#### Stage 24 — the `sessions/*.mjs` registry

Mirror `primitives/` exactly, because that pattern is proven: one file in, one new session kind,
zero wiring, and the persona's list generated from the folder rather than hand-written.

```js
export default {
  id: "review",
  triggers: ["review", "code review", "look over"],
  model: "opus",                       // optional
  effort: "high",                      // optional
  systemPrompt: (p) => `Review the uncommitted changes in this repo. ...`,
  nameHint: (p) => "review",           // feeds the session name slug
};
```

`lib/sessions.js` loads and validates them with the same shape as `lib/registry.js`
(`validateSessionKind`, `loadSessionKinds(dirUrl)`), read once at startup for the same reason:
a half-saved edit must not break a live conversation.

Crucially **no `allowedTools` and no deny list**. A session kind shapes the prompt and the model;
it does not restrict the session, because the session runs under your normal permissions by
decision. Free-form remains available — `verb=start` with a task and no kind is the default path.

Naming, per the interview: `<alias>-<n>-<task-slug>` → `jarvis-1-builder-test-fix`. `buildName()`
is pure: alias from workspaces, `n` from the per-workspace counter in memory, slug from the task
(lowercased, non-alphanumerics collapsed, capped at four or five words). Collisions get a suffix.

#### Stage 25 — `[ACTION:SESSION verb=start repo=<alias> task="..." kind=<id>]`

`parseAction` already tolerates any verb after the colon (`lib/action.js:7` notes a future
`[ACTION:DEPLOY ...]` is stripped correctly today), so this is a `session` branch in the
dispatcher, not a new parser.

`lib/spawn-session.js` builds argv and spawns:

```
claude --bg -n "<name>" --session-id <uuid> [--model <m>] [--effort <e>]
       [--append-system-prompt "<kind prompt>"] -- "<task>"
```

in the resolved workspace directory. `buildStartArgs(spec)` is pure and tested; `startSession` is
the thin impure caller. Jarvis records `{ uuid, alias, name, task, kind, startedAt }` in memory,
speaks one short confirmation, posts the Slack parent message (Phase C), and returns. It never
waits — that is the whole point.

**Cap of five.** Counted from the roster, not from a local tally, so a session you started in a
terminal counts too, and a session that died does not. A sixth request gets "you've got five
running, sir" and names the oldest idle one as the obvious thing to stop.

**Security posture, stated deliberately.** These sessions run with your settings, your permissions,
your hooks, your MCP servers. Jarvis imposes no deny list, because you asked for an orchestrator,
not a sandbox, and a jarvis-shaped restriction would only make voice-started sessions weaker than
terminal-started ones for no real gain. Three rules keep that deliberate rather than careless:

- **Never pass `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`,** and
  expose no voice phrase that can. Voice is a lossy channel; a misheard sentence must not be able
  to remove every guardrail. If you want that mode, you type it in a terminal.
- **The task string arrives through a model-authored tag.** Cap it, strip control characters and
  bidi overrides using the `UNPRINTABLE` class at `lib/memory.js:37`, and pass it after `--` so it
  can never be read as a flag.
- **`lib/builder.js` is not touched.** Builds and sessions have different rules; merging them would
  put deny-list machinery on a path that deliberately has none.

#### Stage 26 — the roster poller

Pulled forward from where it naturally sits, because Stage 27's queue and Stage 36's chaining both
need it, and Phase C's reporting is more reliable with it.

Poll `claude agents --json` every five seconds and diff. A session leaving the roster, or moving
`state: working → done` or `status: busy → idle`, is an event. `diffRoster(previous, next)` is pure
and is where the tests live. The poller runs whether or not a browser is connected — that is what
makes Slack reporting work while you are away.

#### Stage 27 — `verb=tell`, with an idle queue

```
claude -p --resume <sessionId> --output-format json -- "<text>"
```

in that session's `cwd` — the cold path `lib/brain.js` already implements.

**The gotcha, and it is real:** resuming a session that is *currently working* is not a join. Two
processes on one session id is exactly the race `askResilient` and `conv.settled` exist to prevent
inside jarvis, and it is worse across processes.

So `verb=tell` is gated on the roster. An `idle` session takes the follow-up immediately. A `busy`
one gets it **queued** — jarvis says "queued, sir", stores it against that `sessionId` in memory,
and the Stage 26 poller delivers it on the first tick that sees the session idle. Queued text is
capped and expires, so a follow-up from two hours ago does not surprise a session tomorrow.
`--fork-session` is the wrong tool here: it starts a *new* conversation, which is not what "also
run the tests" means.

The reply comes back as JSON, is compressed to a sentence or two, and is spoken.

#### Stage 28 — `verb=stop`

`SIGTERM` the `pid` from the roster, then confirm the session left the roster before speaking.
Refuse by name, never by index — "stop the third one" is precisely the sentence that gets misheard.
Never `SIGKILL`: a session mid-write should be allowed to finish the write.

---

### Phase C — report back

#### Stage 29 — `lib/slack.js`

Threading needs a message timestamp back from Slack, and an incoming webhook returns only `ok`. So
this uses a **bot token and `chat.postMessage`** — still strictly outbound, no Socket Mode, no
inbound surface of any kind.

Config at `~/.config/jarvis/slack.json` (`{ botToken, channel }`), mirroring `lib/config.js`, with
`JARVIS_SLACK_TOKEN` overriding. Unlike `loadFishConfig`, a missing config **does not throw at
startup** — Slack is an enhancement, and a user without it should still get a working assistant.

```
postParent(text)             -> Promise<ts | null>   // one per session, at start
postReply(ts, text)          -> Promise<boolean>     // every later event for that session
```

Uses global `fetch` (Node 20), times out, never throws, returns null/false on failure. A Slack
outage costs a notification, never a turn. The `ts` is stored beside the session in memory, so
every event for `jarvis-1-builder-test-fix` lands in one thread. The token is a credential: it
never appears in a log line, a `debug` message, or anything crossing the WebSocket.

#### Stage 30 — `lib/transcript.js` and the Haiku summary

"Concise info" needs a real summary, and the interview settled on generating one rather than
scraping the session's last message — which is a lottery when a session ends mid-tool-call, and
absent exactly when a session crashes.

`lib/transcript.js` reads `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` — the format is
one JSON object per line, verified. `tailMessages(path, n)` returns the last few assistant turns,
skipping the `hook_success` attachments and metadata records. Pure `slugForCwd(cwd)` maps
`/home/krane/development/jarvis` → `-home-krane-development-jarvis`, which is the naming scheme on
disk today and should be treated as an observed convention, not a contract: an unreadable
transcript degrades to "no summary available", never to an error.

The summary itself reuses the cold `ask()` path with a dedicated persona, exactly as
`SUMMARY_PERSONA` at `server.js:446` already does for conversation summaries. Haiku, ~300 ms, one
sentence, no markdown. Transcript content is untrusted input to that call — it contains whatever
the session read from disk or the web — so the summarizer prompt states plainly that the transcript
is data to be summarized and never instructions to follow, and the result is capped and sanitized
before it reaches Slack or the voice.

#### Stage 31 — `lib/notify.js`

Pure, and the only place the wording lives:

```
formatEvent({ kind, name, alias, task, durationMs, summary, detail }) -> string
```

`kind` is `started` | `needs-attention` | `complete` | `failed`. All four go to Slack;
`started` is the thread parent, the rest are replies.

> `jarvis-1-builder-test-fix · started · "fix the failing builder test"`
> `└ waiting on you — wants to write outside the repo`
> `└ done in 4m 12s — fixed the timeout assertion and added a regression test`

Voice gets a shorter form of the same event, and only when the page is open and the floor is free
(Stage 34). Slack is unconditional and durable; voice is the convenience.

`detail` originates in a hook payload and is untrusted — sanitize and cap it here with the same
`UNPRINTABLE` class and `cleanText` posture as `lib/memory.js`.

#### Stage 32 — the hook bridge

Add `POST /hook` to the existing `createServer` handler. It stays **strictly loopback** — that is
this endpoint's entire security model, and it does not change even though the rest of the server is
reachable over the VPN.

- Reject anything but `POST`, a small `Content-Length`, `application/json`.
- Parse strictly; anything unexpected is dropped silently. Any local process can reach this, and it
  must never become a way to make jarvis say arbitrary things.
- **Nothing from the payload reaches a model prompt.** It reaches `formatEvent` and the speaker,
  both of which sanitize.

Ship `hooks/jarvis-notify.mjs`: a small `node:`-only script that reads the hook event on stdin and
POSTs it to `http://127.0.0.1:3210/hook`. You wire it into `~/.claude/settings.json` under `Stop`,
`Notification` and `SessionEnd`; the README documents the snippet. **Jarvis never writes
`~/.claude/` itself** — its own build deny list forbids exactly that, on the grounds that hooks are
code that runs on your next session, and it would be incoherent for the assistant to make an
exception for itself.

Verify the three event names against the installed CLI before writing this stage. Your settings
already register `PreToolUse` and `UserPromptSubmit`, so the mechanism is known good here, but
these names must be checked rather than assumed.

Hooks only fire for sessions whose config had them at startup, so the Stage 26 poller stays the
floor and hooks are the fast path. Dedupe by `sessionId` + `kind` within a short window.

#### Stage 33 — voice approval

The highest-value stage in the roadmap, and a direct consequence of sessions running under your
normal permissions: a `PreToolUse` hook can **block and return a decision**, so a session hitting a
prompt can ask you out loud and wait.

**Scoped, per the interview, to two things:** file writes outside the session's own repo, and git
operations that publish (`git push`, PR creation — anything that leaves the machine). Everything
else falls through to normal terminal behaviour. This is the smallest set with the highest
consequence, which is the right trade for a channel that interrupts you.

```
inApprovalScope(toolName, input, workspaceRoot) -> null | { kind, spoken }
parseYesNo(text)                                -> "yes" | "no" | "unclear"
```

Both pure, both in `lib/approval.js`, both heavily tested — `inApprovalScope` decides whether you
get interrupted, and `parseYesNo` decides whether a `git push` happens.

`hooks/jarvis-approve.mjs` POSTs the tool call to `/approve` and blocks on the response. Server
side:

- **No connected browser → return no decision immediately.** The session falls back to its normal
  behaviour and Slack gets a "needs attention". Never auto-deny for want of a listener; that would
  silently break every session started while you are away, which is when you most need them working.
- **Browser connected →** speak the request (`"jarvis-1 wants to push to origin — allow?"`), open a
  short listening window, and decide.
- **The answer never goes through the model.** `parseYesNo` is a strict vocabulary. An `unclear`
  re-asks once, then returns no decision and falls through. Routing this through the LLM would make
  a prompt-injected tool description able to argue for its own approval.
- **A generous timeout** (60 s), after which: no decision, fall through, Slack gets the event. The
  session is never left hanging on an empty room, and is never denied by silence either.

---

### Phase D — polish

**Stage 34 — interjection policy.** Stage 15 established one-voice-at-a-time in
`public/playback-policy.js`; this adds a tier: announcements **never barge in**. They queue and are
spoken when the floor is genuinely free — not during a reply, not while the mic is open, not while
a question is pending. An announcement older than a couple of minutes is dropped rather than spoken
stale; it already went to Slack, which is the durable channel. Approval requests are the one
exception and jump the queue, because something is blocked on them. Pure client module, unit-tested
like the others.

**Stage 35 — sessions in the tree HUD.** `public/build-hud.js` is the most developed UI in the repo
and it now describes the less important thing. Repoint it: one node per running session, its state
and elapsed time, its last progress line. Builds keep their existing rendering — this is a second
tree in the same component, not a replacement.

**Stage 36 — conditional chaining.** One session may name a successor, started **only on success**;
a failure reports instead of chaining. The Stage 26 poller already detects both, so this is a small
table in memory plus a dispatch. Chains are capped in depth and expire, and a chained session
counts against the five-session cap like any other.

**Stage 37 — "catch me up."** An event log in the memory store, capped like `artifacts`. "What
happened while I was out" replays it as one spoken paragraph and clears the announcement queue.
This is what makes walking away actually work.

**Stage 38 — read-only repo questions.** Last on purpose: once Phase B lands, the honest answer to
most code questions is "ask the session already in that repo." But `primitives/ask-repo.mjs` —
`allowedTools: ["Read", "Grep", "Glob"]`, the existing deny floor forbidding everything else,
answering in prose — covers the case where nothing is running. One file, no wiring, exactly as the
registry promises.

---

## Deliberately not on this roadmap

- **Jarvis editing your source.** Read-only. The sessions it starts do the writing.
- **A code panel or editor hand-off.** Voice-only, by decision.
- **Wake word / hands-free.** Push-to-talk stays.
- **Remote access work.** Already working as intended.
- **Anything inbound from Slack.** Outbound `chat.postMessage` only.
- **tmux.** Not installed, and natively unnecessary.
- **Builds spawning sub-builds.** Skipped in the original guide for widening the sandbox; skipped
  here for the same reason.
- **`bypassPermissions` by voice.** Never, on any path.

---

## Verification

**The baseline this roadmap starts from.** `npm test` green at 368 tests, on the branch
`feat/session-orchestration`.

**Re-check before executing any phase** — the CLI ships weekly and these facts are load-bearing.
Both were verified when this document was written:

```bash
claude agents --json | head -20                # the record shape above still holds
claude --help | grep -E -- '--bg|--session-id|-n,|--append-system-prompt|--effort'
```

**Per phase, once implemented:**

- **A** — start a session by hand in another repo; ask jarvis "what's running?". It names the repo
  and its state without being told anything. Kill the CLI mid-listing and confirm the turn still
  answers, just without the roster.
- **B** — "start a session in jarvis to read the README": `claude agents --json` shows a new
  background session in that cwd within a second, named `jarvis-N-read-the-readme`. Say "tell it to
  summarize what it found" **while it is busy** and confirm jarvis queues rather than forks — then
  confirm delivery once it goes idle. Start six sessions and confirm the sixth is refused by name.
  "Stop jarvis one" and confirm it leaves the roster.
- **C** — install the hook snippet, run a short session, confirm exactly **one** Slack thread with a
  parent and threaded replies (not two — the poller and hooks must dedupe). Confirm the completion
  reply carries a real one-sentence summary. Kill the jarvis server mid-session and confirm the
  session itself is unaffected. For Stage 33: trigger a `git push` from a session with the browser
  closed and confirm it falls through rather than denying; repeat with the browser open and answer
  by voice both ways.
- **D** — start a long session, walk away, come back, "catch me up".

Every stage leaves `npm test` green and the browser working before the next starts — the rule the
first twenty stages ran under, unchanged.
