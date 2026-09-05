# 18. State reasons in reports

**Verdict** SOON. **Size** S. **Channel** 0. Implement together with plan 4; plan 5 and plan 12
read the field this one adds.

## Goal

A blocked session's row, and the roster line the model sees, carry the reason: "wants to push
to the remote", "waiting at the terminal", "asked a question". Not just the word "blocked".

## Why

"Needs attention" is one bucket. Which kind of attention decides whether it is worth interrupting
what the owner is doing. The reason text already exists at the moment it is spoken and is then
thrown away.

## Today

- `activity(record)` (`lib/agents.js:182`, exported) reduces `state`/`status` to one word; the CLI's
  `state` is an open vocabulary (`lib/agents.js:80`).
- The reason exists in two places and is stored in neither: `scope.spoken` in `requestApproval`
  (`server.js:753-798`) and `event.detail` in `reportAttention` (`server.js:689-716`). Event
  details are capped at `MAX_EVENT_DETAIL_CHARS = 300` (`lib/memory.js:992`).
- `rosterForClient` (`lib/agents.js:366-382`, pure) ships `sessionId, name, alias, number,
  state, status, startedAt, endedAt`; `panelRows` (`server.js:847-869`) wraps it and adds the
  watch marks `watched` and `firedAt`. `rowFromRecord` (`public/roster-panel.js:69-97`) reads
  them plus `watched` and `reported`; `reason` would be the third such field, same pattern.
- `describeRoster` (`lib/agents.js:325`) renders `"N: name in alias, word[, since]"` for
  the model each turn.
- `resumedAmong` (`lib/watch.js:274`) is the existing "it is working again" signal.

## Design

1. **Store the reason on the session record.** `rememberSession(store, sessionId, { reason })`
   from three sites: `requestApproval` when the prompt arrives (`scope.spoken`), `reportAttention`
   (`event.detail`), and plan 4's timeout branch (`"waiting at the terminal"`). Cap at 80
   characters through a pure `reasonText(detail)` in `lib/notify.js` that also strips
   unprintables and newlines, since this string reaches the model every turn.
2. **Clear it.** In the poller's `onRoster` callback, `reason: null` for every id from
   `resumedAmong`, and when `requestApproval` resolves with a real decision.
3. **Ship it.** `panelRows` adds `reason` (string or null) read off the session record;
   `rosterForClient` stays pure.
4. **Render it.** `rowFromRecord` adds `reason`; `sessionRowEl` (`public/app.js:645-661`) shows
   it after the condition word, only when the condition is blocked.
5. **Tell the model.** `describeRoster` appends `", <reason>"` for blocked records that have
   one. Keep the line under the existing per-line cap.

## Files

- `lib/notify.js`: `reasonText`. `lib/agents.js`: `describeRoster` clause. `server.js`: three
  sets, one clear, one field. `public/roster-panel.js`, `public/app.js`.

## Tests

- `test/notify.test.js`: `reasonText` caps, strips, returns null for empty.
- `test/agents.test.js`: `describeRoster` with and without `reason`; a reason on a working
  record is ignored.
- `test/roster-panel.test.js`: `rowFromRecord` carries `reason` (update the strict
  whole-object assertions).

## Docs

- `docs/protocol.md`: the `roster` frame field.
- `README.md` "It reports back": one sentence.

## Done when

A session that asks to push shows "blocked, wants to push to the remote" on its row and in the
model's roster line; answering it clears both within a tick. `npm test` green.

## Out of scope

Reasons for working or done sessions. Reading the CLI's own status text for more states
(`docs/known-limitations.md` §2 explains why that is reverse-engineered and brittle).
