# The interview: when Dante stops asking

A one-line spoken request is rarely a brief a session can work from. Before Dante
starts, tells or interrupts a session, it checks the request against four things a
good brief needs, and asks about whichever of them the request leaves open. This
document is the rule for when that stops. `lib/interview.js`, the INTERVIEW
paragraph in `lib/brain.js`'s persona, and this page all describe the same rule;
change one, change all three.

## Why there is no question count

An earlier version of this capped the interview at four questions and told Dante
to stop once it hit the cap, whether or not the brief was actually usable. That
protects against an interview that never ends, but it does it by guessing at a
number rather than by checking anything real: four is sometimes one question too
many, for a request that only needed the repo confirmed, and sometimes three
questions too few, for one with real constraints Dante has no way to guess.

What actually needs bounding is the runaway case — a broken turn that keeps
asking forever — and that is bounded some other way now: a ten-minute TTL ends a
stale interview outright, and a handful of escape phrases (below) let Jesse end
one early regardless of how much is still open. Once those are in place, the
count itself has no job left to do. It is still tracked (`asked`, logged and
reported in the machine-state line) because a number is useful context, but
nothing reads it to decide when to stop.

## The four facets

A brief is trustworthy once these four are settled. `FACETS` in `lib/interview.js`
is this list, verbatim and in this order:

| Facet | What it means | A typical question | Counts as covered when |
|---|---|---|---|
| `goal` | What the session should actually do | "What do you want it to do, exactly?" | The request states it, or Jesse's answer does |
| `where` | Which repository, and where within it | "Which repo — jarvis?" | A repo alias is known, always — see below |
| `constraints` | What must not be touched or changed, any approach rules | "Anything that shouldn't be touched?" | Answered, implied by the request, or reasonably assumed and stated as an assumption |
| `done` | How anyone would check the work is finished | "What does done look like here?" | Answered, implied, or assumed and stated |

`where` is a special case: a known repo answers it on its own. Once Dante knows
which repository it is working in, `where` is covered whether or not anyone said
the word — asking "and which repo is this in?" a second time after the repo has
already been named is exactly the kind of question this rule exists to prevent.

Nothing else is a facet. "Special" requirements — the order to do things in, a
style preference, someone to check with before touching a file — are not tracked
as a fifth thing, because most requests don't have one. When a request does carry
one, it goes in the brief's `Also:` section (below) without needing its own
covered/open bookkeeping.

## The confidence test

An interview is done — Dante should stop asking and propose — when both of
these hold:

1. **Every one of the four facets is settled.** Settled means covered by an
   answer, by the request itself (a request that already says "in jarvis" needs
   no question about where), or by an assumption Dante is willing to state
   outright in the brief.
