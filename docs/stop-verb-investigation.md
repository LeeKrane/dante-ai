# Why "stop session four" did not stop session four

Investigation of 2026-09-01. Dante said "implement-persistent-memory-system is
stopped, sir" and the session carried on working. This records what actually
happened, how it was confirmed, and what changed.

## The short version

A background session started with `claude --bg` belongs to the Claude Code
daemon, not to its pid. The daemon holds a lease on the session and treats a
worker process that dies as a crash to recover from: about ten seconds later it
resumes the same transcript in a fresh worker under a new pid.

Dante's stop verb sent `SIGTERM` to the worker's pid, watched the pid disappear,
and said "stopped". Every word of that was true of the pid and false of the
session. Only `claude stop <id>` settles the daemon's lease, and that is what the
stop verb now asks.

## The call path, as it was

1. `[ACTION:SESSION verb=stop number=4]` arrives from the brain. `proposeSession`
   in `server.js` resolves the number against the roster with `findTarget`
   (`lib/confirm.js`), speaks the proposal, and parks a `run` closure that
   carries the resolved `sessionId`.
2. The "yes" reaches `answerProposal`, which calls that closure: `dispatchSession`
   re-reads the roster, `dispatchStop` re-resolves by `sessionId`, then calls
   `stopSession(record)` in `lib/spawn-session.js`.
3. `stopSession` sent `SIGTERM` to `record.pid`, polled `kill(pid, 0)` until it
   raised `ESRCH`, and returned `{ ok: true }`.
4. `dispatchStop` logged `stopped <name>` and spoke it.

Nothing in that chain was racy or unconfirmed. Steps 1 and 2 worked exactly as
designed, and step 3 confirmed exactly what it set out to confirm. The mistake
was in what step 3 was confirming.

## What the logs show

Dante's journal (`journalctl -u dante`, times UTC):

```
18:09:11.419 proposal accepted: Start a session in jarvis to implement persistent memory system ...
18:09:12.371 session started name=implement-persistent-memory-system id=6e74eac6-... cwd=/home/krane/development/jarvis
18:09:31.849 stop target: tag name=null repo=null number="4" -> resolved "implement-persistent-memory-system" (25c28ab4-...)
18:09:36.075 proposal accepted: Stop session four, implement-persistent-memory-system. Shall I, sir?
18:09:37.155 stopped implement-persistent-memory-system
```

The daemon's log (`~/.claude/daemon.log`):

```
18:09:11.909 [bg] bg claimed-spare 25c28ab4 (shell)
18:09:21.671 [supervisor] shutting down (cause=upgrade, uptime=79081s, leases=4, live_workers=4)
18:09:21.936 [bg] bg adopt: adopted=4 respawned=0 dead=0
```

There is no `bg settled 25c28ab4` line. Compare a stop that went through the
daemon earlier the same day:

```
15:36:53.764 [bg] bg settled 1b0f922e (killed)
```

The process table at the time of the investigation, twenty minutes later:

```
PID      PPID     STARTED               COMMAND
3801795  1        20:09:20 (local)      claude daemon run ...
3805229  3801795  20:09:46 (local)      claude bg-pty-host ... --resume /home/krane/.claude/projects/.../25c28ab4-....jsonl
3805256  3805229  20:09:46 (local)      claude --resume /home/krane/.claude/projects/.../25c28ab4-....jsonl
```

The worker was `SIGTERM`ed at 20:09:36 local, "stopped" was said at 20:09:37,
and the daemon started a new worker for the same session at 20:09:46 with
`--resume`. `claude agents --json` listed it as `state: "working"` again with
the new pid.

## Confirmed by experiment

To rule out the daemon upgrade that happened ten seconds after the session
started (the `adopt` line above), a throwaway session was started and its
worker `SIGTERM`ed directly, with nothing else going on:

```
kill -TERM 3848565 at 20:16:44
t+1  gone (ESRCH)
t+5s  roster: no pid, state "working"
t+10s roster: no pid, state "working"
t+15s roster: pid 3860620, state "working"   <- new bg-pty-host + claude --resume, parent = daemon
```

Then, on that resumed worker:

```
claude stop 3ee7f1c2        -> "stopped 3ee7f1c2", exit 0
daemon.log                  -> [bg] bg settled 3ee7f1c2 (killed)
roster after 4s             -> state "stopped", no pid, never resumed
```

So: a signalled worker is resumed by the daemon after roughly ten seconds,
regardless of upgrades. `claude stop <id>` settles the lease and is not resumed.
The CLI is idempotent (`claude stop` on an already-stopped id says "stopped" and
exits 0) and refuses an unknown id on stderr with exit 1:

```
No job matching 'zzzzzzzz'. Run 'claude agents' to list running sessions.
```

Two further things the experiment showed, both relevant to the fix:

- For the ten seconds between the worker dying and the daemon resuming it, the
  roster entry has **no pid** and still says `working`. The old `stopSession`
  refused such a record ("I do not have a process id for that session"), which
  is precisely the window in which a second, louder "stop it" arrives.
- The roster entry's `pid` for a background session is the pid of the claimed
  spare worker, and it changes on every resume. `id` and `sessionId` do not.

## The fix

`stopSession(record, opts)` in `lib/spawn-session.js` now chooses by the roster
record:

- `kind: "background"` with a usable `id` (the daemon's short id, checked
  against `/^[A-Za-z0-9][\w.-]{0,99}$/` so nothing that could read as an option
  becomes an argument): spawn `claude stop <id>`, treat exit 0 as the only
  success, and repeat the CLI's stderr sentence on any other exit. Then poll the
  worker pid exactly as before, because "stopped" is still only said of a
  process that has actually left. A record with no pid is stoppable on this
  path. A refusal from the daemon is reported, never followed by a `SIGTERM`
  fallback: falling through would reproduce the bug while sounding like a
  success.
