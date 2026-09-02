# Message history: implementation plan

The orb shows one line: what you are saying, or what Dante last said. Once the next
thing is said, the previous line is gone. This adds a way to step back through what
was said in this tab, without touching the way the live line works.

The shape below is the council verdict of 2026-09-02, made concrete against the code as
it stands on `main` at `013844f`. Anything the verdict left open is decided here, with
the reason.

## The model

- **A flat timeline, not pairs.** One utterance can produce no reply (nothing captured,
  mic blocked), one reply, or a clarifying `ask` followed by more turns, and a server
  announcement (a watcher firing, a build finishing) arrives with no utterance at all.
  There is nothing to pair. Every line is one entry, and stepping moves one entry.
- **Only what was actually shown as a finished line goes in.** The text sent on release,
  every `reply_text`, every `ask`, and every error the caption showed. Interim
  transcription never enters history: it rewrites the caption ten times per utterance
  and none of those rewrites is a thing anyone will want to step back to.
- **Errors and asks are in, and they demand attention.** "No transcript captured" is
  exactly the line you step back to diagnose; a clarifying question is exactly the
  line you need to see to answer. Both are recorded, and both always snap the view
  back to newest when they arrive, whatever you were reading.
- **A plain reply does not yank you.** If you deliberately stepped back while Dante
  was thinking, the reply is appended and the newer button lights up. The clip is
  audible either way. If you were at newest, the reply shows as it does today.
- **Pressing the talk key ends browsing.** The cursor snaps to newest before
  recognition starts, so interim text streams into the caption exactly as it does
  now and never has to coexist with a past entry. This is the resolution of the
  original plan's contradiction ("newest always shows when the user starts talking"
  vs "transcription appears while scrolled"): the first clause wins, the second is
  deleted.
- **Nothing persists.** In-memory array, capped at 200 entries, gone on tab close.

Every announcement Dante speaks passes through `say()` in `server.js`, whose first act
is `send({ type: "reply_text", text })`, so announcements land in history with no
server change. The one spoken line that is not a `reply_text` is a build's clarifying
question, sent as `{ type: "ask" }`, which is why `ask` has its own record site below.

## What is not being changed

- `rec.onresult`, `rec.onend`, `startListening`, `stopListening`: the transcription
  path. The only addition is a one-line snap at the top of `startListening` and a
  one-line record beside `noteSpokenTurn` in `rec.onend`.
- `setCaption(text, who)` stays the only thing that writes `#caption`.
- The server. No new message types, no protocol change.
- The orb's layout observer in `build-hud.js` already watches `#hud`; the new row is
  inside `#hud` and has a fixed height, so the observer is left alone.

## Stage 1: `public/history-policy.js` and its tests

Pure module, no DOM, the same shape as `visibility-policy.js`. State is a plain object
and every function returns a new one.

```js
// state: { entries: [{ who, text, at, demandsAttention }], cursor: null | index }
// cursor null means "at newest, live". A number is an index into entries.
export const HISTORY_CAP = 200;

export function createHistory() -> { entries: [], cursor: null }

export function append(state, { who, text, at, demandsAttention = false })
  // who: "you" | "dante" | "error". Empty or non-string text is ignored (state returned as-is).
  // Pushes; drops the oldest past HISTORY_CAP, shifting a numeric cursor down by one and
  // clamping at 0 so it keeps pointing at the same entry.
  // cursor null      -> stays null (live view shows the new entry)
  // cursor number    -> stays put, UNLESS demandsAttention, in which case cursor -> null

export function stepOlder(state)   // cursor null -> last-1; n -> n-1; clamps at 0; empty/1 entry -> unchanged
export function stepNewer(state)   // n -> n+1; reaching the last index -> null; null -> unchanged
export function snapToNewest(state) // cursor -> null

export function view(state) -> {
  live: boolean,        // cursor === null
  entry: null | { who, text, at },  // the entry to show; null when there is nothing
  canOlder: boolean,    // there is an entry before the shown one
  canNewer: boolean,    // !live
  index: number,        // 1-based position of the shown entry, 0 when empty
  total: number,
}

export function historyStep(key, holding) -> "older" | "newer" | null
  // "ArrowLeft" -> "older", "ArrowRight" -> "newer"; null while holding, mirroring
  // getVisibilityToggle so a stray arrow mid-sentence does nothing.

export function formatTime(at) -> "HH:MM"  // local, 24h, zero-padded, from a ms timestamp
```

