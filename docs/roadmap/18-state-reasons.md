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

- `activity(record)` (`lib/agents.js:167-186`) reduces `state`/`status` to one word; the CLI's
  `state` is an open vocabulary (`lib/agents.js:80`).
- The reason exists in two places and is stored in neither: `scope.spoken` in `requestApproval`
  (`server.js:538-581`) and `event.detail` in `reportAttention` (`server.js:477-502`). Event
  details are capped at `MAX_EVENT_DETAIL_CHARS = 300` (`lib/memory.js:991`).
- `rosterForClient` (`server.js:633-653`) ships `sessionId, name, alias, number, state, status,
  startedAt, endedAt`. `rowFromRecord` (`public/roster-panel.js:53-73`) reads them.
- `describeRoster` (`lib/agents.js:323-345`) renders `"N: name in alias, word[, since]"` for
  the model each turn.
- `resumedAmong` (`lib/watch.js:195-204`) is the existing "it is working again" signal.

## Design

1. **Store the reason on the session record.** `rememberSession(store, sessionId, { reason })`
   from three sites: `requestApproval` when the prompt arrives (`scope.spoken`), `reportAttention`
   (`event.detail`), and plan 4's timeout branch (`"waiting at the terminal"`). Cap at 80
   characters through a pure `reasonText(detail)` in `lib/notify.js` that also strips
   unprintables and newlines, since this string reaches the model every turn.
2. **Clear it.** In `onRoster` (`server.js:168`), `reason: null` for every id from
   `resumedAmong`, and when `requestApproval` resolves with a real decision.
3. **Ship it.** `rosterForClient` adds `reason` (string or null) read off the session record.
4. **Render it.** `rowFromRecord` adds `reason`; `sessionRowEl` (`public/app.js:591-606`) shows
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
