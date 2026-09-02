# The interview: when Dante stops asking, and how it confirms what it heard

A one-line spoken request is rarely a brief a session can work from. Before Dante
starts, tells or interrupts a session, two separate things happen. First, the
interview: it checks the request against four things a good brief needs, and asks
about whichever of them the request genuinely leaves open — a request that already
states all four gets no interview question at all. Second, confirming: once
interviewing is done, the machine — not the model — reads back what it understood
of all four facets in one question and waits for a yes, every single time, even
when the request left nothing open for the interview to ask about. This document is
the rule for both. `lib/interview.js`, the INTERVIEW paragraph in `lib/brain.js`'s
persona, and this page all describe the same rule; change one, change all three.

## Why there is no question count

An earlier version of this capped the interview at four questions and told Dante
to stop once it hit the cap, whether or not the brief was actually usable. That
protects against an interview that never ends, but it does it by guessing at a
number rather than by checking anything real: four is sometimes one question too
many, for a request that only needed the repo confirmed, and sometimes three
questions too few, for one with real constraints Dante has no way to guess.

What actually needs bounding is the runaway case — a broken turn that keeps
asking forever — and that is bounded some other way now: a ten-minute TTL ends a
stale interview outright, and a handful of escape phrases (below) let Krane end
one early regardless of how much is still open. Once those are in place, the
count itself has no job left to do. It is still tracked (`asked`, logged and
reported in the machine-state line) because a number is useful context, but
nothing reads it to decide when to stop.

## The four facets

A brief is trustworthy once these four are settled. `FACETS` in `lib/interview.js`
is this list, verbatim and in this order:

| Facet | What it means | A typical question | Counts as covered when |
|---|---|---|---|
| `goal` | What the session should actually do | "What do you want it to do, exactly?" | The request states it, or Krane's answer does |
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

Both, together — two ticked boxes with an unresolved thread is not confidence,
and neither is an unticked box excused because nothing about it seems urgent.

Checking Dante's reading of a settled facet against what Krane actually meant
is not part of this test any more — that used to be a third condition here
("every facet has been read back and confirmed"), and having the interview
itself own that check is exactly what let a read-back happen twice, once from
the model's own question and once from the machine's. It is still checked,
always, on every proposal — just not by the interview, and not until after
it's done. See "Confirming: once, by the machine," below.

**Never ask:**
- What the request already told you, as a question. Reading it back for a yes is
  not asking it again — see below.
- What the session can find out for itself once it starts — file names, which
  test is currently failing, what a directory contains. Interviewing is for
  what only Krane knows; the rest is the session's own job.
- A generic "did you mean what you said?". A confirmation question names a facet
  and states what Dante understood of it; a re-ask makes Krane say the same
  thing twice.

An assumption Dante can state still goes in the brief as an assumption rather
than becoming a question of its own — "I'll assume you mean the builder test,
since that's the one that's flaky" — and the read-back is where it gets its yes,
alongside everything else, rather than costing a turn by itself.

## Confirming: once, by the machine

An earlier version of this rule had the model do its own read-back, tagging the
facets it was reading back (`confirming=`) and the ones Krane had said yes to
(`confirmed=`), with the machine only picking up whatever the model's own
read-back left out. That is exactly how the same understanding ended up read
back to Krane twice in a row — once in a question the model wrote, once more
from the machine for the leftovers — or how a long, genuine "yes, that's
exactly right" got misread as a correction and sent the model back around to
propose (and get read back) a second time.

So now there is exactly one read-back, per proposal, and the machine — never
the model — is the one that speaks it. The moment Dante proposes a start, a
tell or an interrupt, `server.js` holds the tag instead of confirming it, and
speaks a single question covering all four facets at once, built by `readBack`
from the model's own brief. For a tell or an interrupt `where` is the session
the words are going to rather than a repository, and the read-back names it —
"I would tell fix-tests to run the linter as well". A yes to that read-back is
what turns the held tag into the ordinary "Shall I, sir?" proposal — the act is
still confirmed separately from the understanding behind it, exactly as
before, just by two different questions in sequence rather than one blurred
into the other.

**The loop-back.** A no, or anything longer than a yes, does not end there: it
withdraws the read-back and hands what Krane said back to the model as an
ordinary turn, with the machine-state line telling it plainly — this was a
correction to a read-back the machine spoke, not an answer to whatever the
model asked last. The model folds it in, asks about anything it left open (one
question, same as any other interview question), and otherwise proposes again
with the corrected task and brief — which gets read back once more, the same
way. A bare "no" gets one thing said before that turn starts: "What did I get
wrong, sir?"

There are two ways past the read-back itself, and both are deliberate:

- **Krane saying so.** The escape phrases ("just start it", "stop asking", and
  the rest) mark the interview `proceed`, and `readyToPropose` is live &&
  `proceed` and nothing else — so a tag that follows one skips the machine's
  read-back entirely and goes straight to the ordinary proposal, "Shall I,
  sir?". Escaping the interview this way escapes confirming as well as
  asking; the "Shall I, sir?" that follows is still Dante's only remaining
  chance to get it wrong out loud, and a no or a correction to it works the
  same as ever — but it is not the same read-back the other path speaks.