Timestamps are taken with `Date.now()` at the record site and passed in, so the
module never reads the clock and the tests pin exact values.

`test/history-policy.test.js`, `node:test` + `node:assert/strict`, full-sentence names.
`deepEqual` is strict, so `view()` assertions are whole-object. Cases:

- an empty history views as live with no entry and neither button
- appending while live keeps the view live and shows the new entry
- appending a plain reply while stepped back leaves the cursor where it was and lights newer
- appending an ask while stepped back snaps to newest
- appending an error while stepped back snaps to newest
- an empty or non-string text is not recorded
- stepping older from live shows the entry before the newest
- stepping older stops at the oldest entry
- stepping newer past the second-newest entry returns to live
- stepping newer while live is a no-op
- a single entry offers neither button
- the cap drops the oldest entry and a cursor keeps pointing at the same text
- a cursor on the oldest entry when the cap drops it moves to the new oldest
- arrow keys map to steps only while the talk key is up
- formatTime zero-pads hours and minutes

Commit when green: `feat: history-policy.js - flat in-memory timeline with cursor, snap rules, and arrow-key mapping`.

## Stage 2: markup and CSS in `public/index.html`

Under `#caption`, inside `#hud`:

```html
<div id="caption"></div>
<div id="caption-nav" aria-label="Earlier messages">
  <button id="older" type="button" aria-label="Older message">◀</button>
  <span id="caption-when"></span>
  <button id="newer" type="button" aria-label="Newer message">▶</button>
</div>
```

`#caption-when` carries the timestamp and the position, as `14:07 · 3 / 10`, and is
empty while live. The three cells stay in the row at all times: buttons that cannot
step get `visibility: hidden`, never `display: none`, so the row's height never
changes and the orb above it never re-lays on a step. The row uses the `#activity`
type treatment (monospace, 11px, `--muted`), fixed `height: 1.8em`. Under
`@media (max-width: 520px)` the buttons get a 44px square hit area; the row is
already inside the caption column so nothing else moves.

The `t` toggle hides the row with the caption; that is wiring in stage 3, not CSS.

No commit on its own: this stage ships with stage 3.

## Stage 3: wiring in `public/app.js`

Wiring only; every decision is a policy call.

1. **Import and state.** `import { append, createHistory, formatTime, historyStep,
   snapToNewest, stepNewer, stepOlder, view } from "./history-policy.js";` and
   `let history = createHistory();` beside the other module state. Element refs for
   `#caption-nav`, `#older`, `#newer`, `#caption-when`.

2. **`record(who, text, opts)`**, next to `setCaption`. Appends with `at: Date.now()`,
   then calls `renderHistory()`. This is what the five finished-line sites call in
   place of a bare `setCaption`; the interim site keeps calling `setCaption` directly.

3. **`renderHistory()`.** `const v = view(history)`. If `!v.live` and `v.entry`,
   `setCaption(v.entry.text, v.entry.who)`. If `v.live` and `v.entry`,
   `setCaption(v.entry.text, v.entry.who)` too: a step back to live must restore the
   newest line, and after a `record` the write is a repeat of the same text, which is
   harmless. If there is no entry, the caption is left alone (the load-time
   "no speech recognition" message is recorded, so in practice this is only the
   empty-tab case). Then `olderBtn.style.visibility = v.canOlder ? "" : "hidden"`,
   same for newer, and the timestamp cell is emptied when live or set to
   `formatTime(v.entry.at)`, a middle dot, and `v.index / v.total` otherwise.

