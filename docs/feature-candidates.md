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
fixed in `docs/roadmap.md`).

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
**What.** When `hooks/dante-approve.mjs` gives up waiting and hands the prompt back to the
terminal, record the expiry and show a marker on the session's row.
**Why.** Approvals do not silently vanish today; the hook returns `null` and Claude Code falls
back to its own prompt. But nothing records that it happened, and that count is the best proxy
for whether Dante is actually in the loop. The Contrarian's catch constrains the shape: an
auto-approve edges toward `bypassPermissions`, an auto-deny breaks "no browser means no decision,
never a denial". So the fix is visibility, not a timer. Score 9. Channel 0. Size S.

### 5. Voice "what's blocked?"
**What.** One spoken query that answers, in one paragraph, which sessions need the owner right
now, which finished, and which are still running, built from the event log via `lib/recall.js`.
**Why.** "Catch me up" replays history. Nothing answers the present-tense question that decides
what to do next. Without it the owner asks per session, which is the serial bottleneck again.
This is the one voice feature on the list that collapses several turns into one.
Score 8. Channel −. Size S to M.

---

## Soon

### 6. Most-recently-used roster order
**What.** Order the roster in `lib/agents.js` and the panel by last interaction rather than by
workspace or name.
**Why.** The session the owner just spoke to is the one they will speak to again. Alphabetical
order makes every glance a search. It is the one useful idea inside the rejected tmux request.
Score 8. Channel −. Size S.

### 7. Batch confirm
**What.** Extend `lib/confirm.js` and `lib/verdict.js` so several pending proposals can be
answered with a single "yes", each still read back in the proposal.
**Why.** With up to five sessions the confirmation cadence, not the feature set, may be the real
friction. Two peer reviewers flagged confirmation fatigue as the thing every advisor ignored.
Batching keeps the explicit gate and cuts the round trips. Score 8. Channel −. Size S.

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
**What.** "What do you know about X" searches `~/.config/dante/memory/` through `lib/notes.js`
and speaks the matching note's summary.
**Why.** Only the four most recently updated notes ride along with each turn. Anything older is
invisible unless the model happens to recall it. Retrieval already exists in the module; this is
mostly a wiring path. Score 7. Channel +. Size S to M.

### 11. Earcons
**What.** Short distinct sounds, through the existing audio pipeline in `lib/tts.js` and
`public/clip-stream.js`, for low-information events such as "build started" or "approval
needed", instead of a full sentence.
**Why.** Screen readers learned that a sentence per state change exhausts the listener. Dante
speaks everything. A sound carries the event, the sentence stays for events that carry content.
Score 7. Channel −. Size S.

### 15. Speech throttling while progress streams
**What.** In `lib/turns.js`, hold non-urgent recap speech while a build or session start is
streaming progress.
**Why.** Car assistants throttle how much they say while the driver is busy. Dante talks over
its own progress. Small polish with daily payoff. Score 6. Channel −. Size S.

### 18. State reasons in reports
**What.** Carry the roster's open-vocabulary state ("blocked on approval", "waiting for input")
into spoken reports and the panel.
**Why.** "Needs attention" is one bucket. Knowing which kind of attention decides whether it is
worth interrupting what the owner is doing. Score 6. Channel 0. Size S.

### 19. Queued follow-ups shown in the roster
**What.** When a tell is queued behind a busy session, show it on that session's row.
**Why.** A queued message is invisible until it lands, so the owner cannot tell whether the
follow-up was sent or forgotten. Score 6. Channel −. Size S.

---

## Measure first

These earn their place only if item 1 shows the pain exists.

### 12. Needs-attention re-ping
**What.** Pager-style escalation in `lib/notify.js`: re-speak an unacknowledged needs-attention
after a set silence, with a spoken "yes" counting as the acknowledgement.
**Why.** An announcement that plays once while the owner is away is lost. But it adds voice
traffic, and if expiries are near zero it solves nothing. Score 7. Channel +. Size S to M.

### 13. Interview memoisation per workspace
**What.** Remember the where and constraints answers given for a repository and skip those
questions when the next interview targets the same one.
**Why.** The interview asks one question per turn until confident; repeated briefs in one
repository repeat the same answers. Worth it only if interviews repeat their shape, which the
counters will show. Score 7. Channel −. Size M.

### 14. STT confirm and correct before dispatch
**What.** Read back the transcript of a session command or interview answer and wait for a
"yes" before dispatching, reusing the propose-then-act pattern in `lib/confirm.js`.
**Why.** First Principles named this the most load-bearing unverified assumption in the system.
It is also the highest channel cost on the list, two extra cycles per command. If the correction
counter runs high, this becomes SHIP-NEXT. If it runs low, this is ceremony. Score 7.
Channel ++. Size M.

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
**What.** On page open after a long absence, offer (not auto-speak) a one-line digest from the
event log.
**Why.** "Catch me up" is pull-based; the owner has to remember to ask. An offer costs one
line. Score 6. Channel +. Size S to M.

### 20. Cost and token query
**What.** "What has this session cost" surfaces the usage fields `claude agents --json` already
returns.
**Why.** Cheap to wire, but nothing on the roadmap depends on it and the subscription makes cost
a curiosity rather than a decision. Score 5. Channel +. Size S.

### 21. More session kinds
**What.** Grow the session-kind registry under `lib/registry.js`.
**Why.** Contained and low risk. Its only failure mode is configuration sprawl. Nothing waits on
it. Score 5. Channel 0. Size S.

### 23. Diff-of-intent tree for the plan step
**What.** Before a multi-step build starts, render its plan as a tree in `public/build-hud.js`,
the way the IDE assistants preview before applying.
**Why.** The plan is Dante's own output, so showing it breaks no read-only rule. But builds are
now the secondary use, and the HUD already shows the steps as they run. Score 5. Channel 0.
Size M.

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
**Why not.** Each is listed under "deliberately not on this roadmap" in `docs/roadmap.md`. The
council raised none of them as worth relitigating. Wake word in particular removes the explicit
gate that makes voice-triggered session control safe. Score 1.
