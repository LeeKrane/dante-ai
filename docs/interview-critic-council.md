# Council verdict: a critic step in the interview

Question put to the council on 2026-09-02: should Dante add a trimmed, council-like critic step to
the session interview to improve the quality of the brief a session receives, and if so in what
shape? Five advisors with distinct reasoning methods, five anonymous peer reviews, a devil's
advocate against the emerging consensus, one chairman. The devil's advocate's three code claims
and the chairman's claim about the unlogged escape phrase were verified against the repository.

## Verdict: add one cold ambiguity critic

### Where the council agrees

All five advisors reject the literal proposal of two or three parallel cold `claude -p` critics
gating the proposal. Parallel critics mean seconds of startup; each is a new metered call and a
new untrusted re-entry point that must re-derive the `clean` and `UNPRINTABLE` discipline in
`lib/interview.js`; and a critic-authored question is a fifth facet in disguise that either
bypasses `readyToPropose` or forks a state machine three files must agree on. All five also
agree that no shape may add a spoken turn by default, because the voice channel is the scarce
resource.

### Where the council clashes

- **Error catch.** The Executor and First Principles, against the Expansionist: same-model
  self-critique is weak precisely at this failure mode, because the model already believes its
  reading of an ambiguous utterance. Folding a self-critique into the warm turn is the shape
  that cannot catch what needs catching.
- **Error catch.** Two reviewers, against the Expansionist: cold `claude -p` startup takes
  seconds and the read-back playback window is seconds. A critic run during playback rarely
  lands and fails silently.
- **Value tension.** The Outsider and Contrarian versus the Executor and First Principles:
  whether "not measured" means do not act, or act cheaply and instrument alongside. Same words,
  different premise.
- **Error catch.** First Principles, against the framing: "a critic can supply what only the
  user knows" is self-contradictory. A model with only the transcript can flag ambiguity, never
  supply a missing fact.

### Blind spots the peer review revealed

1. **Priming.** Three of five reviewers judged the advisors' unanimous "measure first" to be
   conformity to the framing, which had pre-stated that nothing is measured and the voice
   channel is scarce. No advisor argued what to measure or that measurement need not block
   action.
2. **"Bad brief" was never operationalised.** Regret, stall, or downstream failure? Without a
   definition, "measure first" is uncheckable.
