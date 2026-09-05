# Voice tag reference

The brain (the `claude -p` persona built by `lib/brain.js`) answers in a sentence
meant to be spoken, and may append exactly one or two machine tags at the very end
of it — `[ACTION:...]` or `[MEMORY:...]`. `lib/action.js`'s `parseAction` (`lib/action.js:126`)
is the only place a tag is ever read: it strips every tag out of the spoken text
(closing the gap left behind, `lib/action.js:142`) and hands back the clean `reply`
plus whatever `action`, `session`, or `memory` bag it found. Nothing downstream
trusts the model's own wording for what it is about to do — the model's sentence is
spoken as a preamble at most, never as the description of the act itself.

For the four verbs that reach a live session — `start`, `tell`, `interrupt`, `stop`
— and for a build, that description is composed fresh from the parsed tag by
`lib/confirm.js`'s `describeIntent` (`lib/confirm.js:261`), spoken as a "Shall I,
sir?" proposal, and held until the next thing said is read as yes, no, or a
correction (`readAnswer`, `lib/confirm.js:385`). Only a "yes" runs anything. Once a
session command has actually run, what gets said about it is not the model's guess
either: `lib/verdict.js` classifies the outcome as **proposed** (nothing sent yet),
**attempted** (sent or signalled, unconfirmed), or **verified** (checked against a
fresh roster read or an actual reply) and phrases the sentence accordingly.

## Tags

