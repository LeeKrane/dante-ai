# Known limitations

Where Dante's behaviour silently does not hold, and which parts lean on
Claude Code CLI internals nobody documents. Read this before building on any
of the following, and before assuming a refusal or a miscount is a Dante bug
rather than a CLI one.

## 1. Session identity under `--bg`

`claude --bg` does not honour `--session-id`. It prints `warning: --bg
manages the session id; ignoring --session-id (use --resume <id> to
continue an existing session)` on stderr and mints its own id instead —
seen on CLI 2.1.257 and reproduced again on the 2.1.258 installed here.
`buildStartArgs` (`lib/spawn-session.js:98`) still puts `--session-id` on
the command line anyway, cheaply, on the chance a future release honours
it; the comment above the `UUID` pattern (`lib/spawn-session.js:79-84`) is
where this is written down in the code.

Until 2026-09-02 that mismatch was silent end to end. Dante kept its own
generated uuid as the memory key (`rememberSession`, `lib/memory.js:755`)
while the daemon answered to a different one, so `ownRunning`
(`lib/agents.js:465`) — which intersects the roster with the store by
`sessionId` — counted zero of Dante's own sessions regardless of how many
were running, leaving `MAX_SESSIONS` (`lib/spawn-session.js:220`)
unenforced. `stoppedAt` (`dispatchStop`, `server.js:1372`) never matched a
roster record, so a session stopped from here was reported back as merely
"finished," and `takeQueued`, `chainAfter`/`takeChain`
(`lib/memory.js:702`, `:811`, `:842`) all missed on the same wrong key. The
full anatomy — including the live session where Dante remembered
`6e74eac6-...` and the roster said `25c28ab4-...` — is in
`docs/stop-verb-investigation.md`.

Fixed 2026-09-02. `parseStartedId` (`lib/spawn-session.js:194`) reads the
`backgrounded · <id> · <name>` line the CLI prints before exiting a `--bg`
start — colour codes stripped, matched by token position, since the middle
dot is formatting, not contract. `resolveStartedSession`
(`lib/spawn-session.js:405`) then polls `claude agents --json` a few times
because the daemon's state is a separate read from a separate process and
need not show the new session on the very next listing. `matchStarted`
(`lib/agents.js:509`) matches by that short id first, falling back to
newest-by-`startedAt` name match only when the CLI printed nothing
`parseStartedId` recognised. `beginSession` (`server.js:1772`) keys
`rememberSession` by the roster's own `sessionId` (`server.js:1841`), not
the uuid it generated, so `ownRunning`, `dispatchStop` and any chain now
agree with the daemon.

Residual limitation: if the roster never lists the session within the poll
window, `beginSession` falls back to the provisional uuid and only logs a
warning (`server.js:1836`) — nothing is said aloud, since there is nothing
a person could act on. That session runs correctly; it just will not count
against `MAX_SESSIONS`, will not receive a queued message or a chain, and a
stop on it will not be recorded as `stoppedAt`. If this starts happening
often, re-check `resolveStartedSession`'s attempt count and delay, and
whether the roster itself is slow under load. Re-check this whole section
against any CLI upgrade past 2.1.258, too: a changed `backgrounded` line
breaks `parseStartedId` outright, and a CLI that starts honouring
`--session-id` would make the poll-and-match dance unnecessary — but only
once verified live, the same way this bug was found and fixed.

## 2. Reverse-engineered CLI internals

None of the following is documented by Anthropic; each was established by
reading a live CLI's actual output and is trusted only as far as the
version it was checked against.

| What | Where | Verified against | Symptom if it changes | How to re-verify |
| --- | --- | --- | --- | --- |
| `claude agents --json` roster shape (`sessionId`, `id`, `name`, `cwd`, `kind`, `status`, `state`, `pid`, `startedAt` as epoch ms; most fields optional) | `parseRoster`, `lib/agents.js:92` | Not version-pinned; the epoch-ms shape is called out at `lib/agents.js:61-63` | A reshaped field degrades silently to `[]` rather than erroring — Dante goes quietly blind to the roster | Run `claude agents --json` live and diff the shape against `parseRoster`'s expectations |
| Transcript layout `~/.claude/projects/<cwd-slug>/<id>.jsonl`, one JSON object per line | `slugForCwd` and its reader, `lib/transcript.js:9`, `:61` | Not version-pinned; called "an OBSERVED CONVENTION, not a contract" (`lib/transcript.js:9-12`) | Every read degrades to "no summary" rather than an error | Start a session, locate its `.jsonl`, confirm path and shape still match |
| uds-messaging: every live session listens on a unix socket for newline-delimited JSON frames, address read from `~/.claude/sessions/` | `readPeerAddress`, `lib/peer.js:198` (socket lookup at `:215`) | CLI 2.1.246 (`lib/peer.js:8`, `:16`) | `sendToSession` (`lib/peer.js:276`) fails silently or hits a stale socket | Interrupt a live session with a "now"-priority frame and confirm it responds mid-turn |
| The `backgrounded · <id> · <name>` stdout line from `claude --bg` | `parseStartedId`, `lib/spawn-session.js:194` | 2.1.257 and 2.1.258 (`lib/spawn-session.js:79`) | Returns `null`; falls back to name match, then to the provisional uuid (Section 1) | Run a real `--bg` start and read the first stdout line by eye |
| `claude stop <id>`: settles the daemon's lease so the worker is not resumed; exit 0 on success or on an already-gone session, exit 1 with a reason for an unknown id | `stopViaDaemon`, `lib/spawn-session.js:674` | Live 2026-09-01, against a SIGTERM that got resumed after ~10s instead of stopping (`lib/spawn-session.js:556-565`) | A good stop reports failure, or a SIGTERMed session reappears under a new pid | Stop a live session both ways and watch the roster for ~15s after |

