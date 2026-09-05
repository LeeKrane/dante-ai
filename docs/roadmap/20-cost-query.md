# 20. Cost and token query

**Verdict** LATER. **Size** S, if the numbers exist. **Channel** +.

## Goal

"How much has fix-tests used" speaks the session's token usage. Tokens, not money: the
subscription makes cost a curiosity, and Dante should not invent a price.

## Why

Cheap to wire if the CLI exposes the numbers; useless otherwise. The first step is finding out
which, and writing the answer down either way.

## Today

- `parseListing` in `lib/agents.js:102-143` reads `sessionId, id, name, cwd, kind, status,
  state, pid, startedAt` from `claude agents --json` and nothing else.
- `lib/transcript.js` reads a session's transcript JSONL: `transcriptPath`, `tailMessages`,
  `summarizeSession` (`:445-464`), `readSession` (`:563`). Claude Code transcripts carry a
  `usage` object on assistant messages in current CLI versions, but that is reverse-engineered
  (`docs/known-limitations.md` §2), so it must be pinned by a fixture and tolerated when absent.
- `readTarget` in `lib/confirm.js:223` resolves a spoken session name or number for unconfirmed
  verbs; `dispatchRead` (`server.js:2075`) is the model to copy.

## Design

1. **Spike, thirty minutes, before any code.** Run `claude agents --json` with a session up and
   look for usage or cost fields. Open that session's transcript and look for `usage` on
   assistant lines (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
   `cache_creation_input_tokens`). Record the finding at the top of this file. If neither
   exists, add a paragraph to `docs/known-limitations.md` §2 and stop; the rest of this plan is
   void.
2. **Pure sum.** `usageOf(messages)` in `lib/transcript.js`: sums the four token fields across
   assistant messages, ignoring lines without `usage`, returning `{ input, output, cacheRead,
   cacheWrite, turns }` or `null` when no line carried usage.
3. **Verb.** `[ACTION:SESSION verb=usage name=... number=...]`, unconfirmed, resolved through
   `readTarget`. Speak "fix-tests has used about forty thousand tokens over twelve turns, sir",
   rounding to two significant figures; the exact numbers go to the log line. No usage → "I
   cannot see usage for that session, sir."
4. **Persona.** One clause in `sessionsBlock` (`lib/brain.js`). Pin in `test/brain.test.js`.

## Files

- `lib/transcript.js`: `usageOf`. `lib/brain.js`: one clause. `server.js`: one case beside
  `dispatchRead`. `docs/voice-reference.md`, `docs/known-limitations.md`.

## Tests

- `test/transcript.test.js`: a fixture of JSONL lines with and without `usage`; totals; `null`
  when none; rounding helper if separate.
- `test/brain.test.js`: persona pin.

## Done when

Either the known-limitations note exists and this plan is marked void at its top, or the verb
answers for a running session with a transcript and says it cannot for one without. `npm test`
green.

## Out of scope

Dollar figures. Per-day or per-repository totals. Anything read from Anthropic's API.
