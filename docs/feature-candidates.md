# Feature candidates

Thirty-six candidate features and extensions for Dante, collected from a council review on
2026-09-02 (five advisors with distinct reasoning methods, anonymous peer review, a devil's
advocate against the consensus, and a chairman synthesis). Each entry says what the feature is
and why it earned, or lost, its place. The score is the chairman's calibrated usefulness out of
ten, not an average. "Channel" is the effect on the single push-to-talk voice channel: `+` adds
speak-and-listen cycles, `−` removes them, `0` is neutral.

The verdict that orders this list: **instrument before adding voice ceremony.** Nothing about
daily use is measured yet, so the first item creates the evidence the rest are judged against,
and the next four reduce voice traffic rather than add to it.

Verdict tags: SHIP-NEXT, SOON, LATER, MEASURE-FIRST, REJECT, CONFLICTS (with a decision already
fixed in `README.md` or in the roadmap that main deleted in commit 4724861).

On 2026-09-05 fifteen entries (4, 5, 7, 10 to 15, 17 to 21, 23) were rewritten with a "what would
change" line and checked against main at 73d2c40; each carries an "On main" status. Item 14 turned
out to be implemented and item 15 was decided against in code.

---

## Ship next

### 1. Local usage counters
**What.** A counter block in the restart-surviving event log (`lib/notify.js`), rendered in the
diagnostics panel: STT re-records and corrections per day, approvals proposed versus answered
versus expired at the hook, and mean seconds from a proposal being spoken to the "yes" arriving.
**Why.** Every other item on this list rests on an unmeasured assumption about how reliable voice
is and how much confirmation the owner tolerates. The council could not tell whether Dante's
constraint is trust or throughput, and neither can anyone else until these numbers exist. Pure
functions, no dependencies, one to two days, and it decides the fate of items 12 to 14.
Score 10. Channel 0. Size S.

### 2. Persistent session status strip
**What.** A small always-visible strip of session states (running, waiting, blocked, finished)
in `public/roster-panel.js`, independent of the key that opens the full sessions panel, fed by
the roster polling that already runs.
**Why.** Push-to-talk is a single mutex over every session on the machine. Beyond two concurrent
sessions, asking "what is running" by voice serializes the day. Glanceable state answers the
question without spending a turn, and it renders data Dante already has, so it adds no security
surface. Score 9. Channel −. Size S to M.

### 3. Session diff-stat, rendered not spoken
**What.** On session completion, read `git diff --stat` of the session's repository (paths and
line counts only, never file bodies) and show it next to the session's row in the roster panel.
**Why.** Four of five advisors independently named "a session finished and I do not know what it
did" as the biggest trust gap. Three of them wanted it spoken. The devil's advocate showed that
eleven seconds of paths read aloud while another session's approval window drains is how Dante
becomes ceremonial. Producing the diff-stat is the value; speaking it is the cost. Render it.
Needs one ruling from the owner first: is a no-content diff-stat "code output" under the
voice-only decision, or session state like the build HUD tree? The council reads it as state.
Score 9. Channel 0. Size M.

### 4. Expired approvals surfaced, never decided
**What.** When an approval window closes unanswered, keep a visible marker on that session's row in
the roster panel and count the expiry in the diagnostics counters.
**Why.** The expiry count is the best proxy for whether Dante is in the loop at all, and it feeds
item 1. The Contrarian's catch fixes the shape: auto-approve edges toward `bypassPermissions`,
auto-deny breaks "no browser means no decision, never a denial". So visibility, never a timer.
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

### 6. Most-recently-used roster order
**What.** Order the roster in `lib/agents.js` and the panel by last interaction rather than by
workspace or name.
**Why.** The session the owner just spoke to is the one they will speak to again. Alphabetical
order makes every glance a search. It is the one useful idea inside the rejected tmux request.
Score 8. Channel −. Size S.

### 7. Batch confirm
**What.** Let several proposals be pending at once and answer them with one "yes", each named in
the read-back.
**Why.** With up to five sessions the confirmation cadence, not the feature set, may be the real
friction; two peer reviewers flagged confirmation fatigue as the thing every advisor ignored.
Batching keeps the explicit gate and cuts the round trips.
**What would change.** `conv.proposal` becomes a list; `answerProposal` in `server.js` runs every
entry on a yes and clears all on a no; `lib/verdict.js` names each entry in the spoken line.
**On main.** Absent. `conv.proposal` is a single object (`server.js:781`); a second request
overwrites the first, so a "yes" can only ever answer the newest ask. Score 8. Channel −. Size S.

