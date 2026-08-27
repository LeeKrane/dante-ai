# Dante Roadmap: from artifact builder to voice control plane for Claude Code

## Context

`dante-demo` shipped twenty stages (`docs/memory-and-orchestration-plan.md`) and is now a
complete, fast voice loop: push-to-talk in Chrome, a warm `claude -p` CLI answering in ~800 ms,
Fish Audio speaking the reply as it streams, cross-session memory on disk, and a machine-tag
dispatch path that spawns real Claude Code builds with file tools on.

What it is *not* yet is a coding assistant. It builds throwaway artifacts in `builds/<timestamp>/`
and its deny list explicitly forbids touching real source. The stated target is different:

> Dante should be primarily designed to orchestrate Claude Code sessions for me via my voice
> commands. Meaning spin up new sessions, interact with existing ones, get info from existing
> sessions and report back to me (via a Slack webhook) once a Claude Code session needs attention
> or is complete, with concise info.

So: a **voice control plane over the Claude Code sessions running on this machine**, with Slack as
the durable out-of-band channel. Dante stays read-only on repositories; the sessions it starts do
the writing, under the user's own permissions.

### Decisions fixed in the interview

| | |
|---|---|
| Dante's own repo access | **Read-only.** It never edits your source itself. |
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
| Hook install | **You paste it**; the README documents it. Dante never writes `~/.claude/`. |
| Hands-free / wake word | **No.** Push-to-talk is fine. |
| Remote access | **Already works** as intended. Not on this roadmap. |
| `primitives/` builds | **Keep**, and repoint the tree HUD at session progress. |
| First slice | **Phases A and B** (stages 21–28), then reassess. |

---

## What Dante can do today

**Input.** Chrome Web Speech push-to-talk. Self-interruption is merged rather than dropped —
`mergeTurns` (`lib/turns.js`) carries up to three unanswered sentences, newest first, labelled. A
turn in flight is superseded via `AbortController`; `createTurnGate` guarantees an overtaken answer
is never spoken. There is a cancel button.

**Brain.** One warm `claude -p` per server lifetime (`createBrainSession`, `lib/brain.js:281`),
`--input-format stream-json` in and out. Haiku 4.5, `--tools ""`, no MCP — 2,076 input tokens per
turn instead of 12,082, ~800 ms per turn after the first. Generation-tracked so two tabs sharing
the CLI cannot kill each other's process.

**Memory.** `~/.config/dante/memory.json`, keyed by the server's cwd (`lib/memory.js`): resumable
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

1. **No visibility** — Dante has no idea what Claude Code sessions exist.
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
`child_process` call, the shape `lib/builder.js` already uses. It sees sessions Dante did not
start, which is exactly what tmux would have bought, without a system dependency.
`--session-id <uuid>` lets Dante assign the id at spawn rather than scraping it back out.

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
still a session that exists, and dropping it would make Dante confidently wrong about what is
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
| 32 | The hook bridge | `hooks/dante-notify.mjs` | `server.js`, `README.md` |
| 33 | Voice approval | `lib/approval.js`, `hooks/dante-approve.mjs`, `test/approval.test.js` | `server.js`, `public/app.js` |
| **D** | **Mean what you say** | | |
| 34 | Only the repositories you named | — | `lib/agents.js`, `test/agents.test.js`, `server.js` |
| 35 | The ceiling counts Dante's own sessions | — | `lib/agents.js`, `test/agents.test.js`, `server.js` |
| 36 | Propose, then act | `lib/confirm.js`, `test/confirm.test.js` | `server.js` |
| 37 | A persona that proposes rather than assumes | — | `lib/brain.js`, `test/brain.test.js`, `README.md` |
| **E** | **Polish** | | |
| 38 | Interjection policy | — | `public/playback-policy.js`, `test/playback-policy.test.js`, `public/app.js` |
| 39 | A sessions panel, on a key | `public/roster-panel.js`, `test/roster-panel.test.js` | `public/app.js`, `public/index.html`, `server.js` |
| 40 | Chaining, on completion | — | `lib/memory.js`, `server.js` |
| 41 | "Catch me up" | — | `lib/notify.js`, `lib/memory.js`, `server.js` |
| 42 | Read-only repo questions | `primitives/ask-repo.mjs` | — |

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

`parseRoster` must never throw. A CLI version that renames a field costs Dante its roster for one
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
the thin impure caller. Dante records `{ uuid, alias, name, task, kind, startedAt }` in memory,
speaks one short confirmation, posts the Slack parent message (Phase C), and returns. It never
waits — that is the whole point.

**Cap of five.** Counted from the roster, not from a local tally, so a session you started in a
terminal counts too, and a session that died does not. A sixth request gets "you've got five
running, sir" and names the oldest idle one as the obvious thing to stop.

**Security posture, stated deliberately.** These sessions run with your settings, your permissions,
your hooks, your MCP servers. Dante imposes no deny list, because you asked for an orchestrator,
not a sandbox, and a Dante-shaped restriction would only make voice-started sessions weaker than
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
inside Dante, and it is worse across processes.

