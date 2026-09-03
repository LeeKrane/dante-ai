// Ask first, then confirm once.
//
// Two separate jobs used to blur into one. A voice-only "start a session" is
// often too thin to act on: "fix the tests" in which repo, doing what
// exactly. INTERVIEWING is the model asking about whichever of that is
// genuinely open -- one question, hear the answer, ask another -- before it
// ever writes the tag that plans a start, a tell or an interrupt. Each
// question rides out as its own tag, [ACTION:SESSION verb=interview
// for=start repo=jarvis have=goal,where note="what the last answer taught
// you"], because the interview has to survive the model the same way a
// proposal does: the warm CLI holds the conversation, but it is restarted
// from cold on any failure (askResilient in lib/brain.js) and its memory
// goes with it, so the notes -- and `said`, what Krane actually said -- are
// the one copy of "what I've learned so far" that outlives that.
//
// CONFIRMING is a later, separate step, and it belongs to the machine, not
// the model. Once the model proposes one -- a start, a tell or an interrupt,
// whether every facet is covered or not -- server.js holds the session tag and
// speaks exactly ONE read-back, built by readBack from the model's own
// brief, covering all four facets in one breath. The model used to be
// allowed to read facets back itself (confirming=/confirmed= on its own
// tag), with the machine only picking up whatever it left unconfirmed --
// which is how a request ended up confirmed twice in a row, once by each of
// them, or a long "yes, that's exactly right" got misread as a correction
// and re-proposed into a second read-back nobody asked for. One read-back,
// spoken once, always by the machine, is the fix: readyToPropose no longer
// counts anything the model wrote about confirming, only Krane telling the
// model outright to proceed.
//
// A no or a correction to that read-back loops back to the interview rather
// than ending it: withdrawConfirming clears the hold, activity goes back to
// "interviewing", and the correction reaches the model as an ordinary turn,
// with interviewBlock's tail telling it to fold the correction in, ask about
// anything it left open, and otherwise propose again -- which is read back
// once more, by the machine, the same way. `confirming=` and `confirmed=`
// are still parsed off a tag below (noteInterview), because the machine's
// own synthetic read-back tag uses `confirming=` to say which facets it just
// asked about, and interviewBlock reads it to tell the model whose turn is
// next -- the model just never writes either key itself any more.
//
// This module is the pure half of both halves: the state one interview tag
// folds into, the sentence that reminds the model where the interview
// stands, and the text that becomes the eventual session's brief. Nothing
// here reads a clock except as a default, and nothing here decides when to
// stop interviewing: there is no question cap. FACETS names the four things
// a brief needs, and interviewBlock reports which of them the model has said
// are covered and which are still open -- that report, and the escape
// phrases wantsToProceed recognises, are what the model acts on;
// docs/interview.md spells out the rule this module and the INTERVIEW
// paragraph in lib/brain.js both have to agree with.

// MAX_TASK_CHARS there is the cap on a task read back inside a spoken sentence;
// this module has its own MAX_TASK_CHARS further down, the 600 a session's
// task is allowed on the command line, so the spoken one is renamed here.
import { MAX_ALIAS_CHARS, MAX_NAME_CHARS, MAX_TASK_CHARS as MAX_CLAUSE_CHARS } from "./confirm.js";

// The four things a brief needs before a session can be trusted with it, in
// the order they are usually asked. "Special" requirements (order of work,
// style, who to ask) are not a facet -- they exist only when Krane raises
// one, so there is nothing to track until he does. An interview is done when
// every one of these is covered -- by an answer, by the request itself, or
// by a stated assumption -- no answer left a question open, and every one of
// them has been read back and confirmed. That is the confidence rule;
// docs/interview.md, this list, and the INTERVIEW paragraph in lib/brain.js
// all have to say the same thing, or the model is told one story and does
// another.
export const FACETS = ["goal", "where", "constraints", "done"];

// An interview left mid-question is a stale one: the person moved on, and
// resuming it minutes later would fold a new conversation's answer into an
// old question's notes. Same shape as lib/confirm.js's PROPOSAL_TTL_MS, much
// longer, because answering a question takes longer than answering yes/no.
export const INTERVIEW_TTL_MS = 10 * 60_000;

// A note is the model's own summary of one answer, not the answer verbatim
// -- MAX_SAID below keeps the verbatim copy, so a note is free to stay
// short. Both caps here are a bound against a runaway loop, not a design
// target: a real interview never gets near either one, and nothing a real
// interview produces is meant to fall off the end of them.
const MAX_NOTE_CHARS = 240;
export const MAX_NOTES = 24;