### 8. Live "what it heard" overlay
**What.** Show the raw transcript on screen as it arrives and before it is dispatched, display
only, no extra confirmation turn.
**Why.** The transcription boundary is where a misheard repository name becomes a wrong session
brief, and nothing marks it. Showing the text costs no voice traffic and lets the owner catch a
mishear with the cancel button that already exists. Mind the security note: transcripts can
contain repository paths, so this is a panel, not a persisted log. Score 8. Channel 0. Size S.

### 9. Browsable action log panel
**What.** Expose the event log that backs "catch me up" as a scrollable panel.
**Why.** "What did it do" currently has one answer, spoken, and speaking it clears the log. A
visible log answers the same question repeatedly for free. Peer review warned this can become
permission amnesia, so it shows what was sent and verified, not what was approved and why.
Score 7. Channel −. Size M.

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

### 15. Speech throttling while progress streams
**What.** Hold non-urgent recap speech while a build or session start is streaming progress.
**Why.** Car assistants say less while the driver is busy. The council's premise was that Dante
talks over its own progress.
**What would change.** Add "working" to the busy states in `public/playback-policy.js` for
recap-class clips only, with a cap so a long build cannot hold an announcement for minutes.
**On main.** Absent, and decided against once. `BUSY_STATES` in `public/playback-policy.js:103`
leaves "working" out on purpose: a background build is not a conversation, and holding an
announcement until it lands would hold it for minutes. Progress lines go to the HUD, not to
speech, so the premise is weaker than the council assumed. Downgraded to LATER unless item 1
shows announcements colliding with progress. Score 4. Channel −. Size S.

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

These earn their place only if item 1 shows the pain exists.

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

### 13. Interview memoisation per workspace
**What.** Remember the where and constraints answers given for a repository and skip those facets
when the next interview targets the same one.
**Why.** Repeated briefs in one repository repeat the same answers. Worth it only if interviews
repeat their shape, which the counters will show.
**What would change.** A per-repository facet store beside the notes; `interview` in
`lib/interview.js` seeds `covered` from it, and the read-back states the reused answers so a
stale one still gets its yes. `docs/interview.md` and the persona paragraph change with it.
**On main.** Absent. Only a still-live interview within `INTERVIEW_TTL_MS` carries forward
(`lib/interview.js:194`); notes are not consulted and `[MEMORY:SET]` holds config keys, not
facets. Score 7. Channel −. Size M.

### 14. STT confirm and correct before dispatch
**What.** Read back what was heard and wait for a "yes" before any session command runs.
**Why.** First Principles named STT reliability the most load-bearing unverified assumption. Two
extra cycles per command is the highest channel cost on the list.
**What would change.** Little. The residual gap is the raw transcript of `read`, `recap` and
`unwatch`, which dispatch without a gate, and a misheard interview answer, which surfaces only
through the facet read-back. Item 8, the overlay, covers both at zero channel cost.
**On main.** Implemented for everything that acts. `CONFIRMED_VERBS` in `lib/confirm.js:47`
gates start, tell, interrupt, stop and watch behind a spoken yes, and the confirming phase reads
all four facets back once (`readBack`, `lib/interview.js:679`). Treat as done; keep item 8.
Score 7. Channel ++. Size M.

### 22. Readback on note and memory writes
**What.** One spoken confirmation the first time a session writes a note or a `[MEMORY:SET]`
preference lands.
**Why.** Air-traffic control reads back every clearance; Dante reads back session commands but
memory writes land silently. Low stakes, so it waits for evidence that silent writes surprise
the owner. Score 5. Channel +. Size S.

---

## Later

### 16. Local end-of-day handoff
**What.** A spoken summary of every session's terminal state, generated locally from the event
log, offered at the end of the day.
**Why.** This is the Slack pattern without the vendor, the credential, or the "did it land"
failure mode that got Slack removed. If item 4 shows approvals often expire while the owner is
away, this is the door that reopens, not a webhook. Score 6. Channel +. Size M.

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
**On main.** Partial. Two kinds ship, `review` and `tests`. A `brainstorm` kind exists on the
unmerged `worktree-brainstorm-kind` branch. Score 5. Channel 0. Size S.

