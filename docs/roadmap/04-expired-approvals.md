# 4. Expired approvals surfaced, never decided

**Verdict** SHIP-NEXT. **Size** S. **Channel** 0. Implement together with plan 18; they share
the roster-record field and the panel change.

## Goal

When an approval window closes without an answer, the session's roster row says so until the
session is seen working again. Nothing is decided on the owner's behalf.

## Why

The hook returns no decision on give-up, so Claude Code falls back to its own terminal prompt.
The session then waits in a terminal the owner may not have open (it was started `--bg`). The
roster shows "blocked" both before and after the window closes, so it cannot tell the owner the
one thing that matters: before, a spoken yes still fixes it; after, only a terminal can.
Auto-approve is `bypassPermissions` by another name and auto-deny breaks "no browser means no
decision, never a denial", so the fix is visibility only.

## Today

- `requestApproval` in `server.js:753-798`. On timeout (`APPROVAL_WINDOW_MS = 60_000`,
  `server.js:740`) it logs `approval timed out`, calls `reportAttention({ sessionId, detail:
  scope.spoken })` and resolves `finish({})`, the no-decision object from `buildDecision` in
  `lib/approval.js:149-158`.
- `reportAttention` (`server.js:689-716`) records a `needs-attention` event through
  `recordEvent` (`lib/memory.js:1004`) and speaks it once, deduped on
  `${sessionId}:needs-attention:${detail}`.
- `rosterForClient` (`lib/agents.js:366-382`, pure) ships exactly `sessionId, name, alias,
  number, state, status, startedAt, endedAt`; `panelRows(roster)` in `server.js:847-869` wraps
  it with the store at hand and already adds the watch marks `watched` and `firedAt`.
  `rowFromRecord` in `public/roster-panel.js:69-97` reads those and `condition()` (`:57-60`)
  reduces them to one word; `sessionRowEl` (`public/app.js:645-661`) renders marks as classes.
- `resumedAmong` in `lib/watch.js:274` already answers "which reported sessions are working
  again" and is the forget signal for needs-attention reports.
- Session records persist across restarts via `rememberSession` in `lib/memory.js:812-833`.

## Design

1. **Mark, in the memory store.** On the timeout branch, `rememberSession(store, sessionId, {
   approvalExpiredAt: now })`. This is the same record `getSessionRecord` returns, so it survives
   a restart and needs no new store.
2. **Clear, on resume.** In the poller's `onRoster` callback, for every id in
   `resumedAmong(expired, roster)` patch `approvalExpiredAt: null`. Build `expired` from
   `getSessions(store)` filtered on the field. Also clear when `requestApproval` resolves with a
   real decision for that session, so a second prompt answered by voice removes the stale mark.
3. **Ship it.** `panelRows` adds `approvalExpiredAt` (epoch ms or null) read off the session
   record, beside `watched` and `firedAt`; `rosterForClient` stays pure. Plan 18 adds `reason`
   on the same line; when both land, the expiry sets
   `reason` to `"waiting at the terminal"` and the panel needs no special case.
4. **Render it.** `rowFromRecord` adds `expired: Boolean(record.approvalExpiredAt)`;
   `sessionRowEl` appends a short tag ("at the terminal") to the
   condition word. No colour change beyond the existing blocked style.
5. **Count it (optional, one line).** `store.counters.approvalsExpired += 1` beside the mark, so
   a later diagnostics panel has the number. Skip if `store.counters` does not exist yet.

Nothing is spoken beyond what `reportAttention` already says.

## Files

- `server.js`: the timeout branch in `requestApproval`, the clear in `onRoster`, one field in
  `panelRows`. Wiring only.
- `lib/memory.js`: no new API needed; if a helper reads cleaner, `markApprovalExpired(store,
  sessionId, now)` and `clearApprovalExpired(store, sessionId)` as pure store mutations.
- `public/roster-panel.js`: `rowFromRecord` field. `public/app.js`: the tag in `sessionRowEl`.

## Tests

- `test/memory.test.js`: mark then clear round-trips through `rememberSession`; the mark
  survives `getSessions` after a save and reload with the existing temp-store fixtures.
- `test/roster-panel.test.js`: a record with `approvalExpiredAt` yields `expired: true`; without
  it, `false`; the whole-object assertion for `rowFromRecord` must be updated because
  `assert.deepEqual` is strict.
- `test/watch.test.js`: `resumedAmong` is unchanged; no new test unless the call site adds
  logic.

## Docs

- `README.md`, the approval paragraph near line 388 ("session falls back to its normal
  behaviour and the recap records a waiting on you"): one sentence that the roster row now
  shows it as waiting at the terminal until the session moves again.
- `docs/protocol.md`, the `roster` frame in "Server → client frames": add the field.

## Done when

- A session that times out at the approval window shows the tag within one poller tick, keeps
  it across a server restart, and loses it the first tick the roster shows it working.
- Answering a later prompt for the same session by voice clears the tag.
- `npm test` green, no new dependency.

## Out of scope

Any timer that decides. A spoken re-announcement (plan 12). A diagnostics panel for the count.