// What Krane said, verbatim, on every turn the interview folded in -- the
// original request on the first tag, an answer on every one after. Notes are
// the model's own summaries and can drop a detail without meaning to; `said`
// sits alongside them so the eventual brief can be lossless even where a
// note wasn't. It exists for the same reason the notes have to survive a
// restart: the warm CLI can be restarted cold mid-interview (askResilient in
// lib/brain.js), and at that point this state is the only copy left of what
// was actually said.
export const MAX_SAID = 24;
const MAX_SAID_CHARS = 300;

// The cost of both ceilings at once: 24 notes at 240 chars plus 24 said lines
// at 300 chars is roughly 13,000 characters riding in interviewBlock's
// INTERVIEW line on every turn for as long as the interview stays live (up to
// INTERVIEW_TTL_MS). Acceptable because that line is read by the model, never
// spoken, and a real interview -- a handful of questions, not two dozen -- is
// nowhere near either cap; see MAX_NOTE_CHARS's comment above for why hitting
// them at all is the pathological case, not the target.

// The eventual session brief, capped. A structured brief with sections runs
// longer than the one-line paragraph this used to compose, so the cap grew
// with it. This no longer lines up with lib/peer.js's MAX_MESSAGE_CHARS --
// see the comment there -- and it never needed to: two unrelated budgets
// that once happened to land on the same number, now visibly different
// ones. lib/spawn-session.js imports this one.
export const MAX_BRIEF_CHARS = 6000;

// The three verbs an interview can precede. Not "stop": stopping a session
// needs no interview, there is nothing left to ask about.
export const INTERVIEW_VERBS = new Set(["start", "tell", "interrupt"]);

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

// The same class, minus \n -- a brief's line breaks are its structure (a
// Goal line, a block of Constraints bullets), the one piece of a model's own
// formatting worth keeping rather than stripping.
const UNPRINTABLE_KEEP_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

// Copied from lib/confirm.js's cleanText, and lib/peer.js's clean before it:
// whitespace collapses before the unprintables are stripped, because a
// newline is both and stripping it first fuses the words on either side of
// it into one.
function clean(value, maxChars) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