- **A skill.** A start or tell whose prompt is a skill (`command="/grilling the
  rollout plan"`, see the README) has no facets to read back: the command line
  is its goal, constraints and acceptance all at once, and the proposal already
  says that line back exactly — "Start a session in jarvis running /grilling the
  rollout plan. Shall I, sir?" A read-back in front of it would be the same
  question asked twice. If Dante is not sure which skill or which arguments, it
  interviews as usual first; the exemption is only for a tag that arrives with
  a vetted skill on it.

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
- **`confirming=` and `confirmed=`.** Two more facet lists, still parsed off a
  tag with the same tolerance `have=` gets — but the model no longer writes
  either one itself. `confirming` names the facets *this* question reads back
  for a yes; it describes one question, so it never carries forward — a tag
  that omits it is a question that reads nothing back. `confirmed` names the
  facets Krane has said yes to; it accumulates like `have` (omitted carries,
  present-but-empty resets). A facet in either list is necessarily covered, so
  both fold into `covered` the way a known repo folds into `where`. What still
  writes `confirming=` is the machine's own synthetic read-back tag (below),
  which also sets `spokenFor` — the mark that says this read-back was the
  machine's, not the model's, and the one thing a withdrawn read-back leaves
  behind for the model's next turn to notice.
- **Readiness.** `readyToPropose` is the check a start, tell or interrupt has to
  pass to skip the machine's read-back and go straight to proposing: the
  interview is live, and Krane said to proceed — nothing else. `confirmed=` and
  `confirming=` used to count here too, which was the seam a model-written
  partial read-back used to get through; now nothing a tag claims about
  confirming shortens the gate, only Krane's own words do.
- **The gate, and the machine's own read-back.** `server.js` refuses to propose a
  start, tell or interrupt that fails `readyToPropose` — which, now, is every one
  of them except an escape phrase or a skill — and holds it instead. It speaks a
  read-back that `readBack` composes from the model's own `brief` (falling back
  to the task, the repo, or the resolved session name), for all four facets at
  once, sets the page's activity label to `"confirming"`, and folds a synthetic
  interview tag into the state (`for=<verb>`, `confirming=<all four facets>`,
  marked `spokenFor`), keeping the held tag itself. For a tell or interrupt the
  session is resolved first, so a name nothing answers to is refused before it
  is ever read back. The answer to that read-back is read by the machine, with
  `readConfirmingAnswer` in `lib/confirm.js` rather than the proposal path's
  `readAnswer`: past its four-word cutoff it still reads a long, plain "yes" as
  a yes — "yes, that's exactly right" — because misreading a genuine yes as a
  correction here is what re-proposes the whole thing and gets it read back a
  second time, the very duplicate this replaced; anything past four words that
  isn't a clean yes, or that carries a correction word (`but`, `except`,
  `actually`, and the like), reads as a correction instead. A yes hands exactly
  the held tag on to the ordinary "Shall I, sir?" proposal, with the interview
  folded into its brief; a bare no withdraws the read-back (`withdrawConfirming`,
  activity back to `"interviewing"`) and asks what Dante got wrong; anything
  longer withdraws it the same way and is passed to the model as an ordinary
  turn, with the next machine-state line telling it plainly that its brief was
  just read back by the machine and corrected, so what follows is the
  correction, not an answer to whatever it asked last. The read-back is built
  from the brief rather than composed fresh so that what is checked is the
  reading the session would actually have received. A facet the brief says
  nothing about is asked as the assumption the silence amounts to ("nothing was
  said about constraints, so I would take it there are none") — still a question
  about that facet, never a generic re-ask.
- **The INTERVIEW machine-state line.** `interviewBlock` folds the state into
  one line at the top of Dante's next turn — what's being planned, how many
  questions have been asked, which facets are covered, which are still open, the
  notes learned so far, and (see below) what Krane actually said. This is the
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
- **Which session an interview is about.** An interview for a tell or an
  interrupt records the session's name (`name=` on the tag, or the name the
  machine resolved before its read-back), and a tag naming a different session
  does not match it — so a read-back about `fix-tests`, still waiting on its
  yes, cannot make an unrelated "tell build-ui to redeploy" ready to propose.
  The same rule already held for the repository on a start.
- **The ten-minute TTL.** An interview nobody has touched in ten minutes is
  stale — the person likely moved on — and is dropped rather than resumed, the
  same way a two-minute-old proposal in `lib/confirm.js` is.
- **What a brain restart does, and why `said` exists.** The warm CLI session
  that holds an interview's back-and-forth can be restarted from cold mid-way
  through (`askResilient` in `lib/brain.js`), and its own memory of the
  conversation goes with it. The interview state does not: `notes` (the model's
  own summaries) and `said` (what Krane said, verbatim, on every turn) both live
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
- Krane wants to know which assertion was racing, in the summary
```

**Zero-loss.** The brief carries every detail from the interview, in Krane's own
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
`brief="..."` — Krane said "just start it" before a brief was ever drafted, say
— `composeBrief` in `lib/interview.js` builds one instead, out of the raw state:
a `Goal:` line from the task, a `Where:` line from the repo, the interview's
notes as dash bullets under "What the interview established:", and what Krane
said, verbatim, as dash bullets under "Krane said, in order:". It can't tell a
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
lines," "read back to Krane for you," "never write a read-back," "gets no question
at all," "propose again"); `test/interview.test.js` pins the pure functions' exact
behaviour (`noteInterview`, `interviewBlock`, `readyToPropose`, `readBack`,
`parseBrief`, `wantsToProceed`, `cleanBrief`, `composeBrief`); `test/confirm.test.js`
pins `readConfirmingAnswer` alongside `readAnswer`; `test/activity-policy.test.js`
pins the `"confirming"` label. A change that drifts from this document without
updating those files is a change `npm test` will not catch — read this page again
before touching any of them.