- `kind: "background"` without a usable `id`: refused ("I do not have an id to
  stop that session by"). The lease is there whether or not the id came through
  the listing intact, so signalling would be the original bug again.
- Anything else (an interactive session in someone's terminal): `SIGTERM`,
  never `SIGKILL`, confirmed gone before reporting. Unchanged.

The daemon ask and the wait for the worker to leave share one budget
(`opts.timeoutMs`, default `STOP_TIMEOUT_MS`), so a slow answer followed by a
slow exit cannot add up to twice what the caller allowed. On expiry only the
`claude stop` client is killed; nothing ever escalates on the session.

The result gains a `via: "daemon" | "signal"` field, which `dispatchStop` in
`server.js` writes into its `stopped <name> via <via>` log line, so the next
midnight reading of this log can tell which path a stop took without a process
table.

The poll's sleep timer is now referenced rather than `unref`'d. Unreferenced, a
poll with nothing else alive let the event loop drain mid-wait; the test runner
reports that as a cancelled test, and a shutting-down server would report
nothing at all.

`opts.bin` is the seam for a fake CLI, as in `listAgents`; `opts.kill` stays the
seam for a fake `kill(2)`; `opts.timeoutMs`, `opts.pollMs` and
`opts.killGraceMs` are as before. Nine tests in `test/spawn-session.test.js`
pin the daemon path: the argv it sends, that the worker is never signalled on
that path, the no-pid window, the already-gone case, a worker that outlives the
daemon's answer, an interactive session still getting `SIGTERM`, an id that
reads as a flag never reaching the CLI, a CLI that hangs, and a CLI that is
missing.

`README.md` ("Stop session three") and `docs/roadmap.md` (Stage 28) now describe
the daemon path.

## Review

`/code-review high` ran on the diff. What it found and what was done:

- **Background record without a usable id fell back to `SIGTERM`** (confirmed).
  That was the bug again by another door. Now refused; test added.
- **Two deadlines in series** (the CLI ask, then the poll, each on
  `STOP_TIMEOUT_MS`) could hold a voice reply for sixteen seconds. Now one
  budget across both.
- **The 120 ms test budget** for "worker outlives the daemon's answer" also had
  to cover a cold node start of the fake CLI and would flake under a loaded
  runner. Widened to 600 ms.
- **Comments that had drifted**: `STOP_TIMEOUT_MS` said nothing escalates, which
  is true of the session and not of the CLI client; the stderr cap said
  "first line" and did not do that. Both reworded.
- **A daemon-stopped session lingers on the roster as `stopped`**, so the
  "gone" event and the chain never fire (unverified by the reviewer). Checked
  against the live listing: `claude agents --json` without `--all` does not
  list stopped sessions, so they do leave the roster and "gone" fires as before.
  Not a bug.
- **A `claude stop` that times out is reported as a failure without polling
  the pid**, so a stop the daemon did carry out could be spoken as "I could not
  stop X". Left as is: a pid that is gone is exactly the evidence this fix
  stopped trusting, and "could not" is the honest answer when the daemon has
  not said yes.
- **`stopViaDaemon` is a third copy of the spawn-with-deadline runner** in
  `tellSession` and `listAgents`, with its own grace period. True, and a shared
  `runCli` would be the right cleanup, but it touches the tell and list verbs
  and so is left for a change of its own.
- **`daemonId` lives beside impure code** rather than in `lib/agents.js` with
  the other roster predicates. Left where it is for now; moving it is part of
  the same cleanup as above.

## Not changed, but found on the way

These are outside the stop verb and are left for their own change.

**`--session-id` is ignored by `claude --bg`.** Dante passes
`--session-id <uuid it generated>` and records the session in
`~/.config/dante/memory.json` under that uuid. The daemon assigns its own. For
session four: Dante remembered `6e74eac6-...`, the roster said `25c28ab4-...`.
This is true of every background session in the store. Consequences, all
silent:

- `getSessionRecord(memoryStore, record.sessionId)` in `dispatchStop` never
  matches, so `stoppedAt` is never written and the recap says a stopped session
  "finished".
- `ownRunning` in `lib/agents.js` intersects the roster with the store by
  `sessionId` and so always counts zero; `MAX_SESSIONS` is never enforced.
- `takeQueued`, `chainAfter` / `takeChain` and the recap's "stopped from here"
  detail are all keyed by the id the daemon does not use.

The fix is to read the id the CLI prints on start (`backgrounded · 25c28ab4 ·
name`) rather than discard stdout in `startSession`, or to look the session up
by name in the first roster read after a start. Either is a change to
`beginSession` and `startSession`, not to the stop verb.

**Five fake CLIs from `test/spawn-session.test.js` are still running** on this
machine, started by a test run seven days ago
(`node /tmp/jarvis-spawn-*/claude-lingers.cjs --bg -n jarvis-1-fix-failing-builder-test ...`).
`startSession` deliberately detaches and `unref`s the child, so a fake that does
not exit on its own is never reaped. The current `claude-lingers.cjs` fake exits
after 400 ms; those five did not. Harmless, but a `child.kill()` in that test's
`finally` would make the suite unable to leak one again.

## Session four itself

It is still running as of this writing, resumed by the daemon. Stopping it the
way Dante now would:

```
claude stop 25c28ab4
```
