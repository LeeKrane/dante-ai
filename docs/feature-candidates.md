# Feature candidates

The ten candidates from the council review of 2026-09-02 that the owner is willing to
consider, each checked against main at 73d2c40 on 2026-09-05 (line numbers in this file are
from that commit; the plans under `docs/roadmap/` carry current ones). The other twenty-six
entries the
council scored were cut from this file on 2026-09-05: instrumentation, the ambient status strip
and diff-stat, the transcript overlay, the action log, the rejected and conflicting items, then
13 (interview memoisation), 14 (STT confirm, already implemented), 15 (speech throttling, decided
against in code), 7 (batch confirm, one proposal slot means nothing to batch) and 23
(diff-of-intent tree, builder path only). All remain in git history at commit 51cdbba.
Numbers are the council's original numbers, kept so
the plan file and the two council documents still line up.

Each entry says what the feature is, why it earned its place, what would change in the code, and
what main already has. The score is the chairman's calibrated usefulness out of ten. "Channel"
is the effect on the single push-to-talk voice channel: `+` adds speak-and-listen cycles, `−`
removes them, `0` is neutral.

The verdict that orders this list: **instrument before adding voice ceremony.** Nothing about
daily use is measured yet. The council's first recommendation, local usage counters in the
event log and diagnostics panel, is not on this list because the owner did not shortlist it, but
several entries below say they wait on those counters.

Verdict tags: SHIP-NEXT, SOON, LATER, MEASURE-FIRST. Implementation plans, one per entry, live in
`docs/roadmap/`.

---

## Ship next

### 4. Expired approvals surfaced, never decided
**What.** When an approval window closes unanswered, keep a visible marker on that session's row in
the roster panel and count the expiry in the diagnostics counters.
**Why.** The expiry count is the best proxy for whether Dante is in the loop at all, and it feeds
the usage counters the council asked for first. The Contrarian's catch fixes the shape:
auto-approve edges toward `bypassPermissions`, auto-deny breaks "no browser means no decision,
never a denial". So visibility, never a timer.
**What would change.** `rosterForClient` in `server.js` carries an "approval expired" flag per
session, `public/roster-panel.js` renders it, and the counter lands in the event log.
**On main.** Partial. A timeout already logs "approval timed out", records a needs-attention event
and speaks it once (`server.js:568-575`); the hook returns `null` so the session falls back to its
own prompt. The roster panel has no marker and nothing counts expiries.
Score 9. Channel 0. Size S.

### 5. Voice "what's blocked?"
**What.** One spoken query answered in one paragraph: which sessions need the owner now, which
finished, which are still running.
**Why.** "Catch me up" replays past events and clears them. Nothing answers the present-tense
question that decides what to do next, so the owner asks per session, which is the serial
bottleneck again. The one voice feature on the list that collapses several turns into one.
**What would change.** Either one persona sentence telling the model to summarise the roster block
on request, or a machine-built line from `describeRoster` in `lib/agents.js` returned without a
model turn.
**On main.** Partial. Every prompt already carries the numbered roster line with working, blocked,
idle or done per session (`lib/agents.js:323-345`, folded in by `lib/turns.js:113`), so the model
can answer conversationally. There is no dedicated verb, and `recap` is history only
(`server.js:1924-1933`). Score 8. Channel −. Size S.

---

## Soon

### 10. Notes query by voice
**What.** "What do you know about X" looks a topic up across the whole notes store under
`~/.config/dante/memory/` and speaks the match.
**Why.** Only two notes ride along with each turn now, biased toward the session being discussed.
Older notes are invisible unless the model happens to recall them. Retrieval already exists in
the module; this is a verb and a wiring path.
**What would change.** A new unconfirmed verb in `lib/action.js`; `server.js` passes the spoken
topic as the `hint` to `pickNotes` in `lib/notes.js`; the result is spoken through the ordinary
turn.
**On main.** Partial. `pickNotes` (`lib/notes.js:1210`) orders notes by a topic and session-name
hint and `foldNotes` runs every turn with `MAX_CONTEXT_NOTES = 2`, but the hint is the current
session's topic key, not a spoken keyword. No verb searches notes by free text.
Score 7. Channel +. Size S to M.