3. **Nobody compared any shape against the read-back baseline**, and the reviewers who assumed
   the read-back is already a review were wrong (see the devil's advocate).
4. **Escape-phrase fatigue exists today** as a signal nobody proposed reading.
5. **A screen-only critic is invisible to a voice user** holding a phone.
6. **STT error at capture, not an elicitation gap,** may be the real defect. A critic reading a
   mis-transcribed word inherits it.

### Mediating assessments

Scored before the verdict. S is silence added to a voice turn. I is independence from the
model's own reading. A is whether the shape covers the asymmetry that a wrong brief costs about
twenty supervised minutes and nothing downstream catches it. C is size and coupling to the
three-way agreement between `docs/interview.md`, `FACETS` and the persona. E is whether the
shape's effect is observable today.

| Shape | S | I | A | C | E |
|---|---|---|---|---|---|
| 1. No change, instrument only | best | none | none | trivial | best |
| 2. Self-critique inside the warm turn | best | none (same context) | none | S | worst: indistinguishable from working |
| 3. One cold critic at interview start, discarded if late | best | high | high | M, `FACETS` untouched | good: discard rate is measurable |
| 4. Critic during read-back playback | good | high | low: window too short | M | poor: silent misses |
| 5. Serial extra Haiku turns | worst, +0.8 s each | none | none | S | good |
| 6. Two or three parallel cold critics | worst | high | high | L: fan-out, cancel, triple sanitising | poor |
| 7. Critic output as a spoken question | worst, a full turn | high | high | L: forks the state machine | good |

Only shape 3 scores well on silence, independence and the asymmetry together.

### The devil's advocate, and the council's answer

Its strongest point: the "a review already exists" pillar is false, and the code says so.

1. **The read-back is transmission, not adequacy.** Conceded, verified. `readBack` runs
   `parseBrief` over the brief that `composeBrief` built from the same model tags, then caps each
   clause. It cannot disagree with itself. A misreading reads back fluently and the user says
   yes.
2. **No downstream layer can ask about ambiguous intent.** Conceded, verified. The header of
   `lib/approval.js` says a headless session hitting a prompt with nobody at the terminal just
   stops, and the hook is scoped to writes outside the repository and publishing operations.
3. **Self-critique is already shipped.** Conceded. `readBack` already emits per-facet
   assumptions such as "nothing was said about constraints, so I would take it there are none",
   and the persona already orders assumptions to be stated. Shape 2 is close to a no-op.
4. **Escape phrases are unlogged.** Conceded, verified. The `markProceed` call in `server.js`
   has no log line, unlike the expiry and hold paths beside it.
5. **A critic launched at interview start costs zero silence.** Partially conceded. Zero
   silence, but not free: one metered cold call per start, a new untrusted re-entry point, and
   it reads the transcript before the answers exist, so it critiques the least-informed version.

The key point stands. The verdict moves off the majority.

### Recommendation: shape 3, one critic, advisory only

- **Launch.** In `server.js`, on the first interview tag for a start in a conversation. Once per
  interview, never on a tell or interrupt, never per turn. Spawn through `runCli` in
  `lib/run-cli.js` with a timeout of about twenty seconds, so no new dependency and the existing
  drain and kill discipline apply.
- **Prompt.** One perspective only: "Here is what was said. Name at most one thing in it that has
  two readings a session could act on differently, and that only the speaker can settle. If
  there is none, say NONE." Not "what will the session get wrong", which is a prediction about
  the session that the interview doctrine forbids asking about, and not "what is missing", which
  the facet loop already owns.
- **What it may change.** Nothing directly. Its finding must attach to one of the four existing
  facets or be discarded. `FACETS`, `readyToPropose`, `unconfirmedFacets` and `holdForReadBack`
  stay untouched. A new pure function `criticNote(state, text)` sanitises it and
  `interviewBlock` renders at most one advisory line. The model then either folds it into the
  next read-back as a stated assumption, which gets its yes in a turn already being spoken, or
  spends its one question on it. The existing "do not pad" rule governs that choice.
- **Sanitising and cap.** Reuse `clean`: strip unprintables, collapse whitespace, drop double
  quotes and square brackets, cap at 200 characters, one line, no bullets. Untrusted text,
  treated like memory.
- **Timeout.** Discard silently. Also discard if `matches()` fails, if the interview was cleared,
  or if the state is already proceed.
- **Files.** `lib/interview.js` (the pure `criticNote` plus one line in `interviewBlock`),
  `server.js` (wiring only), `docs/interview.md` (a new section), the INTERVIEW paragraph in
  `lib/brain.js` (one sentence), `test/interview.test.js`, `test/brain.test.js`.
- **Tests pin.** Sanitisation of quotes, brackets, unprintables and the cap; attach-or-discard
  by facet; `interviewBlock` renders the line and omits it when absent, stale or proceed;
  discard on a non-matching repository; and `readyToPropose` unchanged with a critic note
  present.

### What you lose

One metered cold call per session start. The single-warm-process purity. A new untrusted
re-entry point that must stay sanitised forever. The risk the model turns an advisory line into a
padding question. And the clean story of having measured before building.

### Do this first

Add the missing log line beside the `markProceed` call in `server.js`, in the same commit. That
is the escape-phrase rate, the one signal that tells you whether this shape backfires.

**How to verify**

1. **Base rate.** Independent-reading critics on ambiguous human utterances hit rarely. Over
   twenty starts, if fewer than about one in five produce a finding the user actually corrects,
   the critic is not paying for its call. Delete it.
2. **Early warning.** Escape-phrase rate and questions per interview, before versus after. If
   "just start it" climbs, the Contrarian's predicted failure has arrived. Revert.
3. **Window check.** The discard-at-`readyToPropose` rate. Above about half, the launch point is
   wrong, not the idea.

## Relation to the feature candidates list

`docs/feature-candidates.md` item 14 (STT confirm and correct before dispatch) was tagged
MEASURE-FIRST because it adds two speak-and-listen cycles per command. The critic recommended
here is a different thing: it adds no spoken turn, runs once per start, and attaches to a facet
already being read back. The council's usage-counter recommendation (cut from that file on
2026-09-05, still in git history) and the log line above are the same instrumentation.
