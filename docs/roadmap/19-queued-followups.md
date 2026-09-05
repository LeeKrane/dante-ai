# 19. Queued follow-ups shown in the roster

**Verdict** SOON. **Size** S. **Channel** −.

## Goal

When a tell or interrupt is queued behind a busy session, the session's roster row shows it until
it is delivered.

## Why

Dante says "I will pass it on when it stops" and the message vanishes from view. The owner cannot
tell later whether it was delivered, is still waiting, or was dropped by the queue's TTL, and
asks. A tag on the row answers without a turn.

## Today

- Queue API in `lib/memory.js:735-783`: `queueForSession(store, sessionId, text, now)`,
  `peekQueued(store, sessionId, now)` (read, no consume), `takeQueued` (consume),
  `dropQueuesExcept`. Entries are `{ text, at }`, filtered by `QUEUE_TTL_MS` and capped by
  `MAX_QUEUED_PER_SESSION`.
- `server.js:1692` queues when `isWorking(record)`; delivery happens on a later roster tick.
  `tellVerdict({ channel: "queued" })` (`lib/verdict.js:88-96`) is the spoken acknowledgement.
- `rosterForClient` (`server.js:633-653`) does not mention the queue; `rowFromRecord`
  (`public/roster-panel.js:53-73`) has no field for it.
- A note in the owner's memory from the unmerged `worktree-fix-idle-shown-as-working` branch:
  `isWorking` reads `state` before `status`, so a queued tell to a session that is working by
  state and idle by status may never deliver. Check that on main before relying on delivery;
  if it reproduces, fix it first or the tag will show a message that never leaves.

## Design

1. **Ship it.** `rosterForClient` adds `queued: peekQueued(store, sessionId, now).length` and
   `queuedText`: the first entry's text through the same 80-character `reasonText` helper plan
   18 adds (or a local cap if plan 18 is not in). `peekQueued` already applies the TTL, so an
   expired entry disappears from the row on its own.
2. **Render it.** `rowFromRecord` adds `queued` and `queuedText`; `sessionRowEl`
   (`public/app.js:591-606`) shows "1 queued" with the text as the element's `title`.
3. **Tick.** The roster broadcast already runs every poller tick, so delivery clears the tag
   with no extra wiring.

## Files

- `server.js`: two fields. `public/roster-panel.js`, `public/app.js`. `docs/protocol.md`.

## Tests

- `test/roster-panel.test.js`: `rowFromRecord` with `queued: 0`, `queued: 2`; strict
  whole-object assertions updated.
- `test/memory.test.js`: no new API; `peekQueued` after TTL already pinned.

## Docs

- `docs/protocol.md`: the two `roster` frame fields.
- `README.md`, the paragraph on talking to a busy session: one sentence.

## Done when

Telling a working session something shows "1 queued" on its row within a tick and the tag is
gone on the tick after the session goes idle and the message is delivered. `npm test` green.

## Out of scope

Editing or cancelling a queued message by voice. Showing queues in the spoken roster line.
