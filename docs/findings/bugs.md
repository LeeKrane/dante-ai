# Verified bugs

Ranked. Every one was confirmed by reading the source; each states a concrete
trigger. Nothing here is a style note.

---

## B1 — MEDIUM-HIGH — closing the newest tab silences announcements for every other tab

`server.js:1677`

`voice` holds the newest connected page's `send`. On close the handler does
`if (voice === send) voice = null;` and stops there — it never falls back to a
tab that is still open, even though it computes `others` (live clients) eleven
lines later for the brain-session teardown.

Trigger: open tab A, then tab B (`voice` = B's send), then close B. Tab A is
still sitting there, but `voice` is now `null`. From that point `announce()`
returns early on `!voice`, so every session-completion line is silently skipped,
and `requestApproval()` takes its `!voice` branch, so every voice approval goes
unasked and falls through to whatever the session would have done anyway. Only
reloading tab A recovers.

Fix: on close, if `voice === send`, reassign it to a remaining live client's
`send` rather than `null`. That needs a `ws -> send` map (or rebuilding `send`
from a surviving `wss.clients` entry); `sessions` currently maps `ws -> sessionId`.

## B2 — MEDIUM-HIGH — audio chunks are dropped while the AudioContext resumes

`public/app.js:736-747`

`startClip` is `async` and does `if (audioCtx.state === "suspended") await audioCtx.resume();`
at line 738 — **before** `incoming` is assigned (line 747, or later at 757 on the
MediaSource path). `pushClipChunk` (`:826`) and `endClip` (`:833`) both bail on
`!incoming`. Because each WebSocket message is its own event-loop task, the awaits
in `startClip` do not hold back the `audio_chunk` messages behind it.

Trigger: leave the tab backgrounded during a long build, so Chrome suspends the
AudioContext. When the done-line clip arrives, `resume()` is a real async round
trip, and the `audio_chunk` frames the server sends immediately after are
discarded before `incoming` exists. The reply plays truncated or not at all, with
no error surfaced.

Fix: set a placeholder `incoming = { id: msg.id }` before the `await`, then fill
in `queue`/`chunks` once the context is running.

## B3 — MEDIUM — the mic stays live after the window loses focus mid-hold

`public/app.js:502-544, 594-617`

`holding` is set true in `startListening` and cleared only in `stopListening`,
which runs off the button's `pointerup` and the `keyup` handler. There is no
`blur`, `visibilitychange` or `pagehide` handler anywhere in the file (the sole
match for "blur" is `cancelBtn.blur()`).

Trigger: hold Space, Alt-Tab away, release the key in the other window. This
window never sees `keyup`, so `holding` stays true and `rec.onend` (`:536`)
keeps auto-restarting recognition — the mic stays hot while the user is
elsewhere, and the button keeps its pressed styling.

It does self-recover on the next Space press-and-release in this window (the
keydown at `:609` is skipped because `holding` is already true, then the keyup
clears it), so this is not the permanent lock it first looks like — but the
open mic in between is the real problem.

Fix: clear `holding` and stop recognition on `window` `blur` and
`document` `visibilitychange`.

## B4 — MEDIUM — a failed queue delivery silently discards the rest of the queue

`server.js:134-148`

`deliverQueued` calls `takeQueued` first, which **removes** every waiting message
from the store, then delivers them one at a time and `break`s on the first
failure. The comment explains why it stops pressing on — the remaining messages
assumed this one landed — but nothing addresses where they go: they are already
out of the store, so they are gone. The failed one included.

Trigger: two follow-ups are queued for `jarvis-3`; it goes idle; the first
`tellSession` fails. Both messages are lost. The only trace is one `log()` line
on the server console — no Slack post, no spoken line — unlike every other
failure path in this file, which reports through `postForSession` or
`reportAttention`.

Fix: put the undelivered remainder back, or report the loss through
`postForSession` so it is visible where the rest of a session's events are.

## B5 — MEDIUM — a session jarvis stopped is announced as having "finished"

`lib/notify.js:107-108`, and the call site in `server.js`'s `reportComplete`

`formatSpoken`'s `complete` branch ends `return summary ? … : opener;`. Unlike
its own `failed` and `needs-attention` branches, it never falls back to `detail`.
Separately, `reportComplete` passes `detail: remembered.stoppedAt ? "stopped from here" : ""`
to `formatEvent` (the Slack line) but does **not** pass `detail` to `formatSpoken`
at all.

Trigger: jarvis stops `jarvis-1` on request, and `summarizeSession` returns null
(missing transcript, or the ~25 s Haiku call times out — both documented as normal).
Slack correctly reads `jarvis-1 - done - stopped from here`; the spoken line is
`"jarvis-1 finished, sir."`, indistinguishable from a session that actually
completed its work.

Fix is two-part: fall back to `detail` in `formatSpoken`'s last branch, and pass
`detail` from `reportComplete`'s `formatSpoken` call.

## B6 — MEDIUM — `awaitingAnswer` is only ever cleared when a build starts

`public/app.js:107-123, 356`

`awaitingAnswer` is set true at `:356` when the server asks a clarifying question,
and cleared only inside `takeBuildRequest()` (`:123`), which is called from exactly
one place: `buildHud.start(takeBuildRequest())` at `:137`, on `setState("working")`.

Trigger: the server asks a question, the person answers, but no build starts —
e.g. the one-build-at-a-time slot is occupied, so the server replies with the
busy line instead of dispatching. `awaitingAnswer` stays true, and every later
independent request in that session is folded into `answerTurns` instead of
becoming a fresh `requestTurn`, mislabelling the Build HUD's request line for the
next real build.

Fix: also clear it on any reply that is not a further `ask`.

## B7 — LOW — the orb says "listening" when recognition failed to start

`public/app.js:582-587`

`setState("listening")` runs unconditionally before `try { rec.start(); }`, whose
`catch` only writes to the debug panel.

Trigger: press-release-press faster than `rec.stop()`'s async teardown; the second
`rec.start()` throws `InvalidStateError`, `listening` is never set true, and the
caption stays empty while the orb claims to be listening. The stale `onend` from
the first session eventually force-restarts recognition, so it self-heals — the
window of lying UI is the defect.

Fix: reflect the failure in state on catch instead of leaving `"listening"` set.

## B8 — LOW — the HUD's `scars` array grows without bound

`public/build-hud.js:924`

`scars` is pushed on every reported line and is only ever emptied by a full reset
(`:874`, `:1004`). `record`, the sibling buffer, is capped at `RECORD_CAP = 40000`
with the comment "a runaway build must not eat RAM" — `scars` has no equivalent,
and `drawScarRelight` (`:745`) walks the whole array every animation frame.

Trigger: a chatty 20-minute build accumulates thousands of entries, so per-frame
cost climbs for the rest of that build.

Fix: cap `scars` the way `record` is capped.

## B9 — LOW — nested workspaces get the wrong alias in the roster panel

`server.js:437`

`rosterForClient` picks the alias with
`byPath.find(([, path]) => record.cwd === path || record.cwd?.startsWith(path + "/"))`
— first match wins, in `Object.entries` order.

Trigger: two workspaces are registered, `/home/x/work` as `work` and
`/home/x/work/api` as `api`. A session in `/home/x/work/api` matches the `work`
prefix first and is labelled `work` in the panel — so two different repositories
read as the same one beside the orb.

Fix: choose the **longest** matching path rather than the first.

## B10 — LOW — `buildName` can return a name it knows is taken

`lib/sessions.js:229-234`

After trying suffixes `-2` through `-99`, the loop falls through to `return wanted;`
— the exact string the check at the top of the function already proved is in `used`.

Trigger: needs 100 colliding names in `taken`, so this is close to unreachable in
practice. Recorded because it contradicts the module's own stated rule that
suffixing beats reusing, and because a silent duplicate makes every later
"stop jarvis one" ambiguous — the outcome that rule exists to prevent.

Fix: return `null` (or throw) past `n > 99` rather than handing back a duplicate.

---

## Investigated and dropped — not bugs

Recorded so the same ground is not re-covered.

- **Session chaining is unwired.** Reported independently by two agents; false.
  `chainAfter, takeChain, dropChainsExcept` are imported at `server.js:30`,
  `takeChain` is called at `:184` (deliberately before the `dropChainsExcept`
  race), and `dispatchChain()` at `:228` re-looks-up the workspace, honours the
  `stoppedAt` carve-out, re-checks the ceiling, and passes `depth: chain.depth + 1`.
  The only genuine gap is the depth cap — see `incomplete.md`.
- **`startListening` drops the clip's state handoff.** Deliberate, with a comment
  at `public/app.js:571-576` explaining that applying it would flash the orb
  through `"working"` and tear down the build HUD immediately. The cancel button
  is where a handoff is honoured.
- **`deliverQueued`'s unhandled rejection.** It is called without `.catch()` at
  `server.js:106`, unlike the `reportComplete` call right below it — but
  `tellSession` is documented and implemented as never rejecting
  (`lib/spawn-session.js:277`) and `saveStore` swallows its own errors
  (`lib/memory.js:120-133`), so there is no reachable rejection.
- **`MAX_NAME_WORDS`, `DEFAULT_CONFIG_PATH`, `PROGRESS_MAX` are dead exports.**
  False. Each is the default-parameter value for a function in its own file and
  is exported so callers and tests can override it.