4. **Record sites.** Each existing `setCaption(...)` below becomes `record(...)`:
   - `rec.onend`, the send branch: `record("you", text)` beside `noteSpokenTurn(text)`.
     The caption already shows this text from the last interim, so the repeat write is
     invisible.
   - `rec.onend`, the empty branch: `record("error", "No transcript captured…",
     { demandsAttention: true })`.
   - `rec.onerror` fatal branch, the mic-blocked line: `record("error", ..., { demandsAttention: true })`.
   - the `else` with no `SpeechRecognition`: same.
   - `ws.onmessage` `reply_text`: `record("dante", msg.text)`.
   - `ws.onmessage` `ask`: `record("dante", msg.text, { demandsAttention: true })`, then
     `awaitingAnswer = true` as today.
   - `ws.onmessage` `error`: `record("error", "⚠ " + msg.message, { demandsAttention: true })`.
   - the two `audio_start` / `audio_end` catch blocks: same.
   - `ws.onclose`: `record("error", "connection closed — …", { demandsAttention: true })`.
   The interim `setCaption(shown, "you")` in `rec.onresult` is untouched.

5. **Snap on press.** First line of `startListening` after the `canStartListening`
   guard: `history = snapToNewest(history); renderHistory();`. Comment says why: the
   interim text that follows overwrites the caption, and it must overwrite the newest
   line, not a past one the person was reading.

6. **Buttons and keys.** Click handlers on `#older` / `#newer` call `stepOlder` /
   `stepNewer` then `renderHistory()`, and `blur()` the button first, for the same
   reason the keys panel does: a focused button takes the next Space as a click, and
   Space is push-to-talk. In the window `keydown` handler, before the visibility
   branch: `const step = historyStep(e.key, holding); if (step) { ...; return; }`, and
   skip when `document.activeElement` is an `input` so the volume slider keeps its
   arrows.

7. **`t` toggle.** In `toggleVisibility("caption")`, toggle `hidden` on `#caption-nav`
   alongside `capEl`. `panelsVisible()` keeps reading `capEl`. No change to
   `visibility-policy.js`.

8. **Diagnostics.** A `dbg("history: 3/10")` line on each step, so the `d` panel
   shows navigation the way it shows everything else.

Run `npm test` (stage 1 tests plus the whole suite) and check by hand in Chrome:

- hold Space while reading entry 1 of 10: caption jumps to newest before the first
  interim word appears, and the orb does not move
- step back, ask something, watch the reply land without yanking the view; press ▶
- step back, trigger "No transcript captured" (release without speaking): view snaps
- `t` hides caption and row together; `d` shows the history lines

Commit: `feat: step back through this tab's messages - older/newer under the caption, timestamped, snap to newest on talk-key press, ask and error always snap`.

## Stage 4: README

In the Hotkeys table, after **Space**:

```
| **← / →** | step back and forward through this tab's messages, timestamped; gone when the tab closes |
```

And a sentence under it: the view returns to newest the moment Space is pressed, and
when Dante asks a question or something goes wrong; a plain reply that arrives while
you are reading an older line lights the → button instead.

Commit: `docs: README hotkeys - arrow keys step through message history`.

## What is deliberately left out

- Pair navigation. Two presses cross a turn and its reply. The verdict priced this
  and took it: pairs do not exist in the message flow.
- A separate history pane. The caption is the surface; a second pane would be a
  second layout under the orb for the same text.
- Server-side transcript in the tab. `lib/transcript.js` exists for `claude -p`
  resumption, not for the page; wiring it here would make history survive a reload,
  which the ask rules out.
- A "follow live" toggle. Snap-on-press plus attention-snap covers every case the
  council raised without a mode.

## Sequence and size

Stage 1 first, red to green, before `app.js` is opened: if a rule above cannot be
written as a pure function, the rule is wrong, not the seam. Stages 2 and 3 together.
Stage 4 last. Roughly 90 lines of policy, 100 of tests, 15 of markup and CSS, 50 of
wiring, 3 of README. One sitting.
