# Voice latency audit: where the 1,160 ms turn goes, and eleven ways to shorten it

## Context

One spoken turn — key released, transcript sent, reply heard — takes about 1,160 ms from the
transcript reaching the server to the first byte of audio leaving it. This audit was a read-only
pass over the voice pipeline to find where that time goes and what would shorten it without
trading away the quality of the voice. Nothing was changed; this document is the deliverable.

The method was a set of read-only sub-agents on cheaper models, each with one slice of the
pipeline (the TTS path, the brain path, the browser half, the pipelining and instrumentation
seams, the Fish Audio API docs, the Claude CLI flags), with the findings reconciled here.

Two things to hold in mind while reading:

- **Only two spans are measured.** The brain's wall time and Fish's time-to-first-byte are both
  logged and both shown behind the `d` debug panel. Nothing sums them, and nothing timestamps the
  transcript's arrival, so the baseline below is assembled from figures the repo itself recorded
  rather than read off a dial. Phase 0 exists to fix that.
- **Everything below phase 1 is a projection.** The "after" numbers are estimates, not
  observations, and should be replaced by real ones before any later phase is attempted.

Symbols are cited by name rather than line number: the audit was made against
`feat/session-orchestration` at `b34151e` plus then-uncommitted working-tree edits, and five
commits landed on the branch before this document did.

## Baseline: what one spoken turn costs today

| Segment | Where | Measured |
|---|---|---|
| Warm `claude -p` turn | `lib/brain.js` (`buildSessionArgs`, `readResult`) | 739–777 ms on three consecutive warm turns; ~750 ms typical |
| Parse reply, synchronous `saveStore` | `server.js` message handler; `lib/memory.js` `saveStore` | ~5–15 ms |
| Fish time-to-first-byte | `lib/tts.js` `speakStream`; `server.js` `say` | 350–450 ms under `latency: "balanced"` |
| **Transcript received to first audio byte** | | **≈1,160 ms** |

Not shown, and not measured anywhere in the codebase: the speech engine's own delay between key
release (`rec.stop()`) and `rec.onend`, which is when the transcript is sent. It sits in front of
every number above and may be the largest single segment.

Projected after phases 1–2: ~950 ms (brain ~700 ms, Fish ~250 ms). Projected after phase 3:
~550 ms (first sentence ~300 ms, Fish ~250 ms, the rest of generation overlapped with playback).
Both are projections.

### The outlier that is not in the baseline

The session roster is re-read every `POLL_MS` (5,000 ms) but is considered stale after
`MAX_ROSTER_AGE_MS` (3,000 ms), both in `lib/agents.js`. A turn that lands in the two-second
window between those spawns a fresh `claude agents --json` child on the critical path, leashed at
`LIST_TIMEOUT_MS` (3,000 ms), before the model is asked anything. The code's own comment on
`LIST_TIMEOUT_MS` says "knowing what is running is a nicety, answering is not" — yet the message
handler in `server.js` awaits the listing unconditionally before calling the brain. On a machine
where the CLI is slow to enumerate sessions, this is the difference between a fast turn and a
three-second one, on roughly 40% of turns.

**Fixed.** `MAX_ROSTER_AGE_MS` is now `POLL_MS + LIST_TIMEOUT_MS` (8,000 ms), so a turn spawns
that child only when the poller has stalled or never succeeded, not on an ordinary two-second
window every cycle; the one call site that needs a guaranteed-fresh roster (the stop resolved on
the way out of a proposal wait) now asks for one explicitly via `rosterPoller.read({ maxAgeMs: 0 })`.

## Four things already right — do not touch

The audit found less low-hanging fruit than expected, because most of the obvious work is done.
Stated here so nobody spends a week re-deriving it.

- **Warm CLI process.** One long-lived `claude -p` fed over stdin, not a spawn per turn. The repo
  measured the difference: ~1,080 ms to boot and ~550 ms to shut down, so ~1,700 ms saved on every
  ordinary turn (the measurements are recorded in the comments above `buildSessionArgs`).
  Independently confirmed during the audit: a fresh `--resume` costs ≈2,979 ms wall for 984 ms of
  API time.
- **Tool definitions removed, not merely disallowed.** `--tools ""` took the chat turn from 12,082
  input tokens to 2,076 (recorded above `TOOLS_OFF` in `lib/brain.js`). MCP servers are excluded
  the same way via `--strict-mcp-config`.
- **Client-side prebuffer is zero.** MediaSource is armed and `play()` called on `audio_start`,
  before a single chunk lands (`public/app.js`). The browser's own decoder is the only gate.
  There is nothing to tune here.