2. **No answer left something genuinely open.** A facet can look covered and
   still have a loose thread — an answer that raises a new question ("just the
   builder test — actually, check the other one too if you have time") is not
   fully settled just because the facet was touched.

Both, together — four ticked boxes with an unresolved thread is not confidence, and neither is an unticked box excused because nothing about it seems urgent.

**Never ask:**
- What the request already told you.
- What the session can find out for itself once it starts — file names, which
  test is currently failing, what a directory contains. Interviewing is for
  what only Jesse knows; the rest is the session's own job.
- For confirmation of something you could just state as an assumption in the
  brief instead. "I'll assume you mean the builder test, since that's the one
  that's flaky" costs nothing and can be corrected after the fact; a question
  costs a whole turn.

**Skip the interview entirely** when the request is already specific or small
enough to brief in one line ("run npm test in jarvis" needs no interview — goal,
where and done are all stated, and there's nothing to constrain), or the moment
Jesse says to just go, or to stop asking.

## How the machine enforces it

The model does the reasoning; the state in `lib/interview.js` is what keeps that
reasoning honest across turns and across a possible restart.

- **`have=`.** Every interview question is tagged
  `[ACTION:SESSION verb=interview for=<start|tell|interrupt> repo=<alias>
  have=<facets> note="..."]`. `have` is Dante's own claim about which facets it
  is now sure of — a comma-separated list drawn from `goal`, `where`,
  `constraints`, `done`, written with no spaces (`have=goal,constraints`) or, if
  spaces are wanted, in double quotes (`have="goal, constraints"`), because the
  tag parser reads an unquoted value only up to the first space. A tag that omits
  `have` continues the previous turn's coverage (silence means "nothing changed,"
  not "start over"); a tag with `have=` present but empty resets it to nothing
  covered (bar `where`, when a repo is known).
- **The INTERVIEW machine-state line.** `interviewBlock` folds the state into
  one line at the top of Dante's next turn — what's being planned, how many
  questions have been asked, which facets are covered, which are still open, the
  notes learned so far, and (see below) what Jesse actually said. This is the
  thing the model reads instead of trusting its own memory of the conversation,
  because the model's context can be lost and this state survives that.
- **The escape phrases.** `wantsToProceed` recognises a short vocabulary — "just
  start it," "go ahead," "that's enough," "stop asking," "stop the questions,"
  "you know enough," and a few more — read from a short utterance so a long
  sentence that happens to contain one of them ("well I don't think we should
  just go ahead with that yet") isn't misread as one. A negation ("don't,"
  "wait," a bare "stop") always wins over the phrase it might otherwise contain,
  except that "stop" immediately followed by "asking," "the questions" or "with
  the questions" is read as the escape phrase it's part of, not as its own
  refusal.
- **The ten-minute TTL.** An interview nobody has touched in ten minutes is
  stale — the person likely moved on — and is dropped rather than resumed, the
  same way a two-minute-old proposal in `lib/confirm.js` is.
- **What a brain restart does, and why `said` exists.** The warm CLI session
  that holds an interview's back-and-forth can be restarted from cold mid-way
  through (`askResilient` in `lib/brain.js`), and its own memory of the
  conversation goes with it. The interview state does not: `notes` (the model's
  own summaries) and `said` (what Jesse said, verbatim, on every turn) both live
  outside that session, so a restart loses nothing. `said` exists specifically
  because a note is a summary and can drop a detail without meaning to — `said`
  is the one copy that can't.

## The brief

Once confident, Dante proposes with the ordinary start, tell or interrupt tag,
carrying `task="..."` (one short line, spoken aloud) and `brief="..."` — a
structured document, written for the session, not for the ear. Line breaks
inside the quotes are fine; `lib/action.js`'s tag parser already allows them, and
they're what give the brief its sections.

Shape:

```
Goal: <what the session should do>
Where: <repo, and the area within it>
Constraints:
- <what must not be touched or changed>
- <any approach rules>
Done when:
- <how anyone would check it's finished>
Also:
- <special requirements -- order of work, style, who to ask -- only if any exist>
```

A real one, from an interview about a flaky test:

```
Goal: fix the flaky builder test
Where: jarvis, test/builder.test.js
Constraints:
- do not touch lib/builder.js itself, only the test
- keep using the existing writeFake fixture, don't add a new one
Done when:
- npm test passes twice in a row
Also:
- Jesse wants to know which assertion was racing, in the summary
```

**Zero-loss.** The brief carries every detail from the interview, in Jesse's own
words, nothing summarised away and nothing invented. An assumption Dante made
gets stated as an assumption rather than folded in silently. Longer interviews
produce longer briefs; the target is completeness, not brevity — though a brief
for a one-line request stays exactly that short.

**The cap.** `MAX_BRIEF_CHARS` in `lib/interview.js` is 6000 — big enough that no
real interview gets near it, a backstop rather than a design target, same as
`MAX_NOTES` and `MAX_SAID`.

**No quotes or brackets.** The brief is a value inside the tag's own double
quotes; a double quote or a square bracket inside it would break the tag that
carries it, so neither is ever allowed to appear.

**On screen.** While the yes is awaited the brief is shown centred over the orb, above the sessions and diagnostics panels if they overlap it, and never over the hold-to-talk button — the button is how the yes gets said, so nothing is allowed in front of it.

**The fallback.** If an interview proceeds without the model ever writing a
`brief="..."` — Jesse said "just start it" before a brief was ever drafted, say
— `composeBrief` in `lib/interview.js` builds one instead, out of the raw state:
a `Goal:` line from the task, a `Where:` line from the repo, the interview's
notes as dash bullets under "What the interview established:", and what Jesse
said, verbatim, as dash bullets under "Jesse said, in order:". It can't tell a
constraint from an acceptance criterion — it has no idea which note was which —
so rather than guess at sections it can't support, it keeps everything instead.
The one place it can still lose something is the 6000-character cap, and no real interview gets near it — a runaway that does is cut, not padded.

## Keeping it consistent

Three places have to agree, and none of them import from another:

- **This document** — the rule, in prose, for a person reading it.
- **`FACETS` in `lib/interview.js`** — the same four names, in the same order,
  as actual code.
- **The INTERVIEW paragraph in `lib/brain.js`'s persona** — the same rule, in
  prose, for the model reading it every turn.

Change one, change all three. `test/brain.test.js` pins phrases from the persona
paragraph (`have=`, "no question limit," "confident," "Done when:," "machine-state
lines"); `test/interview.test.js` pins the pure functions' exact behaviour
(`noteInterview`, `interviewBlock`, `wantsToProceed`, `cleanBrief`,
`composeBrief`). A change that drifts from this document without updating those
two files is a change `npm test` will not catch — read this page again before
touching any of the three.