### 23. Diff-of-intent tree for the plan step
**What.** Before a multi-step build starts, render its whole plan as a tree in the build HUD, the
way IDE assistants preview before applying.
**Why.** The plan is Dante's own output, so showing it breaks no read-only rule. But builds are
now the secondary use, and the HUD already draws the steps as they run.
**What would change.** A new wire message carrying the full step list before the first progress
line, and `public/progress-policy.js` seeding the tree from it instead of growing it per line.
**On main.** Absent. The wire carries only per-line `progress` messages (`server.js:2209`); the
HUD keeps a five-line window drawn as a tree as lines arrive (`public/progress-policy.js:103`).
Score 5. Channel 0. Size M.

### 24. Duration estimates from past runs
**What.** Predict how long a session will take from the durations of similar past sessions.
**Why.** Assumes the owner wants a prediction, which nobody has asked for, and past durations of
open-ended Claude sessions are a poor predictor. Score 4. Channel 0. Size M.

### 25. Weekly notes hygiene pass
**What.** A scheduled pass that merges and trims notes under the existing size caps.
**Why.** Pruning already runs on every write. This is operations, not daily value.
Score 4. Channel 0. Size S.

### 26. Peer-review chaining
**What.** A finished session automatically proposes a reviewer session for its own diff, through
`lib/peer.js` and `lib/spawn-session.js`, behind the usual spoken confirmation.
**Why.** Attractive, but it is a second spawn point, so the deny list has to be re-derived and
reviewed as carefully as `lib/builder.js`. The Executor's outside view puts it at ten to twelve
days and names it the item most likely to be half-built and abandoned mid security review, which
is worse than not starting. It also needs item 3 to be anything but noise. Score 4. Channel +.
Size L. Security review required.

### 27. Transcript index as a third store
**What.** A searchable local index of session transcripts for "catch me up" style questions.
**Why.** There are already two memory stores, and contradiction detection reconciles them. A
third means reconciling three. Notes already capture what a read produced. Score 3. Channel +.
Size M.

### 28. More voice-approval classes
**What.** Extend `lib/approval.js` beyond the two classes it answers by voice today.
**Why.** Every new class is a security review by house rule, and each one moves the line toward
general permission grants by voice. Wait for evidence that a specific class is asked for often.
Score 3. Channel +. Size M. Security review required.

---

## Rejected

### 29. First-run tour, cheat-sheet, glossary tooltips
**What.** Onboarding UI for a new user.
**Why not.** Dante has one user, who designed it. The Outsider proposed this from a first-time
perspective; two reviewers noted there is no evidence any of it is a friction point. Score 2.

### 30. Time-boxed "yes to this whole build"
**What.** A spoken, revocable, five-minute pre-authorisation of already-proposed actions in one
workspace.
**Why not.** It is not `bypassPermissions`, but it is the on-ramp: a bounded batch of approvals
becomes an unbounded one the first time the window feels too short. Approval fatigue is not yet
evidenced. Score 2. Security review required.

### 31. Auto-resolve stale approvals
**What.** Approve or deny an approval prompt automatically after a timeout.
**Why not.** Either direction is wrong. Auto-approve is bypass by another name; auto-deny breaks
the rule that no browser open means no decision, never a denial. Item 4 is the safe version.
Score 1.

### 32. Widen the roster to unnamed workspaces
**What.** Show and control every Claude session on the machine, not only those in named
repositories.
**Why not.** Stage 34 built the scoping fence after Dante stopped a session the owner never
created. Convenience is exactly what reversed it once. Score 2.

### 33. Multi-user or shared login
**What.** More than one Supabase account.
**Why not.** The entire approval and deny-layer design leans on "runs under the owner's login".
A second identity whose actions cannot be attributed empties that of meaning. Score 2.

---

## Conflicts with a fixed decision

### 34. Outbound webhook or push channel
**What.** Reinstate a push notification path to an external service.
**Why not.** Slack was built through Stage 32 and removed entirely: another credential, another
"did it land" failure mode, maintenance the owner voted against. The council notes that removing
Slack is not the same as deciding against async awareness forever; item 16 is the local answer.
Score 3.

### 35. Read diffs or symbols aloud
**What.** Speak code changes on completion.
**Why not.** Voice-only was decided precisely because code does not survive being read aloud. It
turns TTS into a review surface nobody asked for and slows the loop. Item 3 keeps the information
and drops the reading. Score 2.

### 36. Code panel, wake word, tmux, sub-builds, bypassPermissions by voice
**Why not.** Each was listed under "deliberately not on this roadmap" in the roadmap main has
since deleted; `bypassPermissions` by voice is still ruled out in `README.md`. The
council raised none of them as worth relitigating. Wake word in particular removes the explicit
gate that makes voice-triggered session control safe. Score 1.