The old roadmap (`docs/roadmap.md`, deleted in commit 4724861) proposed `npm run
smoke` — exec the actually-installed CLI and assert the roster lists what
was started — precisely because a fake CLI in the test suite cannot catch
any of the five rows above drifting. That test does not exist yet and no plan
under `docs/roadmap/` includes it; until it does, re-verifying this table
means doing by hand what it describes.

## 3. Front-end

Speech-to-text is Chrome only: `public/app.js:763` reads
`window.SpeechRecognition || window.webkitSpeechRecognition`, and the
`else` branch (`public/app.js:825-828`) — a caption telling the person to
open Chrome — is the entire fallback. There is no text-input path, so
Firefox, Safari, and a browser with the microphone denied cannot drive
Dante at all. Listening is hold-to-talk only: `holding`
(`public/app.js:765`) is set by a physical button or spacebar held down and
cleared on release; nothing offers a press-to-start/press-to-stop toggle.

Screen-reader support is partial. `#sessions` (`public/index.html:474`) is
`aria-live="off"`, so a session starting or finishing is never announced;
`#brief` (`:475`) and `#dbg` (`:473`) carry no `aria-live` attribute at all,
so neither is announced either. The generic failure caption `"connection
closed — restart the server and refresh"` (`public/app.js:424`) is shown to
end users verbatim — Dante's own message for "the WebSocket died," not
translated into something a non-operator would know what to do with.
Queued announcements — replies waiting behind one already speaking — have
no visual cue; nothing on screen shows one is pending until it plays.

## 4. Builds

`MAX_BUILDS` (`server.js:1283`) is `1`: a second request queues or is
refused rather than running alongside the first. The deny layer in
`lib/builder.js` and its cleanup were never designed for a concurrent build.
That is deliberate: the old roadmap ruled out multi-user and concurrent builds,
and the council review of 2026-09-02 (`docs/feature-candidates.md`, rejected
items 31 to 33 in its history) reaffirmed it, because the approval and
deny-layer design leans on every session running under the owner's own login.
`builds/` is never rotated or pruned; every build's throwaway directory
accumulates on disk.

## 5. Interview and proposals

Interview state (`conv.interview`, e.g. `server.js:811`) lives in memory on
one WebSocket connection, with a ten-minute liveness window
(`INTERVIEW_TTL_MS`, `lib/interview.js:72`); a page reload is a fresh
WebSocket and starts with no interview at all, mid-conversation or not —
there is no persistence to resume into. Proposals — the "confirm before
starting" step — expire after `PROPOSAL_TTL_MS` (`lib/confirm.js:27`, 120
seconds); one answered after that window is treated as never made.

## 6. Small print

`FISH_PITCH` (`lib/config.js:14`) is read server-side but never sent to
Fish — its prosody object has no pitch field at all (`lib/tts.js:17-20`).
The server only forwards the configured number to the client per clip
(`server.js:1215`); `public/pitch-policy.js` resamples the audio Fish
already returned instead, trading a small tempo shift for the pitch change.

`test/spawn-session.test.js:261` fakes a CLI that can be made to linger past
its own process lifetime; `startSession` deliberately detaches and unrefs
the child so a real `--bg` session survives Dante exiting, which means a
fake that never exits is never reaped by the test either.
`docs/stop-verb-investigation.md` records five such fakes still running a
week after the run that started them — check with `ps aux | grep
claude-lingers`. Harmless machine noise, worth killing by hand. And
`buildStartArgs` (`lib/spawn-session.js:98`) still puts `--session-id
<uuid>` on every `--bg` start though Section 1 established the CLI ignores
it — harmless, left in on the chance a future CLI honours it.

When any of these stops being true, fix this file in the same commit.
