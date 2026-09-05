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
- `server.js:1942-1943` queues when `isWorking(record)` (`lib/agents.js:665`, state before
  status, fixed by merge `8aad871`); delivery happens on a later roster tick.
  `tellVerdict({ channel: "queued" })` (`lib/verdict.js:88-96`) is the spoken acknowledgement.
- `rosterForClient` (`lib/agents.js:366-382`, pure) ships `sessionId, name, alias, number,
  state, status, startedAt, endedAt`; `panelRows(roster)` in `server.js:847-869` wraps it and
  already adds the watch marks `watched` and `firedAt`. `rowFromRecord`
  (`public/roster-panel.js:69-97`) carries `watched` and `reported`; nothing queue-specific.
- `sessionRowEl` (`public/app.js:645-661`) renders the marks as CSS classes.

## Design

1. **Ship it.** `panelRows` in `server.js` (it has the store; `rosterForClient` stays pure)
   adds `queued: peekQueued(store, sessionId, now).length` and
   `queuedText`: the first entry's text through the same 80-character `reasonText` helper plan
   18 adds (or a local cap if plan 18 is not in). `peekQueued` already applies the TTL, so an
   expired entry disappears from the row on its own.
2. **Render it.** `rowFromRecord` adds `queued` and `queuedText`; `sessionRowEl` shows
   "1 queued" beside the existing marks, with the text as the element's `title`.
3. **Tick.** The roster broadcast already runs every poller tick, so delivery clears the tag
   with no extra wiring.

## Files

- `server.js`: two fields in `panelRows`. `public/roster-panel.js`, `public/app.js`.
  `docs/protocol.md`.

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