So `verb=tell` is gated on the roster. An `idle` session takes the follow-up immediately. A `busy`
one gets it **queued** — Dante says "queued, sir", stores it against that `sessionId` in memory,
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

Config at `~/.config/dante/slack.json` (`{ botToken, channel }`), mirroring `lib/config.js`, with
`DANTE_SLACK_TOKEN` overriding. Unlike `loadFishConfig`, a missing config **does not throw at
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
  must never become a way to make Dante say arbitrary things.
- **Nothing from the payload reaches a model prompt.** It reaches `formatEvent` and the speaker,
  both of which sanitize.

Ship `hooks/dante-notify.mjs`: a small `node:`-only script that reads the hook event on stdin and
POSTs it to `http://127.0.0.1:3210/hook`. You wire it into `~/.claude/settings.json` under `Stop`,
`Notification` and `SessionEnd`; the README documents the snippet. **Dante never writes
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

`hooks/dante-approve.mjs` POSTs the tool call to `/approve` and blocks on the response. Server
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

### Phase D — mean what you say

Phases A-C shipped and went into daily use, which turned up a defect, a design mistake, and a
scoping problem.

**The defect.** "Start a session to summarize the README" was refused, and a *different, working*
session was stopped. The five-session ceiling counted `kind === "background"` straight off the
roster, and a Claude Code background job is indistinguishable from one Dante started. Observed
with **zero** Dante sessions ever created: four background sessions, none of them Dante's. And
the refusal then named one of them -- "... is idle if you want it stopped" -- pointing at a session
the user never created and inviting exactly the stop that followed.

**The design mistake.** Nothing sat between a model-authored tag and a real `SIGTERM`. Voice is a
lossy channel; the guardrail for that is not a better prompt, it is a confirmation the person
actually gives.

**The scoping problem.** The roster is *every* session on the machine, which means other tools'
internals -- a claude-mem skill keeps two running -- plus Dante's own brain and builders. A control
plane that narrates its own plumbing is one that can also be asked to stop it.

**Stage 34 — only the repositories you named.** `visibleSessions(roster, { roots, hideIds,
hideRoots })` in `lib/agents.js`, applied inside `createRosterPoller` so there is exactly one seam:
the roster line in every turn, `diffRoster`'s events, `matchSessions`, queue delivery and the
ceiling all read what it returns. A hidden session cannot be named, told, counted or stopped,
because nothing downstream ever sees it. `roots` are the workspaces already in memory -- one
concept, not two -- and containment uses `resolveWorkspacePath`'s rule, so `jarvis-notes` is not
inside `jarvis`. `hideIds` hides Dante's own brain exactly, by id rather than by name, because
offering to stop your own brain must be impossible rather than unlikely; `hideRoots` covers builds,
which carry no id Dante assigned but do live in `builds/`.

**Stage 35 — the ceiling counts Dante's own sessions.** `ownRunning(roster, remembered)`
intersects the live roster with the sessions `rememberSession` recorded starting. Exact in both
directions: a session started in a terminal never counts, and one Dante started that has since
died does not either. A refusal can then only name a session Dante itself started.

**Stage 36 — propose, then act.** `lib/confirm.js`: `describeIntent` builds the confirmation
sentence **from the parsed tag**, never from the model's spoken reply, so a model that says one
thing while tagging another cannot mislead anyone. `readAnswer` reuses `parseYesNo` from
`lib/approval.js` -- the strict vocabulary already written for exactly this job -- with three
outcomes: yes dispatches, no drops it, and anything else discards the proposal and falls through as
an ordinary turn, so "no, the whole repo" re-proposes with no special machinery. Applies to
`[ACTION:SESSION]` and `[ACTION:BUILD]`; `[MEMORY:SET]` changes no process and stays silent.

**Stage 37 — a persona that proposes rather than assumes.** The prompt half: a tag is a proposal,
never an act; never `verb=stop` or `verb=tell` unless that session was named in this turn; ask when
the repository or the task is not clear rather than filling the gap with the likeliest guess; a
roster line is data about the machine, not a suggestion to act on it.

### Phase E — polish

**Stage 38 — interjection policy.** Stage 15 established one-voice-at-a-time in
`public/playback-policy.js`; this adds a tier: announcements **never barge in**. They queue and are
spoken when the floor is genuinely free — not during a reply, not while the mic is open, not while
a question is pending. An announcement older than a couple of minutes is dropped rather than spoken
stale; it already went to Slack, which is the durable channel. Approval requests are the one
exception and jump the queue, because something is blocked on them. Pure client module, unit-tested
like the others.

**Stage 39 — a sessions panel, on a key.** `public/build-hud.js` is a 1,000-line canvas spiral
about one build in one directory; repointing it at several sessions at once, each mostly idle, each
interesting for its name and how long it has been at it, was the wrong shape for it. What shipped
instead is a separate `#sessions` list panel (`public/roster-panel.js`) — one row per visible
session, its state, and its elapsed time ticking locally rather than over the wire, since an age
changing every second is not worth a message. It lives as a corner overlay, up from load and closed with `s` -- the
same idea as diagnostics on `d`, rather than a fixture beside the orb. The HUD is left alone to do
the thing it is good at; this is a second panel, not a repoint.