// Like clean, but keeping the line breaks a structured brief depends on for
// its sections -- a Goal line, a Where line, Constraints and Done when as
// their own blocks of dashes. Same collapse-before-strip ordering argument
// as clean: whitespace collapses first, or a run that happened to straddle a
// stray control character would fuse across it once the character is gone.
// lib/spawn-session.js imports this rather than keeping its own copy;
// public/activity-policy.js cannot (public/ is served straight off disk with
// no bundler) and keeps its own, close but not identical to this one.
export function cleanBrief(value, maxChars = MAX_BRIEF_CHARS) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(UNPRINTABLE_KEEP_NEWLINE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

// A leading clause the model announces the interview with, e.g. "Before I
// interview, sir: ...". The first interview turn carries no interviewBlock
// line -- conv.interview is still null until noteInterview runs, after the
// model has already answered -- so on that turn the model has only the
// persona's "interview Krane first" to go on, and has been seen narrating
// that as a step still ahead rather than the thing it is doing. The persona
// now forbids it outright; this is the mechanical backstop for the turns
// where the model forgets anyway, the same way the chat handler's read
// branch blanks the read sentence rather than trusting the model not to
// write one. Kept deliberately narrow -- clause length, no sentence-ending
// punctuation inside it (colon included, so a question that itself uses a
// colon, e.g. "which repo: jarvis or dante?", is never mistaken for part of
// the clause), a required "before"/"first" lead-in (the two shapes the
// persona forbids -- a real question naming the interview, "Which interview
// style: short or long?", does not open that way), and the word "interview"
// itself -- so a genuine lead-in on a later turn ("Before I ask, sir, one
// thing: ...") is left alone rather than eaten along with the bug.
const INTERVIEW_PREAMBLE = /^([^\n?.!:]{1,80}):\s*/;
const INTERVIEW_LEAD_IN = /^(?:before|first)\b/i;

// stripInterviewPreamble(reply) -> reply with a leading announcement of the
// interview itself removed, or reply unchanged if the leading clause is not
// that announcement (no colon, too long, punctuation or a colon inside it,
// no "before"/"first" lead-in, or no mention of "interview"/"interviewing").
// A reply that was only the announcement comes back as "", which the
// caller's existing !question branch already treats as nothing to speak.
export function stripInterviewPreamble(reply) {
  if (typeof reply !== "string") return "";
  const match = reply.match(INTERVIEW_PREAMBLE);
  if (!match || !INTERVIEW_LEAD_IN.test(match[1]) || !/\binterview(?:ing)?\b/i.test(match[1])) return reply;
  return reply.slice(match[0].length).trim();
}

// isLive(state, now) -> whether an interview is still within its TTL. A
// state with no timestamp (never started, or malformed) is never live --
// Number.isFinite(undefined) is false, so a bare {} reads the same as null.
export function isLive(state, now = Date.now()) {
  return Number.isFinite(state?.at) && now - state.at < INTERVIEW_TTL_MS;
}

// parseFacets(raw) -> the facets a have=, confirming= or confirmed= value
// names, lowercase, deduped, in FACETS order -- a comma- or whitespace-
// separated list, the same tolerance the model's own punctuation habits need
// ("goal, where" and "goal where" parse the same way). A name outside FACETS
// is dropped rather than kept around as something unknown: garbage in one of
// these values should read as "nothing new," not as a fifth thing to explain
// to the model.
function parseFacets(raw) {
  const named = new Set(
    raw
      .toLowerCase()
      .split(/[\s,]+/)
      .map((piece) => piece.trim())
      .filter((piece) => FACETS.includes(piece)),
  );
  return FACETS.filter((facet) => named.has(facet));
}

// noteInterview(state, tag, now, said) -> the next state.
//
// Continues a live interview, or starts a fresh one when there isn't one --
// the same call handles both, because the caller (server.js) has no reason
// to tell them apart: an interview tag always means "fold this in", whether
// or not anything came before it. Never mutates `state`: the caller may
// still hold the previous turn's state elsewhere (a log, a retry), and
// handing back a new object every time is what keeps that safe.
//
// `said` is what Krane said on the turn this tag answered -- the original
// request on the first tag, an answer afterwards. It is a single string on an
// ordinary turn, but a superseded one can carry several sentences forward
// (server.js's MAX_UNANSWERED lets up to three ride unanswered until one
// reply catches them all up), so this also accepts an array of strings and
// pushes each one, in order, onto `said` -- cleaned and with empties dropped,
// same as the single-string case. This function only accumulates and caps
// it; it is the caller's job to pass the right text or texts (server.js
// already has the utterance, or the slice of unanswered ones, in hand).
export function noteInterview(state, tag, now = Date.now(), said = "") {
  const previous = state && isLive(state, now) ? state : null;

  const forVerb = typeof tag?.for === "string" ? tag.for.toLowerCase() : "";
  const verb = INTERVIEW_VERBS.has(forVerb) ? forVerb : previous?.verb ?? "start";

  // The same caps lib/confirm.js uses for a repo alias and a session name
  // read back in a sentence -- both may end up in exactly that sentence once
  // the interview proposes. The name is which running session a tell or an
  // interrupt is for; it carries forward like the repo does, and matches()
  // below keeps an interview about one session from lending its state to a
  // tag about another.
  const repo = clean(tag?.repo, MAX_ALIAS_CHARS) || previous?.repo || "";
  const name = clean(tag?.name, MAX_NAME_CHARS) || previous?.name || "";

  const note = clean(tag?.note, MAX_NOTE_CHARS);
  const priorNotes = previous?.notes ?? [];
  const notes = note ? [...priorNotes, note].slice(-MAX_NOTES) : priorNotes;

  const newSaid = (Array.isArray(said) ? said : [said])
    .map((line) => clean(line, MAX_SAID_CHARS))
    .filter((line) => line);
  const priorSaid = previous?.said ?? [];
  const saidList = [...priorSaid, ...newSaid].slice(-MAX_SAID);

  // `have` names the facets the model is now sure of. A tag that omits the
  // key continues the previous turn's coverage rather than resetting it --
  // same reasoning as repo's fallback above: silence about a key means the
  // key did not change, not that it went back to unknown. A tag that names
  // the key with an empty value is not silent, though, and does reset -- the
  // model said, in effect, "nothing new is settled."
  const haveGiven = typeof tag?.have === "string";
  const coveredFromTag = haveGiven ? parseFacets(tag.have) : previous?.covered ?? [];

  // `confirmed` accumulates the same way `have` does: omitted carries the
  // previous turn's list, present-but-empty resets it. `confirming` does
  // not carry -- it describes the question being asked on THIS tag, and a
  // question that reads nothing back is not a read-back just because the
  // last one was. It is spelled out on every tag that is one, or it is none.
  const confirmedGiven = typeof tag?.confirmed === "string";
  const confirmed = confirmedGiven ? parseFacets(tag.confirmed) : previous?.confirmed ?? [];
  const confirming = typeof tag?.confirming === "string" ? parseFacets(tag.confirming) : [];

  // A known repo answers "where" on its own; the model should not be told
  // that facet is still open once it has named one. A facet being read back,
  // or already confirmed, is necessarily one the model has -- it cannot read
  // back what it does not know -- so both fold into covered as well, and the
  // model is never told a facet is open while also being told Krane said yes
  // to it.
  const known = new Set([...coveredFromTag, ...confirming, ...confirmed]);
  if (repo) known.add("where");
  const covered = FACETS.filter((facet) => known.has(facet));

  return {
    verb,
    repo,
    name,
    notes,
    said: saidList,
    covered,
    confirming,
    confirmed,
    asked: (previous?.asked ?? 0) + 1,
    at: now,
    proceed: previous?.proceed ?? false,
    // Set only by the synthetic tag server.js folds in when it speaks a
    // read-back on the model's behalf, so interviewBlock can say so: the model
    // never asked that question and would otherwise read Krane's "yes" as an
    // answer to whatever it said last.
    spokenFor: tag?.spokenFor === true,
    // Set only by withdrawConfirming, cleared by the next tag: an explicit
    // signal that the machine's own read-back was just answered no or
    // corrected, rather than inferring it from spokenFor and an empty
    // confirming list, which was also the shape of a state that had simply
    // never been read back yet.
    withdrawn: false,
  };
}

// unconfirmedFacets(state) -> the facets Krane has neither confirmed nor
// been asked to confirm, in FACETS order. All four for no state at all: an
// interview that never happened confirmed nothing.
//
// Nothing outside this module's own tests calls this any more, now that
// server.js reads every facet back via FACETS rather than asking which ones
// are still unconfirmed. Kept anyway, as the helper the tests -- and
// withdrawConfirming's callers, reasoning about what a state's
// confirmed/confirming pair adds up to -- use to check that bookkeeping
// stays correct.
export function unconfirmedFacets(state) {
  const settled = new Set([...(state?.confirmed ?? []), ...(state?.confirming ?? [])]);
  return FACETS.filter((facet) => !settled.has(facet));
}

// readyToPropose(state, now) -> whether the start, tell or interrupt this
// interview is planning may be proposed straight off it, skipping the
// machine's read-back.
//
// Just proceed, said out loud (markProceed, via wantsToProceed) -- nothing
// else. confirmed= and confirming= used to count too, a facet read back by
// the model counting the same as one Krane had actually said yes to, and
// that is exactly the seam the duplicate read-back came through: a model
// that had gathered confirmed= for three facets and confirming= for a fourth
// was "ready" by the old rule, so its own partial read-back (or half of one)
// stood in for the machine's, or the machine went on to speak a second one
// covering only what the model's had missed -- two similar questions where
// there should have been one. One read-back, covering every facet, spoken
// once, always by the machine, closes that gap, so now nothing short of
// Krane's own "just go ahead" skips it.
export function readyToPropose(state, now = Date.now()) {
  return isLive(state, now) && state.proceed === true;
}

// holdForReadBack(session, state, now) -> whether server.js should speak a
// read-back in place of proposing this tag. `state` is the interview the
// tag belongs to (matches), or null. Only the three verbs an interview can
// precede are ever held; a skill (command=) never is, because its facets are
// the command line and the proposal reads that line back exactly. Krane's
// escape phrase needs no clause here: it reaches the state through
// markProceed, and readyToPropose already honours proceed.
export function holdForReadBack(session, state, now = Date.now()) {
  const verb = typeof session?.verb === "string" ? session.verb.toLowerCase() : "";
  if (!INTERVIEW_VERBS.has(verb)) return false;
  if (typeof session?.command === "string" && session.command.trim()) return false;
  return !readyToPropose(state, now);
}

// withdrawConfirming(state) -> the same interview with nothing awaiting a
// yes any more: the answer to the read-back was not one. The facets go back
// to covered-but-unconfirmed, which is exactly the state the next question
// has to close. `withdrawn` is set so interviewBlock can tell this apart
// from a state that was simply never read back -- see its comment.
export function withdrawConfirming(state) {
  return state ? { ...state, confirming: [], withdrawn: true } : null;
}

// matches(state, session) -> whether a resolved session tag belongs to the
// interview in progress. The verb must match; the repo must match when both
// are known, because a live interview about jarvis must not lend its notes to
// a one-shot start in fitness that never went through it -- but a tag that
// names no repo, or an interview that never learned one, still matches, and a
// mid-interview "no, in fitness" reaches the state through the next interview
// tag's repo before any start tag is written.
//
// The session name is held to the same rule, for a tell or an interrupt:
// a read-back about fix-tests, still waiting on its yes, must not make an
// unrelated "tell build-ui to redeploy" ready to propose -- it did before
// this check, because neither carries a repo and the verb alone matched.
export function matches(state, session) {
  if (!state) return false;
  const verb = typeof session?.verb === "string" ? session.verb.toLowerCase() : "";
  if (verb !== state.verb) return false;
  const repo = clean(session?.repo, MAX_ALIAS_CHARS);
  if (repo && state.repo && repo !== state.repo) return false;
  const name = clean(session?.name, MAX_NAME_CHARS);
  if (name && state.name && name !== state.name) return false;
  return true;
}

// markProceed(state) -> the same interview, flagged so interviewBlock stops
// nudging toward another question. A separate function rather than a field
// wantsToProceed sets directly, because the two are read at different times
// by different callers -- one reads an utterance, the other reads state --
// and keeping them apart means neither has to know about the other's input.
export function markProceed(state) {
  return state ? { ...state, proceed: true } : null;
}

// The escape vocabulary, matched inside a normalised utterance rather than
// against the whole of it -- "okay, just go ahead then" still says it. What
// keeps this safe is the word cap below, not exactness here.
const ESCAPE_PHRASES = [
  /\bjust start it\b/,
  /\bjust do it\b/,
  /\bjust go\b/,
  /\bgo ahead\b/,
  /\bthat's enough\b/,
  /\bthat is enough\b/,
  /\benough questions\b/,
  /\bno more questions\b/,
  /\bskip the questions\b/,
  /\bstart it now\b/,
  /\bproceed\b/,
  /\bstop asking\b/,
  /\bstop the questions\b/,
  /\bstop with the questions\b/,
  /\bthat'll do\b/,
  /\bthat will do\b/,
  /\byou have enough\b/,
  /\byou've got enough\b/,
  /\byou know enough\b/,
];

// A short utterance only. Without this, "well, I don't think we should just
// go ahead with that plan yet" would read as an escape because it contains
// the phrase, when the sentence as a whole is nothing of the kind. Same
// reasoning as MAX_ANSWER_WORDS in lib/confirm.js: being wrong here costs
// one extra question, never a session started on a misread word. All of the
// phrases above, including the newer ones, fit comfortably inside it.
const MAX_ESCAPE_WORDS = 6;

// wantsToProceed(text) -> whether the person is telling the model to stop
// asking and propose with what it has.
export function wantsToProceed(text) {
  const cleaned = clean(text, 300);
  if (!cleaned) return false;

  // Apostrophes survive so "that's" and "that'll" are not split into two
  // words; everything else that is not alphanumeric is a word boundary at
  // best, noise at worst, and either way should not count against the cap
  // or the match.
  const normalized = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

  // A negation means "no, do not proceed" even if the utterance contains
  // "proceed", and marking the interview as proceed on that would tell the
  // model the opposite of what was said for the rest of the interview; being
  // wrong in this direction costs one more question, the other direction costs
  // a proposal nobody asked for (same asymmetry lib/confirm.js's readAnswer
  // treats "no, go ahead" as a correction).
  // Anywhere in the utterance, not only at its start: "okay, don't proceed" is
  // as much a refusal as "don't proceed". "no more" is the one "no" that is not
  // a negation here -- it is the escape phrase itself. "stop" is both a
  // negation word on its own ("stop!", "no, stop") and the first word of three
  // escape phrases below ("stop asking", "stop the questions", "stop with the
  // questions") -- the lookahead carves those three out of the negation so an
  // escape phrase said plainly is not read as its own refusal.
  if (/\b(don't|dont|do not|not|never|wait|hold on|stop(?! (?:asking|the questions|with the questions)\b))\b/.test(normalized)) return false;
  if (/\bno\b(?! more\b)/.test(normalized)) return false;

  const words = normalized.split(" ");
  if (words.length > MAX_ESCAPE_WORDS) return false;

  return ESCAPE_PHRASES.some((phrase) => phrase.test(normalized));
}

const VOWEL = /^[aeiou]/i;

// "a start", "a tell", "an interrupt" -- the article a verb takes when it is
// read as the noun of what is being planned.
function article(verb) {
  return VOWEL.test(verb) ? "an" : "a";
}

// interviewBlock(state, now) -> the reminder folded into the model's next
// turn, so it knows where the interview stands without the conversation
// itself carrying that -- the model's own context is the spoken back and
// forth, not a running tally, and this is the tally. lib/turns.js's
// mergeTurns folds it into the turn as one line of machine state, so it
// stays one line here no matter how much it has to report.
//
// "" for anything not worth reminding the model about: no interview, or one
// that has gone stale and should be started over rather than continued.
export function interviewBlock(state, now = Date.now()) {
  if (!state || !isLive(state, now)) return "";

  const { verb, repo, notes, said, covered, asked, proceed, spokenFor, withdrawn } = state;
  const confirming = state.confirming ?? [];
  const confirmed = state.confirmed ?? [];
  const place = repo ? ` in ${repo}` : "";
  const count = asked === 1 ? "1 question" : `${asked} questions`;
  const opening = `INTERVIEW in progress: planning ${article(verb)} ${verb}${place}. ${count} asked.`;

  const open = FACETS.filter((facet) => !covered.includes(facet));
  const coveredText = covered.length > 0 ? covered.join(", ") : "none reported yet";
  const openText = open.length > 0 ? open.join(", ") : "nothing";
  // Nothing writes confirmed= any more (see readyToPropose's comment), so a
  // constant "Confirmed: none yet" would read as meaningful when it never
  // is; the clause only appears once there is something to report.
  const confirmedClause = confirmed.length > 0 ? ` Confirmed: ${confirmed.join(", ")}.` : "";
  const awaiting = confirming.length > 0 ? ` Awaiting a yes on: ${confirming.join(", ")}.` : "";
  const coverage = ` Covered: ${coveredText}. Still open: ${openText}.${confirmedClause}${awaiting}`;

  const learned = notes.length > 0 ? ` Learned so far: ${notes.join("; ")}.` : "";

  const saidText = said.length > 0
    ? ` Krane said, in order: ${said.map((line, i) => `(${i + 1}) ${line}`).join(" ")}.`
    : "";

  // proceed wins over the facet coverage even when both are true (the person
  // said "stop asking" on the same turn the last facet was covered): being
  // told outright to proceed is a stronger version of the same instruction,
  // not a competing one.
  //
  // withdrawn is set only by withdrawConfirming, called when the machine's
  // own read-back comes back a no or a correction, and cleared by the next
  // tag (noteInterview always returns withdrawn: false). It says outright
  // what used to be inferred from spokenFor true with nothing left in
  // `confirming` -- a shape that was ambiguous with a state that had simply
  // never been read back yet -- so this branch fires only for an actual
  // withdrawal, not a guess at one.
  let tail;
  if (proceed) {
    tail = "Krane asked you to proceed: ask nothing more, propose now with what you have.";
  } else if (open.length > 0) {
    tail =
      "Ask the one question that closes the biggest gap, one per turn. A facet the request " +
      "itself settles is read back for a yes, never re-asked and never skipped.";
  } else if (withdrawn === true) {
    // A long "no" cannot come back as "no" here: past readAnswer's four-word
    // cutoff, readConfirmingAnswer only ever returns "yes" or "amend" -- on
    // purpose, since a long no is usually a no plus the correction that goes
    // with it ("no, forget the whole thing"). So the tail has to cover both
    // readings of a withdrawn read-back, not just the one where Krane is
    // fixing something.
    tail =
      "Your brief was read back to Krane by the machine, and he said no or corrected it. What he " +
      "says now is the correction: fold it in, and if it leaves a facet open, ask about that one " +
      "thing only, one question. If instead he dropped it, say so and propose nothing. Otherwise " +
      "propose again with the corrected task and brief, which will be read back once more.";
  } else if (confirming.length > 0) {
    // Unreachable in production: server.js's answerHeld runs before the model
    // is ever asked again, and it always clears the hold first -- a yes nulls
    // the whole interview, a no or a correction withdraws confirming (see
    // withdrawConfirming). So by the time interviewBlock next runs, confirming
    // is already empty either way. This branch only fires for a `confirming=`
    // the model wrote onto its own tag, which noteInterview still parses but
    // which the persona no longer teaches the model to write. Kept rather
    // than deleted, in case that ever changes back.
    tail =
      (spokenFor ? "The read-back was spoken for you, from your brief. " : "") +
      `Krane's answer to that read-back follows: fold a correction in, otherwise propose now with the ${verb} tag.`;
  } else {
    tail =
      `Every facet is covered: propose now with the ${verb} tag carrying task= and brief=; the brief ` +
      "is read back to Krane for you before anything is proposed, so never write a read-back of your " +
      "own; unless an answer left something genuinely open, then ask about that one thing only.";
  }

  return `${opening}${coverage}${learned}${saidText} ${tail}`;
}

// A note earns a full stop of its own so a run of them reads as sentences
// rather than a comma splice -- but not a second one, for the note that
// already ended its answer with "?" or "!" and would otherwise end up with
// two.
function withStop(note) {
  return /[.!?]$/.test(note) ? note : `${note}.`;
}

// The task itself is capped the same 600 chars lib/spawn-session.js already
// caps a session's task at (its own MAX_TASK_CHARS) -- this is the same
// text, just possibly followed by the sections that got it there.
const MAX_TASK_CHARS = 600;

// composeBrief({ task, brief, notes, said, repo }) -> the text a started
// session actually receives as its brief.
//
// A brief the model wrote itself wins outright: by the time it writes one,
// the interview is over and the model has already turned the notes and
// facets into a document written for the session, better than this function
// could re-derive by gluing the raw pieces back together. It is still run
// through cleanBrief rather than trusted whole -- this is model-authored
// text about to reach a real command line -- and cleanBrief keeps its line
// breaks, because the model's own brief carries its structure (Goal, Where,
// Constraints, Done when) in exactly the line breaks the fallback below
// carries its own structure in.
//
// Only when there is no such brief -- an interview that proceeded without
// writing one, or a start with no interview at all -- does this compose one
// itself, from the task, the repo, the notes, and what Krane actually said.
// This fallback cannot tell a constraint from an acceptance criterion the
// way the model's own brief can -- it has no idea which note was which --
// so rather than guess at sections it cannot support, it keeps everything:
// the notes verbatim as bullets and, since a note is a summary and can drop
// a detail without meaning to, what Krane said verbatim as well. Lossy would
// be losing something silently; this loses nothing instead -- except at the
// very ceiling. MAX_NOTES notes at MAX_NOTE_CHARS plus MAX_SAID said lines at
// MAX_SAID_CHARS is worst case around 13,700 characters once the line labels
// and task are added, and the final .slice(0, MAX_BRIEF_CHARS) below is a real
// truncation at 6,000, not a hypothetical one, if an interview ever actually
// reached both caps. This is the one place in this module that claim can fail
// to hold -- see the comment on MAX_SAID above for why no real interview gets
// anywhere close.
export function composeBrief({ task, brief, notes, said, repo } = {}) {
  const cleanedBrief = cleanBrief(brief, MAX_BRIEF_CHARS);
  if (cleanedBrief) return cleanedBrief;

  const cleanedTask = clean(task, MAX_TASK_CHARS);
  if (!cleanedTask) return "";

  const cleanedRepo = clean(repo, MAX_ALIAS_CHARS);

  // Clean each note and drop empties. This is the text a real session
  // receives as its prompt, and a pure function that is safe only when its
  // caller sanitised first is not safe.
  const usableNotes = Array.isArray(notes)
    ? notes.map((note) => clean(note, MAX_NOTE_CHARS)).filter((note) => note)
    : [];
  const usableSaid = Array.isArray(said)
    ? said.map((line) => clean(line, MAX_SAID_CHARS)).filter((line) => line)
    : [];

  const lines = [`Goal: ${cleanedTask}`];
  if (cleanedRepo) lines.push(`Where: ${cleanedRepo}`);
  if (usableNotes.length > 0) {
    lines.push("What the interview established:");
    for (const note of usableNotes) lines.push(`- ${withStop(note)}`);
  }
  if (usableSaid.length > 0) {
    lines.push("Krane said, in order:");
    for (const line of usableSaid) lines.push(`- ${line}`);
  }

  return lines.join("\n").slice(0, MAX_BRIEF_CHARS);
}

// The section labels a brief is taught to use (the INTERVIEW paragraph in
// lib/brain.js, and docs/interview.md's "Shape"), matched at the start of a
// line, case-insensitively, with the colon -- or alone on its line, which is
// what a markdown heading leaves once its hashes are stripped. "Done when" is
// looked for before "Done", or the shorter label would claim the longer
// one's line.
const SECTIONS = [
  ["goal", /^goal(?::|$)/i],
  ["where", /^where(?::|$)/i],
  ["constraints", /^constraints(?::|$)/i],
  ["done", /^done(?: when)?(?::|$)/i],
  ["also", /^also(?::|$)/i],
];

// What a model adds to a label when it forgets it is not writing markdown:
// "## Goal", "**Goal:**", "__Where__:". The persona teaches the plain shape
// and the brief is never rendered, but a read-back that says "nothing was
// said about constraints" because the label wore asterisks is a lie about
// the brief, so the decoration is stripped before the label is looked for.
const MARKDOWN_LABEL = /^[#>\s]+|\*\*|__|(?<=\S)[*_]+(?=:)|^[*_]+/g;

// parseBrief(brief) -> { goal, where, constraints, done, also }: the text
// after each label, and each dash bullet under a section as its own entry.
// Every field is present even when the brief is not, so a caller can read
// `parsed.constraints.length` without checking first. Text on the label's
// own line and bullets under it both count, in that order -- a model that
// writes "Constraints: none" and one that writes a bullet list are both
// following the shape.
export function parseBrief(brief) {
  const parsed = { goal: "", where: "", constraints: [], done: [], also: [] };
  const lines = cleanBrief(brief, MAX_BRIEF_CHARS).split("\n");
  let section = null;
  for (const raw of lines) {
    const line = raw.replace(MARKDOWN_LABEL, "").trim();
    if (!line) continue;
    const found = SECTIONS.find(([, pattern]) => pattern.test(line));
    if (found) {
      section = found[0];
      const rest = line.replace(found[1], "").trim();
      if (rest) add(parsed, section, rest);
      continue;
    }
    if (!section) continue;
    add(parsed, section, line.replace(/^[-*•]\s*/, ""));
  }
  return parsed;
}

function add(parsed, section, text) {
  if (section === "goal" || section === "where") {
    parsed[section] = parsed[section] ? `${parsed[section]} ${text}` : text;
  } else {
    parsed[section].push(text);
  }
}

// readBack({ verb, task, repo, name, brief }, facets) -> the question
// server.js speaks when a start, tell or interrupt tag arrives with facets
// nobody has confirmed, or "" when there is nothing to read back.
//
// This is the fallback for a model that proposed without asking, and it is
// built from that model's own brief so that what is read back is what the
// session would actually have received -- the reading being checked is the
// model's, not a fresh one. It names only the facets it is given, so a
// second read-back after a correction covers the corrected facet alone.
// A facet the brief says nothing about is asked as the assumption the
// silence amounts to, which is still a question about that facet rather
// than "did you mean what you said?" -- the generic re-ask docs/interview.md
// forbids.
//
// "Where" means a different thing per verb, the same way it does across the
// rest of this codebase: a repository for a start, a running session for a
// tell or an interrupt -- and for those the brief's own Where line (the area
// within a repo) matters less than which session the words are going to, so
// the session's name wins when the caller has one.
export function readBack({ verb, task, repo, name, brief } = {}, facets = FACETS) {
  const wanted = FACETS.filter((facet) => Array.isArray(facets) && facets.includes(facet));
  if (wanted.length === 0) return "";

  const toSession = verb === "tell" || verb === "interrupt";
  const parsed = parseBrief(brief);
  // Each clause is capped the way lib/confirm.js caps the same field in the
  // proposal that follows, so nothing is clipped differently in the two
  // sentences Krane hears one after the other.
  const goal = clean(parsed.goal, MAX_CLAUSE_CHARS) || clean(task, MAX_CLAUSE_CHARS);
  const where = toSession
    ? clean(name, MAX_NAME_CHARS) || clean(repo, MAX_ALIAS_CHARS)
    : clean(parsed.where, MAX_CLAUSE_CHARS) || clean(repo, MAX_ALIAS_CHARS);
  const constraints = parsed.constraints.map((line) => clean(line, MAX_CLAUSE_CHARS)).filter(Boolean);
  const done = parsed.done.map((line) => clean(line, MAX_CLAUSE_CHARS)).filter(Boolean);

  const clauses = [];
  const assumptions = [];
  for (const facet of wanted) {
    if (facet === "goal") {
      if (!goal) assumptions.push("I do not have a goal for it at all");
      else if (verb === "interrupt") clauses.push(`I would interrupt it to ${withoutStop(goal)}`);
      else if (verb === "tell") clauses.push(`I would tell it to ${withoutStop(goal)}`);
      else clauses.push(`the goal is ${withoutStop(goal)}`);
    } else if (facet === "where") {
      if (where) clauses.push(toSession ? `the session is ${withoutStop(where)}` : `in ${withoutStop(where)}`);
      else if (toSession) assumptions.push("nothing was said about which session");
      else assumptions.push("nothing was said about where, so I would use the main repository");
    } else if (facet === "constraints") {
      if (constraints.length > 0) clauses.push(`constraints: ${constraints.map(withoutStop).join("; ")}`);
      else assumptions.push("nothing was said about constraints, so I would take it there are none");
    } else if (facet === "done") {
      if (done.length > 0) clauses.push(`done when ${done.map(withoutStop).join("; ")}`);
      else assumptions.push("nothing was said about what done looks like, so I would take the goal itself as the test");
    }
  }

  const parts = [];
  if (clauses.length > 0) parts.push(`let me check I have this right: ${clauses.join(", ")}`);
  if (assumptions.length > 0) parts.push(assumptions.join(", and "));
  return `Before I propose, sir, ${parts.join(". And ")}. Have I got that right?`;
}

// A clause read back mid-sentence drops the full stop its bullet may have
// ended with; the sentence supplies its own. Same reasoning as asClause in
// lib/confirm.js.
function withoutStop(text) {
  return text.replace(/[.]+$/, "");
}