### 11. Earcons
**What.** Short distinct sounds for low-information events such as "build started" or "approval
needed", instead of a full sentence.
**Why.** Screen readers learned that a sentence per state change exhausts the listener. Dante
speaks everything. A sound carries the event; the sentence stays for events that carry content.
**What would change.** A few generated tones (Web Audio oscillator in `public/`, no asset files,
so no bundler question) and a per-event choice of tone versus sentence in `lib/notify.js`.
**On main.** Absent. The only audio element is the TTS clip player (`public/index.html:590`); no
tone, chime or sound file exists anywhere. Score 7. Channel −. Size S.

### 18. State reasons in reports
**What.** Carry the reason behind "blocked" or "needs attention" (which approval, what it waits
for) onto the session record so the panel and spoken reports show it.
**Why.** "Needs attention" is one bucket. Which kind of attention decides whether it is worth
interrupting what the owner is doing.
**What would change.** `rosterForClient` in `server.js` gains a reason field set from the approval
scope or the notify detail; `public/roster-panel.js` renders it under the state word;
`describeRoster` appends it to the spoken line.
**On main.** Absent. The state word is already an open vocabulary from the CLI
(`lib/agents.js:80`), but the roster ships only state and status (`server.js:639-653`). The
actual reason, such as "wants to push to the remote", lives only in the spoken needs-attention
line. Score 6. Channel 0. Size S.

### 19. Queued follow-ups shown in the roster
**What.** When a tell or interrupt is queued behind a busy session, show it on that session's row.
**Why.** A queued message is invisible until it lands, so the owner cannot tell whether the
follow-up was sent or forgotten.
**What would change.** `rosterForClient` includes the queue length or the first queued line from
`peekQueued` in `lib/memory.js`; the panel renders a "1 queued" tag.
**On main.** Partial. The queue exists (`queueForSession`, `peekQueued`, `takeQueued` in
`lib/memory.js:706-776`), is gated on `isWorking` (`server.js:1692`) and is spoken as "I will
pass it on when it stops". Nothing about it reaches the panel. Score 6. Channel −. Size S.

---

## Measure first

These earn their place only if the usage counters show the pain exists.

### 12. Needs-attention re-ping
**What.** Re-speak an unacknowledged needs-attention after a set silence; a spoken "yes" or any
turn addressed to that session counts as the acknowledgement.
**Why.** An announcement that plays once while the owner is away is lost. But it adds voice
traffic, and if expiries are near zero it solves nothing.
**What would change.** A timer keyed on the dedupe entry in `reportAttention`
(`server.js:477-501`) that re-announces unless the session resumed or the owner addressed it;
`resumedAmong` in `lib/watch.js` already clears the entry on resume.
**On main.** Absent. A needs-attention is spoken exactly once per session and detail; it repeats
only if the session resumes and blocks again. Score 7. Channel +. Size S to M.

---

## Later

### 17. "Good morning" briefing
**What.** On page open after a long absence, offer, not auto-speak, a one-line digest of what
finished and what is waiting.
**Why.** "Catch me up" is pull-based; the owner has to remember to ask. An offer costs one line.
**What would change.** On WebSocket connect in `server.js`, compare the last-seen stamp with now
and, past a threshold, send one on-screen line built from `describeFinished` in `lib/recall.js`
plus the pending needs-attention entries.
**On main.** Absent. Connect sends only the roster and workspace lists (`server.js:2364-2404`);
`describeFinished` is folded silently into each turn's machine-state block, never offered.
Score 6. Channel +. Size S to M.

### 20. Cost and token query
**What.** "What has this session cost" answers from usage fields on the session record.
**Why.** Cheap to wire if the CLI exposes the numbers; nothing else depends on it and the
subscription makes cost a curiosity rather than a decision.
**What would change.** `lib/agents.js` parses usage fields from `claude agents --json` if present,
the roster carries them, and a spoken query reads them. First check that the listing exposes
them at all.
**On main.** Absent. The listing is parsed only for name, state, status, pid, start time, cwd and
kind; the only "cost" mentions in `server.js` concern the CLI's own `/cost` command leaking
through a peer frame. Score 5. Channel +. Size S.

### 21. More session kinds
**What.** Add kinds under `sessions/*.mjs`.
**Why.** Contained and low risk. Its only failure mode is configuration sprawl.
**What would change.** One file per kind, copied from `sessions/_template.mjs`;
`loadSessionKinds` in `lib/sessions.js` picks it up. The earlier version of this entry named
`lib/registry.js`, which holds build primitives, not session kinds.
**On main.** Partial. Three kinds ship: `review`, `tests` and `brainstorm` (merged after this
entry was first checked). Score 5. Channel 0. Size S.