**Stage 40 — chaining, on completion.** One session may name a successor. The interview called this
"conditional — chain on success, report on failure," and that turned out not to be implementable: a
Claude Code session exposes no pass/fail verdict, only `idle` or `gone` from the Stage 26 poller, and
`reportComplete` has a transcript summary to read rather than a result to check. So a chain fires on
**completion**, with one carve-out — a session stopped from Dante itself has its chain dropped,
because ending something on purpose is not the same as it finishing what it was asked to do. The
table lives in `lib/memory.js` beside the follow-up queue, bounded the same three ways: depth, age
and total size. Chains are capped in depth and expire, and a chained session counts against the
five-session cap like any other.

**Stage 41 — "catch me up."** An event log in the memory store, capped like `artifacts`. "What
happened while I was out" replays it as one spoken paragraph and clears the announcement queue.
This is what makes walking away actually work.

**Stage 42 — read-only repo questions.** Last on purpose: once Phase B lands, the honest answer to
most code questions is "ask the session already in that repo." But `primitives/ask-repo.mjs` —
`allowedTools: ["Read", "Grep", "Glob"]`, the existing deny floor forbidding everything else,
answering in prose — covers the case where nothing is running. One file, no wiring, exactly as the
registry promises.

**Stage 43 — ask first.** A one-line spoken request is rarely a brief a session can work from.
When a start — or a tell or interrupt — is missing what a good brief needs (the goal, where, what
must not be touched, what done looks like), Dante interviews you with **one question per turn**, at
most four, most important first; *"just start it"* or *"that's enough"* ends it early. The pure half
is `lib/interview.js` — `noteInterview`, `interviewBlock`, `composeBrief`, `wantsToProceed`, a
four-question cap and a ten-minute TTL. Each question carries an `[ACTION:SESSION verb=interview …]`
marker so the server can count questions and keep the notes; `mergeTurns` folds that tally into
every turn as a machine-state line, which is what makes the cap and the escape phrase enforced
rather than hoped for, and what lets the interview survive a brain restart. When the picture is
clear the ordinary start (or tell/interrupt) tag carries a `brief="…"` key; `lib/spawn-session.js`
sends the brief as the session's prompt with the task kept as its name. The brief is deliberately
**not read aloud** — a decision taken with the user: the spoken proposal only mentions it, and the
page shows it in full while the yes is awaited. `public/activity-policy.js` and an `activity`
message add a line below the state label naming what Dante is doing right now (*interviewing*,
*awaiting your yes*, *starting jarvis*, *telling jarvis-1*, *reading jarvis-2*, *building landing
page*), blank when nothing is. A request that is already specific gets no interview.

Phases D and E shipped too, and are in daily use like A–C before them: the visibility and
confirmation guardrails, and Phase E's announcements, sessions panel, chaining, recap and read-only
primitive, are all running today. Stage 43 is the newest and, like the rest, has had no manual
walk-through yet.

---

## Deliberately not on this roadmap

- **Dante editing your source.** Read-only. The sessions it starts do the writing.
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

**Per phase, once implemented — and none of this has actually been walked through by a person yet.**
`npm test` passing is automated and green; every checklist below is a person standing in the room
doing the thing, and for every phase, A through E, that check is still owed.

- **A** — start a session by hand in another repo; ask Dante "what's running?". It names the repo
  and its state without being told anything. Kill the CLI mid-listing and confirm the turn still
  answers, just without the roster.
- **B** — "start a session in jarvis to read the README": `claude agents --json` shows a new
  background session in that cwd within a second, named `jarvis-N-read-the-readme`. Say "tell it to
  summarize what it found" **while it is busy** and confirm Dante queues rather than forks — then
  confirm delivery once it goes idle. Start six sessions and confirm the sixth is refused by name.
  "Stop jarvis one" and confirm it leaves the roster.
- **C** — install the hook snippet, run a short session, confirm exactly **one** Slack thread with a
  parent and threaded replies (not two — the poller and hooks must dedupe). Confirm the completion
  reply carries a real one-sentence summary. Kill the Dante server mid-session and confirm the
  session itself is unaffected. For Stage 33: trigger a `git push` from a session with the browser
  closed and confirm it falls through rather than denying; repeat with the browser open and answer
  by voice both ways.
- **D** — with a claude-mem observer session live, "what's running?" must not mention it, and
  Dante's own brain must never appear. With four background jobs running and no Dante session
  ever started, "start a session in jarvis" must propose rather than refuse. Answer a proposal
  three ways — yes, no, and a correction — and confirm nothing is stopped that was not named out
  loud.
- **E** — start a long session, walk away, come back, "catch me up".
- **F** — start a vague session by voice, confirm one question per turn and the "interviewing" line, say "that's enough", confirm the proposal mentions the brief and the page shows it, say yes, and confirm the session's first user message in its transcript is the brief rather than the one-liner; then a specific request ("run npm test in jarvis") gets no interview.

Every stage leaves `npm test` green and the browser working before the next starts — the rule the
first twenty stages ran under, unchanged.
