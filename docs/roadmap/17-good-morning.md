# 17. "Good morning" briefing

**Verdict** LATER. **Size** S to M. **Channel** + only if the owner takes the offer.

## Goal

When a page opens after a long absence, one on-screen line says what happened meanwhile and
offers the recap. Nothing is spoken until the owner asks.

## Why

"Catch me up" is pull-based; the owner has to remember there is something to ask about. One line
on the page costs no voice traffic and turns a forgotten recap into a choice.

## Today

- The connection handler (`server.js:2364-2404`) sends only `sendRoster` and `sendWorkspaces`.
- The event log persists across restarts: `recordEvent` / `getEvents` in
  `lib/memory.js:997-1017`, capped at `MAX_EVENTS = 24` (`:93`), each `{ kind, name, detail,
  at }`.
- `describeFinished(records, aliases, now)` in `lib/recall.js:186-206` names finished,
  still-readable sessions; `recallableSessions` (`:86-158`) builds its input.
- `reply_text` (`server.js:1385`) puts a caption on the page without audio; `activity`
  (`:1452`) drives the "what Dante is doing" line. Message history on the page snaps to the
  newest line.

## Design

1. **Last seen.** `noteSeen(store, now)` in `lib/memory.js` stores `store.lastSeenAt`. Call it
   on every client frame in the WebSocket message handler and on `close`. Cheap, and it means
   "absence" is measured from the last interaction, not the last connect.
2. **Pure line.** `briefingLine(events, roster, lastSeenAt, now, opts = {})` in
   `lib/recall.js`. Returns `null` when `now - lastSeenAt < opts.thresholdMs` (default four
   hours) or when no event is newer than `lastSeenAt`. Otherwise one sentence: counts of
   finished, failed and waiting-on-you events since then, newest name first, then "Say catch me
   up for the details." Cap at 160 characters.
3. **Send.** In the connection handler, after `sendRoster`: `const line = briefingLine(...)`;
   if non-null, `send({ type: "reply_text", text: line })`. No `announce`, no TTS.
4. **Once per absence.** After sending, `noteSeen(store, now)` so a page reload a minute later
   does not repeat it.

## Files

- `lib/memory.js`: `noteSeen`. `lib/recall.js`: `briefingLine`. `server.js`: two lines in the
  connection handler, one in the message handler. `README.md`.

## Tests

- `test/recall.test.js`: below threshold → null; no new events → null; two finished and one
  needs-attention → one sentence with both counts; the cap holds with long names.
- `test/memory.test.js`: `noteSeen` persists through the store's save and reload fixtures.

## Docs

- `README.md` "It reports back": one sentence.
- `docs/protocol.md`: note that `reply_text` may arrive unprompted right after `roster` on
  connect.

## Done when

Stop the server with two finished sessions in the log, wait past the threshold (or lower it in a
test build), open the page: the caption shows the line, nothing is spoken, a reload shows nothing.
`npm test` green.

## Out of scope

Auto-speaking. A digest longer than one line. Tracking absence per device.
