# 5. Voice "what's blocked?"

**Verdict** SHIP-NEXT. **Size** S. **Channel** − (collapses several status questions into one).

## Goal

One spoken question ("what's blocked", "what needs me", "where are we") gets one short paragraph:
which sessions need the owner right now, which finished, which are still running. Built by code,
not by the model, so it is deterministic and testable.

## Why

`recap` replays the past-events log and clears it; it answers "what happened", not "what is the
state now". The roster block is already in every prompt, so the model can answer conversationally,
but the answer varies, can pad, and is not pinned by a test. A machine-built line costs no model
turn and reads the same every time.

## Today

- `describeRoster(roster, now)` in `lib/agents.js:323-345` renders the numbered per-session line
  the model sees every turn (`lib/turns.js:113`). `activity(record)` (`lib/agents.js:167-186`,
  not exported) reduces a record to `working | done | blocked | idle | running`.
- `dispatchSession` in `server.js:1953-2052` is the verb switch. `recap` runs unconfirmed via
  `dispatchRecap(send, preamble)` (`:1954-1957`); `read` via `dispatchRead` (`:1966-1969`).
  Unknown verbs fall to the "I can start a session, talk to one, ..." line (`:1978-1983`).
- `CONFIRMED_VERBS` in `lib/confirm.js:47` is `start, tell, interrupt, stop, watch`; the new
  verb must stay out of it.
- The model learns the verbs it may emit from `lib/brain.js` (`sessionsBlock`, around
  `:111-160`); `test/brain.test.js` pins that text.
- `describeFinished(records, aliases, now)` in `lib/recall.js:186-206` already names finished,
  still-readable sessions.

## Design

1. **Pure function.** `describeStatus(roster, opts = {})` in `lib/agents.js` beside
   `describeRoster`, exporting `activity` if it is not already. Groups the ordered roster by
   activity word into three buckets and returns at most three sentences:
   - needs you: blocked sessions, by name, with the `reason` field from plan 18 when present
     ("fix-tests in jarvis is waiting at the terminal");
   - finished: done sessions, newest first, capped at three names then "and N more";
   - running: a count plus the names if three or fewer.
   Empty roster: "Nothing is running, sir." Every sentence ends with the spoken register the
   persona uses. No timestamps; `describeRoster` already carries elapsed time for the model.
2. **Verb.** Add `status` to `dispatchSession`: unconfirmed, no target, calls
   `say(send, describeStatus(await rosterPoller.read({ maxAgeMs: 0 })), ...)` the way
   `dispatchRecap` speaks. Add it to the fallback sentence so a misrouted turn names it.
3. **Persona.** One clause in `sessionsBlock` in `lib/brain.js`: `verb=status` when the owner
   asks what is blocked, waiting, running or finished right now; `recap` stays for "what
   happened". Update the pinned string in `test/brain.test.js`.
4. **Recap untouched.** `status` does not clear the event log.

## Files

- `lib/agents.js`: `describeStatus`. `lib/brain.js`: one clause. `server.js`: one case in
  `dispatchSession`, the fallback line. `docs/voice-reference.md`: the phrases.

## Tests

- `test/agents.test.js`: empty roster; one of each state; more than three finished; a blocked
  record with and without `reason`; output has no newline and at most three sentences.
- `test/brain.test.js`: the persona names `status` and keeps `recap` distinct.
- `test/action.test.js`: a `[ACTION:SESSION verb=status]` tag parses to `{ verb: "status" }`
  (it already should; pin it).

## Docs

- `docs/voice-reference.md`: add the phrases and the one-paragraph answer shape.
- `README.md` "It reports back": one sentence.

## Done when

Saying "what's blocked" with two sessions running, one blocked and one finished yields one
paragraph naming the blocked one first, without a proposal, without clearing the recap log.
`npm test` green.

## Out of scope

Per-session detail beyond the one reason word (that is `read`). Any UI.