| Tag | Fields | What happens | Confirmation? | Verdict class | Source |
|---|---|---|---|---|---|
| `[ACTION:BUILD primitive=<id> key=value ...]` | `primitive` required (dispatch key); every other pair becomes a build param, uncapped at parse time | Looked up in the primitive registry; missing answers are asked one at a time, then the build runs in its own throwaway directory | Yes — `propose()` speaks `describeIntent`'s "Build a landing page for coffee shop. Shall I, sir?" | Not `lib/verdict.js` — `build()` in `server.js` speaks `primitive.doneLine()` on success or `describeFailure()` on failure | `lib/action.js:98` (`toAction`), `lib/brain.js:74`, `lib/confirm.js:352` (build clause), `server.js:1860` (`dispatchAction`), `server.js:2498` (`propose`) |
| `[ACTION:SESSION verb=start repo=<alias> task="..." kind=<id> then="..." brief="..." command="/name args"]` | `verb` required; `repo` optional (falls back to the main workspace); `task` the spoken label; `kind` one of the installed session kinds; `then` one chained successor task; `brief` a structured document (Goal/Where/Constraints/Done when/Also) written for the session itself; `command` a vetted skill line | Starts a real Claude Code session in that workspace, named fresh against the live roster | Yes — held for an interview read-back first if any facet is unconfirmed, then `proposeSession` | `startVerdict`: "Running as X" (listed), "Started as X, but I could not check the roster" (listed=null), or "not on the roster yet" | `lib/action.js:114` (`toSession`), `lib/brain.js:107` `lib/brain.js:113` `lib/brain.js:123`, `server.js:1681` (`dispatchSession`), `server.js:1772` (`beginSession`), `lib/verdict.js:104` |
| `verb=tell name="<session>"` (or `number="<n>"`) `task="..."` | `name` or `number` required to resolve a target; `task`/`brief`/`command` the message | Delivered to a running session over the peer channel, queued if busy, or via resume-and-wait as a last resort | Yes | `tellVerdict`: `"peer"` → "Sent, I cannot confirm it was read"; `"queued"` → "busy, I will pass it on"; `"resume"` → the session's own reply | `lib/brain.js:130`, `server.js:1400` (`dispatchTell`), `lib/verdict.js:88` |
| `verb=interrupt name="<session>" task="..."` | Same as tell, plus it preempts a running turn instead of waiting | Delivered "now"-priority over the peer channel; a `command=` on an interrupt is silently turned into a `tell` (a skill cannot cut in front of a turn) | Yes | Same `tellVerdict` shapes, `verb="interrupt"` phrasing ("Interrupt sent to X") | `lib/brain.js:135`, `lib/commands.js:195` (interrupt→tell), `server.js:1400` |
| `verb=stop name="<session>"` (or `number=`) | `name`/`number` required | Signals the session and re-reads the roster to see if it actually left | Yes | `stopVerdict`: "is stopped" (gone), "still on the roster" (signalled but present), "I could not check that it took" (roster unreadable) | `lib/brain.js:133`, `server.js:1350` (`dispatchStop`), `lib/verdict.js:48` |
| `verb=read name="<session>" question="..."` (or `number=`) | `name`/`number` required; `question` optional — omitted means "what did it do" | Reads the session's transcript (finished or still running) and speaks the answer; a successful read is filed as a note (`lib/notes.js`) | **No** — `describeIntent` deliberately returns nothing for `read`, so it runs straight away | Not applicable — a read only reports, it never acts | `lib/brain.js:156`, `lib/confirm.js:341` (comment on why it's undescribed), `server.js:1544` (`dispatchRead`) |
| `verb=recap` | No other keys | Speaks the accumulated event log back as one paragraph, then clears it and any pending announcements | **No** — changes no process | Not applicable | `lib/brain.js:229`, `server.js:1652` (`dispatchRecap`) |
| `verb=interview for=<start\|tell\|interrupt> repo=<alias> name="<session>" have=<facet,facet> confirming=<facet,facet> confirmed=<facet,facet> note="..."` | `for` required to name which command is being interviewed for; `repo`/`name` carry forward once known; `have` the facets now covered (omitted = unchanged, empty = reset); `confirming` the facets *this* question reads back for a yes; `confirmed` the facets already confirmed; `note` one sentence of what the last answer taught | Folds into `conv.interview` via `noteInterview`; the question itself is spoken, nothing is dispatched | The interview *question* is not itself confirmable; the start/tell/interrupt it is building toward stays held until every facet is `readyToPropose` | Not applicable to the tag itself | `lib/brain.js:184`, `lib/interview.js:66` (`FACETS`), `lib/interview.js:192` (`noteInterview`), `lib/interview.js:284` (`readyToPropose`), `server.js:2348` |
| `command="/name args"` (on a `start` or `tell`) | `/name` must resolve to a known skill (`lib/commands.js`'s `loadCommands`); never one of the CLI's own native commands | Vetted by `vetCommand` before the tag is ever described or proposed: an unknown or native name is refused outright, an interrupt is downgraded to a tell, a task-less start is labelled with the command line itself | Yes, as whichever verb it ends up (start/tell), read back with the full `/name args` line | Same as the start/tell it rides on | `lib/commands.js:46` (`NATIVE_COMMANDS`), `lib/commands.js:67` (`MAX_ARGS_CHARS`), `lib/commands.js:184` (`vetCommand`), `server.js:2389` |
| `[MEMORY:SET key=value ...]` (ordinary keys) | Any lowercase key up to 40 chars, value up to 120 chars; capped at 20 standing preference keys per project (existing keys may still be updated past the cap) | Sanitized by `sanitizePreferences` and merged into the project's standing preferences; folded into every future persona build | No — memory tags never dispatch | Not applicable | `lib/brain.js:240`, `lib/memory.js:203` (`sanitizePreferences`), `lib/memory.js:291` (`applyMemoryTag`), `lib/memory.js:38`-`40` (caps) |
| `[MEMORY:SET workspace:<name>=<path>]` | `<name>` sanitized to a spoken-safe alias; `<path>` checked against the real filesystem, must resolve inside `$HOME` | Registers (or silently no-ops on) a workspace a session can later be started in or addressed by that alias | No | Not applicable | `lib/brain.js:251`, `lib/memory.js:50` (`WORKSPACE_PREFIX`), `lib/memory.js:426` (`resolveWorkspacePath`), `lib/memory.js:589` (`applyWorkspaceTag`) |
| `[MEMORY:SET main=<alias>]` | `<alias>` must already name a known workspace, or nothing is stored | Sets the repository a bare "start a session" starts in | No | Not applicable | `lib/brain.js:256`, `lib/memory.js:56` (`MAIN_KEY`), `lib/memory.js:539` (`setMainRepo`) |
| `[MEMORY:SET memory-max-mb=<n>]` / `[MEMORY:SET memory-max-files=<n>]` | `<n>` an integer, 1–2048 (MB) or 1–100000 (files); out-of-range values are dropped | Sets how much of the notes directory (`lib/notes.js`) is kept before the oldest notes are pruned; a lowered limit prunes immediately | No | Not applicable | `lib/brain.js:260`, `lib/memory.js:64` (`NOTE_LIMIT_KEYS`), `lib/memory.js:335` (`applyNoteLimitsTag`) |

## What a person can say

Some of what happens is decided by a fixed word list rather than by the model at
all, on purpose — a prompt-injected tool description or a misheard sentence cannot
argue a strict vocabulary into an answer it never gave:

- **A yes or no to a proposal or a read-back** — `parseYesNo` (`lib/approval.js:120`)
  matches a short, fixed vocabulary (`yes`/`yeah`/`sure`/`go ahead`/… and
  `no`/`nope`/`hold off`/… — the sets are `lib/approval.js:98`-`113`); anything
  longer than four words, or anything that reads as neither, is treated by
  `readAnswer` (`lib/confirm.js:385`) as `"amend"` — a correction, not an answer,
  which drops the proposal and lets the sentence become an ordinary turn instead.
- **Telling the interview to stop asking** — `wantsToProceed` (`lib/interview.js:379`)
  matches a short list of escape phrases (`ESCAPE_PHRASES`, `lib/interview.js:347`
  — "just go ahead", "that'll do", "stop asking", and the like) inside an utterance
  of six words or fewer, and a negation anywhere in it ("no", "don't", "wait")
  cancels the match rather than being read as agreement.

## The stopping rule

When an interview actually stops asking and moves to a read-back is governed by
`docs/interview.md`, which `lib/interview.js`'s `FACETS` and the INTERVIEW
paragraph in `lib/brain.js` must always agree with — see that document rather than
this one for the rule itself.