- **Prompt caching is working.** Verified live: turn 2 of a warm session read 11,856 tokens from
  cache. The system prompt is frozen at spawn and per-turn variance lives only in the user
  message, which is exactly the ordering a prefix cache wants.

## The work, in the order it should land

The phases are a sequence, not a ranking. Phase 0 is what makes phases 1 and 2 falsifiable, and
phase 3 is worth attempting only once the cheap constants have been proven or disproven with
numbers.

### Phase 0 — measure the whole span (0 ms gained; enables everything below)

| Change | Where | Effort |
|---|---|---|
| **One end-to-end span.** Timestamp the transcript on arrival and emit a single `debug` line summing transcript → first audio byte. Today the brain `ms` and the Fish `ms` are adjacent debug lines that are never correlated. | `server.js` message handler; `say` | Low |
| **Measure the speech-engine tail.** Record key-release (`rec.stop()`) to `ws.send` in the browser. This is the one segment of the pipeline with no number attached to it at all. | `public/app.js` around `rec.onend` | Low |

### Phase 1 — constants and ordering (est. 100–450 ms; one-line changes)

| Change | Where | Est. gain | Risk |
|---|---|---|---|
| **Stop blocking a turn on a stale roster.** Either raise `MAX_ROSTER_AGE_MS` to ≥ `POLL_MS`, or make the read best-effort and take whatever is cached. A missing roster is already a supported state — `lib/turns.js` is tested on "a listing that failed is indistinguishable from never having asked." **Done:** `MAX_ROSTER_AGE_MS` is now `POLL_MS + LIST_TIMEOUT_MS` (8,000 ms); the stop path forces a fresh read via `rosterPoller.read({ maxAgeMs: 0 })`. | `lib/agents.js` `MAX_ROSTER_AGE_MS`; `server.js` `await listing` | 0–3,000 ms on ~40% of turns | Low |
| **Confirm thinking is actually off for the brain child.** Haiku 4.5 emitted a `thinking` content block ahead of its text block when verified on this machine, which delays the first text token. `claude-settings.json` sets `alwaysThinkingEnabled: false` and is passed via `--settings`, so this may already be handled — read `usage` off a real turn before changing anything, then add `MAX_THINKING_TOKENS=0` to the spawn env only if it is not. | `lib/brain.js` `buildSessionArgs`; `claude-settings.json` | Unknown — verify first | Low |
| **`latency: "low"` instead of `"balanced"`.** Fish documents three values — `normal` (best quality), `balanced` (reduced latency), `low` (lowest). The repo already moved `normal` → `balanced` and measured 2,213 ms → 350 ms on first byte. No figure is published for `low`; the existing `first=…ms` log line makes it a ten-minute A/B. | `lib/tts.js` `buildTtsRequest` | Unquantified | Quality |
| **Set `chunk_length` to 100–120.** Documented by Fish as "text segment size for processing — smaller chunks start audio sooner." The default is 300 (API reference) or 200 (features page); the request currently sets neither. | `lib/tts.js` `buildTtsRequest` | Unquantified | Quality |
| **Move `saveStore` off the critical path.** A synchronous `writeFileSync` + `renameSync` sits between the model answering and `say()` being called. Small, but it is pure dead time in front of a voice. | `server.js` (the `saveStore` call after the brain returns); `lib/memory.js` `saveStore` | ~5–15 ms | Low |

### Phase 2 — transport (est. 100–200 ms per clip)

| Change | Where | Est. gain | Risk |
|---|---|---|---|
| **Keep the Fish connection warm.** `speakStream` calls bare global `fetch` with no dispatcher, no agent, and no keep-alive tuning. Undici's default keep-alive timeout is 4 seconds; conversational gaps are longer, so most clips pay a fresh TLS handshake to `api.fish.audio`. Fixable inside the no-new-dependencies rule with `node:https` and an `Agent({ keepAlive: true })`, or by prewarming the connection. Fish's own published time-to-first-audio is ~90 ms against the 350–450 ms observed here — the gap is network, not model. | `lib/tts.js` `speakStream`, `fishRequest` | ~100–200 ms | Rewrite |
| **Delete the dead buffered path.** `speak()` has no production call site — `server.js` imports only `speakStream`. Housekeeping rather than latency, but it removes the tempting wrong answer. | `lib/tts.js` `speak` | — | Low |

### Phase 3 — sentence pipelining, the structural one (est. 350–450 ms)

