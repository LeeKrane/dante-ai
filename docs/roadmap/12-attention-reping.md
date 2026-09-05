# 12. Needs-attention re-ping

**Verdict** MEASURE-FIRST. **Size** S to M. **Channel** +. Ship after plans 4 and 18 so the
re-ping can say why the session is waiting.

## Goal

A needs-attention that nobody acted on is spoken again after a quiet interval, at most twice,
and stops the moment the session moves again or the owner addresses it.

## Why

An announcement plays once. If the owner was away from the page or talking over it, it is lost,
and the session sits blocked until someone notices. The cost is voice traffic, so the interval is
long, the count is capped, and every acknowledgement path silences it.

## Today

- `reportAttention(event)` (`server.js:477-502`) records and speaks once, deduped on
  `${sessionId}:needs-attention:${detail}` through `reported = createDeduper()`
  (`lib/hooks.js`, `server.js:268`).
- `resumedAmong(reported, roster)` (`lib/watch.js:195-204`) lists reported sessions the roster
  now shows working; the poller's `onRoster` callback (`server.js:168`) uses it to forget.
- `requestApproval` (`server.js:538-581`) resolves through `finish(decision)` when a voice
  answer lands; the timeout branch calls `reportAttention`.
- Spoken turns that target a session resolve it through `findTarget` (`lib/confirm.js:117`);
  `answerProposal` (`server.js:911-962`) runs the proposal on yes.

## Design

1. **Pure tracker.** `lib/attention.js` exporting `createRepinger({ intervalMs = 120_000, max =
   2 })` with `arm(sessionId, event, now)`, `ack(sessionId)`, `clear(sessionId)`, and `due(now)`
   returning the events whose interval elapsed and whose count is below `max`, incrementing each
   returned entry. A re-armed session (new detail) resets its count. Fully synchronous; time is
   injected.
2. **Arm.** In `reportAttention`, after the first announce, `repinger.arm(sessionId, event, now)`.
3. **Tick.** In `onRoster`: `repinger.clear(id)` for every id in `resumedAmong(...)`; then for
   each entry from `repinger.due(now)` call `announce(formatSpoken({ ...event, again: true }))`.
   `formatSpoken` gains an `again` flag that prefixes "Still waiting, sir:". Keep the dedupe key
   distinct from the first announce so `reported` does not swallow it.
4. **Ack.** `repinger.ack(sessionId)` when: `requestApproval` resolves with a real decision for
   that session; a proposal targeting that session is answered yes; `dispatchRead` or a `tell`
   names it. All of these already know the sessionId.
5. **Constant, not config.** Two minutes and two repeats, in `lib/attention.js`, with the reason
   in a comment. An env knob can come later if the numbers turn out wrong.

## Files

- `lib/attention.js`: new. `lib/notify.js`: the `again` prefix. `server.js`: arm, tick, four
  ack sites. `README.md` "It reports back".

## Tests

- `test/attention.test.js` (new): nothing due before the interval; one due after; capped at
  `max`; `ack` and `clear` silence; re-arm with a new detail resets; `due` never returns the
  same entry twice within one interval.
- `test/notify.test.js`: `formatSpoken` with `again: true`.

## Docs

- `README.md`: one sentence under "It reports back".
- `docs/known-limitations.md` §5: the re-ping goes to the newest page only, like every
  announcement.

## Done when

A session blocked at an approval with nobody answering is spoken at once, again after two
minutes, again after four, then never; saying yes to a later prompt for it, or the session
resuming, ends the sequence early. `npm test` green.

## Out of scope

Escalation beyond the page (rejected council item 34). Changing the approval window.
