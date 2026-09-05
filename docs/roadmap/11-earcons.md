# 11. Earcons

**Verdict** SOON. **Size** S. **Channel** − (two sentence classes become a half-second tone).

## Goal

"Started" and "finished without error" play a short distinct tone instead of a sentence.
Needs-attention, failures, and anything that carries a detail keep the spoken sentence. The
recap log still records every event, so "catch me up" is unchanged.

## Why

Dante speaks every state change. A sentence per event exhausts the listener and occupies the one
voice channel; a tone carries "something started" or "something finished" in under a second and
leaves the sentence for events with content. The owner chose this split on 2026-09-05.

## Today

- Event kinds are the closed set `KINDS = started, needs-attention, complete, failed`
  (`lib/notify.js:35`). Separate from that, `announce()` now carries a wire-level `kind`
  (`normalizeKind` in `lib/announcements.js`) used for watcher announcements: any kind other
  than `"other"` is kept in `pending` and replayed to the next page that connects.
  `formatSpoken(event)` (`lib/notify.js:91-109`) builds the sentence;
  `formatEvent` (`:63-79`) the recap line. `recordEvent` lives in `lib/memory.js:997-1013`.
- `reportComplete(sessionId, context)` (`server.js:458`) records the event and calls
  `announce(formatSpoken(...))`; the completion sentence carries `summarizeSession`'s summary
  (`lib/transcript.js:445-464`). `reportAttention` (`server.js:689-716`) does the same for
  needs-attention. Started events are reported from the roster poller's `onEvents` callback.
- `announce(text, { kind, sessionId })` (`server.js:970-982`) sends `{ type: "announce", id,
  text, kind }` to the newest page; the page answers `announce_ready` when `floorIsFree`
  (`public/playback-policy.js:114`) and the server streams `audio_start / audio_chunk /
  audio_end` (`say`, `server.js:1634`).
- The page owns one `AudioContext`, wired once in `ensureGraph` (`public/app.js:1223`), and
  one `<audio id="clip">` element (`public/index.html:629`). `public/clip-stream.js` queues one
  clip's bytes; a new `audio_start` pre-empts the current clip (`handoffAfterPreempt`,
  `public/app.js:1303`).
- All audio today is speech; no sound file or oscillator exists.

## Design

1. **Policy, pure, server side.** `earconFor(event)` in `lib/notify.js` returns `"started"`,
   `"finished"` or `null`: `started` → `"started"`; `complete` with no failure marker →
   `"finished"`; `needs-attention`, `failed`, and any `complete` whose summary reports an error
   → `null`. Both callers keep `recordEvent` exactly as today.
2. **Frame.** When `earconFor` returns a name, `reportComplete` and the started path send
   `{ type: "earcon", name }` to the newest page instead of `announce(...)`. Do not route it
   through `announce`: a tone must never land in `pending` and replay on reconnect. Document
   the frame in `docs/protocol.md` under "Server → client frames". When it returns `null`,
   nothing changes.
3. **Sounds, pure spec.** `public/earcons.js` exports `earconSpec(name)` returning an array of
   `{ freq, ms, gain }` steps (started: two rising notes; finished: three descending) and
   `playEarcon(ctx, spec, at)` that schedules `OscillatorNode` and `GainNode` on the shared
   context. Total length under 500 ms. No assets, so nothing under `public/` imports from
   `node_modules` and the no-bundler rule holds.
4. **When to play.** In the `ws.onmessage` chain (`public/app.js:526`) add the `earcon`
   case: play immediately when `floor.playing` is false, otherwise drop it. A tone that plays
   over speech is noise, and a tone held for later carries no information. Never pre-empt a
   clip for it.
5. **Completion summary.** With a tone in place of the finished sentence, the summary text is
   reachable through `recap` and `read`. Say so in the README so nobody hunts for a lost
   announcement.

## Files

- `lib/notify.js`: `earconFor`. `server.js`: two call sites. `public/earcons.js`: new.
  `public/app.js`: one case. `docs/protocol.md`, `README.md`.

## Tests

- `test/notify.test.js`: `earconFor` for every kind, including a `complete` event whose summary
  contains a failure marker.
- `test/earcons.test.js` (new, `node:test`, imports `public/earcons.js` the way
  `test/playback-policy.test.js` imports its module): every spec is finite, positive, under
  500 ms total, and `earconSpec("unknown")` returns `null`. `playEarcon` takes a fake context
  object recording `createOscillator` / `createGain` calls; assert start and stop times.

## Done when

A session start plays the rising tone and speaks nothing; a clean finish plays the descending
tone; a needs-attention still speaks its sentence; "catch me up" lists all three. `npm test`
green.

## Out of scope

User-selectable sounds. Tones for build progress lines. Any change to `floorIsFree`.