| Change | Where | Est. gain | Risk |
|---|---|---|---|
| **Start speaking sentence one while the model is still writing sentence two.** The warm child already runs `--output-format stream-json`, and `readResult` already reads it line by line — then discards every event that is not the terminal `result` ("Only the terminal result event ends a turn"). Adding `--include-partial-messages` turns on `content_block_delta` events carrying `text_delta`. Buffer deltas to the first sentence boundary, hand it to Fish, keep going. Everything else needed already exists: an `AbortController` at every layer, a per-clip id on the wire, and a client append queue (`public/clip-stream.js`) whose `finish()` is deliberately a third state rather than a final chunk. | `lib/brain.js` `buildSessionArgs`, `readResult`; `server.js` `say`; `public/clip-stream.js` | ~350–450 ms | Design |

**The obstacle is prosody, not plumbing.** The repo already rejected clip-per-utterance once, for
a reason worth quoting from the comment above `joinSpoken` in `server.js`: "two separate clips
with a synthesis gap between them sound like a machine reading a list" — which is why
`joinSpoken` fuses utterances rather than queueing them. Sentence chunking walks straight back
into that, so the delivery mechanism is the decision:

| Option | Verdict | Why |
|---|---|---|
| **Fish WebSocket** (`wss://api.fish.audio/v1/tts/live`) | **Recommended** | Takes text incrementally on one synthesis stream, with `condition_on_previous_chunks` defaulting to true — built for exactly this shape. Cost: it frames in MessagePack, and the house rule permits no third dependency, so that means roughly 80 hand-rolled lines for one narrow schema — pure, and testable the way the rest of `lib/` is. |
| **PCM over HTTP** | Fallback | Several requests in `format: "pcm"` concatenate sample-exact, with no encoder padding at the seam. Cost: the client abandons MediaSource for a Web Audio buffer queue, and bandwidth goes from ~16 KB/s to ~48 KB/s at 24 kHz — fine on loopback and a VPN. |
| **mp3 per sentence** | Not advised | Cheapest to build — append each sentence's mp3 to the same SourceBuffer. But encoder padding at every seam is an audible click, and prosody restarts each sentence. This is the failure mode `joinSpoken` exists to prevent. |

Pipelining must also extend the newest-wins model rather than replace it: the supersede check
that `say` runs at the first audio byte has to run per segment, and a clip already committed
still must not be cut mid-sentence.

### Phase 4 — perceived latency, once the pipeline is done

| Change | Where | Est. gain | Risk |
|---|---|---|---|
| **Overlap the build kickoff with its own announcement.** The kickoff clip is awaited to its final audio byte before the build child is spawned — `await say(…, "working")`, then `runBuild(…)`. The build could be running during the sentence that announces it. | `server.js` build dispatch | ~2,000 ms of build wall time | Low |
| **Binary WebSocket frames for audio.** Every Fish chunk becomes a JSON message with a base64 `data` field — ~33% inflation, plus an `atob` and a `Uint8Array.from` per chunk in the browser. A 4-byte clip-id prefix on a binary frame preserves the demux the client already does by id. | `server.js` `say` (`audio_chunk`); `public/app.js` chunk handler | Bandwidth + per-chunk CPU | Protocol |
| **Revisit the speech-engine tail** — but only with phase 0's number in hand. The transcript is sent on `rec.onend`, so the app waits for the engine to settle rather than for the last final result. Short-circuiting risks losing trailing words, which is a worse failure than the delay. Measure before touching. | `public/app.js` `rec.onend` | Unknown | Correctness |

## Considered and declined

- **`--bare`** skips hooks, LSP, plugin sync, auto-memory, keychain reads and CLAUDE.md
  discovery, and the docs say it will become the default for `-p`. It also never reads the OAuth
  keychain, so it requires `ANTHROPIC_API_KEY` — which contradicts the project's stated premise
  of running on the Claude subscription with no API key. And it only pays at process startup,
  which for the warm brain happens once per server lifetime. Wrong trade.
- **`--no-session-persistence`** skips disk writes, and with them `--resume`. The resumable
  session id is what `memory.json` stores and what the next page load continues from. It would
  buy milliseconds and cost the memory feature.
- **A playback queue.** `docs/memory-and-orchestration-plan.md` records this as deliberately not
  built — "newest-wins is what the last three stages established." See the note under phase 3.

## Provenance

Read-only audit; no source files were modified. Measured figures are taken from the comments in
`lib/tts.js` (the `normal`/`balanced` comparison), `lib/brain.js` (the warm-process
measurements), and `docs/memory-and-orchestration-plan.md` stages 17–19, plus two live checks
made during the audit (the `--resume` cost and the cache-read count). Fish API behaviour
(`latency` values, `chunk_length`, the `/v1/tts/live` WebSocket, PCM output) is from Fish Audio's
published documentation as of 2026-08-27.
