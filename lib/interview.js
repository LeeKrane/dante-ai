// Ask first, then propose.
//
// A voice-only "start a session" is often too thin to act on: "fix the
// tests" in which repo, doing what exactly. Rather than guess and lean on
// lib/confirm.js's "Shall I, sir?" to catch a wrong guess, the model can
// interview -- ask one question, hear the answer, ask another -- before it
// ever writes the tag confirm.js turns into a proposal. Each question rides
// out as its own tag, [ACTION:SESSION verb=interview for=start repo=jarvis
// note="what the last answer taught you"], because the interview has to
// survive the model the same way a proposal does: the warm CLI holds the
// conversation, but it is restarted from cold on any failure (askResilient in
// lib/brain.js) and its memory goes with it, so the notes are the one copy of
// "what I've learned so far" that outlives that -- and, folded into every
// turn, they are also how the question count is enforced rather than hoped for.
//
// This module is the pure half of that: the state one interview tag folds
// into, the sentence that reminds the model where the interview stands, and
// the text that becomes the eventual session's brief. Nothing here reads a
// clock except as a default, and nothing here decides when to stop
// interviewing -- MAX_QUESTIONS and the cap sentence in interviewBlock are
// the nudge, not an enforcement; the model is still the one holding the
// pen when it writes the next tag.

// The person answers these by voice. Four is already a lot of back-and-forth
// before anything runs -- long past four and the interview has become the
// task.
export const MAX_QUESTIONS = 4;

// An interview left mid-question is a stale one: the person moved on, and
// resuming it minutes later would fold a new conversation's answer into an
// old question's notes. Same shape as lib/confirm.js's PROPOSAL_TTL_MS, much
// longer, because answering a question takes longer than answering yes/no.
export const INTERVIEW_TTL_MS = 10 * 60_000;

// A note is the model's own summary of one answer, not the answer verbatim
// -- short enough that MAX_NOTES of them still fit in one spoken reminder.
export const MAX_NOTE_CHARS = 200;

// Past this many notes the reminder itself would be the longest thing said
// in the conversation. Older notes are the ones already folded into the
// question that followed them, so dropping them costs nothing new.
export const MAX_NOTES = 6;

// The eventual session brief, capped. This equals lib/peer.js's
// MAX_MESSAGE_CHARS today, but that is a coincidence of two unrelated
// budgets landing on the same number, not a shared constant -- do not
// import one from the other. lib/spawn-session.js imports this one.
export const MAX_BRIEF_CHARS = 2000;

// The three verbs an interview can precede. Not "stop": stopping a session
// needs no interview, there is nothing left to ask about.
export const INTERVIEW_VERBS = new Set(["start", "tell", "interrupt"]);

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

// Copied from lib/confirm.js's cleanText, and lib/peer.js's clean before it:
// whitespace collapses before the unprintables are stripped, because a
// newline is both and stripping it first fuses the words on either side of
// it into one.
function clean(value, maxChars) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

// isLive(state, now) -> whether an interview is still within its TTL. A
// state with no timestamp (never started, or malformed) is never live --
// Number.isFinite(undefined) is false, so a bare {} reads the same as null.
export function isLive(state, now = Date.now()) {
  return Number.isFinite(state?.at) && now - state.at < INTERVIEW_TTL_MS;
}

// noteInterview(state, tag, now) -> the next state.
//
// Continues a live interview, or starts a fresh one when there isn't one --
// the same call handles both, because the caller (server.js, presumably)
// has no reason to tell them apart: an interview tag always means "fold
// this in", whether or not anything came before it. Never mutates `state`:
// the caller may still hold the previous turn's state elsewhere (a log, a
// retry), and handing back a new object every time is what keeps that safe.
export function noteInterview(state, tag, now = Date.now()) {
  const previous = state && isLive(state, now) ? state : null;

  const forVerb = typeof tag?.for === "string" ? tag.for.toLowerCase() : "";
  const verb = INTERVIEW_VERBS.has(forVerb) ? forVerb : previous?.verb ?? "start";

  // 40 chars, same cap lib/confirm.js uses for a repo alias read back in a
  // sentence -- a repo name is short, and this one may end up in exactly
  // that sentence once the interview proposes.
  const repo = clean(tag?.repo, 40) || previous?.repo || "";

  const note = clean(tag?.note, MAX_NOTE_CHARS);
  const priorNotes = previous?.notes ?? [];
  const notes = note ? [...priorNotes, note].slice(-MAX_NOTES) : priorNotes;

  return {
    verb,
    repo,
    notes,
    asked: (previous?.asked ?? 0) + 1,
    at: now,
    proceed: previous?.proceed ?? false,
  };
}

// matches(state, session) -> whether a resolved session tag belongs to the
// interview in progress. Only the verb is compared, deliberately: "no, in
// fitness" mid-interview is a correction to the repo, not a new interview,
// and comparing repo here would make that correction look like a different
// conversation and start the note-taking over from nothing.
export function matches(state, session) {
  if (!state) return false;
  const verb = typeof session?.verb === "string" ? session.verb.toLowerCase() : "";
  return verb === state.verb;
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
];

// A short utterance only. Without this, "well, I don't think we should just
// go ahead with that plan yet" would read as an escape because it contains
// the phrase, when the sentence as a whole is nothing of the kind. Same
// reasoning as MAX_ANSWER_WORDS in lib/confirm.js: being wrong here costs
// one extra question, never a session started on a misread word.
const MAX_ESCAPE_WORDS = 6;

// wantsToProceed(text) -> whether the person is telling the model to stop
// asking and propose with what it has.
export function wantsToProceed(text) {
  const cleaned = clean(text, 300);
  if (!cleaned) return false;

  // Apostrophes survive so "that's" is not split into two words; everything
  // else that is not alphanumeric is a word boundary at best, noise at
  // worst, and either way should not count against the cap or the match.
  const normalized = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

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
// forth, not a running tally, and this is the tally.
//
// "" for anything not worth reminding the model about: no interview, or one
// that has gone stale and should be started over rather than continued.
export function interviewBlock(state, now = Date.now()) {
  if (!state || !isLive(state, now)) return "";

  const { verb, repo, notes, asked, proceed } = state;
  const place = repo ? ` in ${repo}` : "";
  const opening = `INTERVIEW in progress: planning ${article(verb)} ${verb}${place}. ${asked} of ${MAX_QUESTIONS} questions asked.`;
  const learned = notes.length > 0 ? ` Learned so far: ${notes.join("; ")}.` : "";

  // proceed wins over the cap sentence even when both are true (the person
  // said "just start it" on the question that hit the cap): the cap is a
  // nudge toward proposing, and being told outright to proceed is a
  // stronger version of the same instruction, not a competing one.
  let tail;
  if (proceed) {
    tail = "Jesse asked you to proceed: ask nothing more, propose now with what you have.";
  } else if (asked >= MAX_QUESTIONS) {
    tail = "Question limit reached: ask nothing more, propose now with what you have.";
  } else {
    const remaining = MAX_QUESTIONS - asked;
    tail = `Ask at most ${remaining} more, one per turn, or propose now if the picture is clear.`;
  }

  return `${opening}${learned} ${tail}`;
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
// text, just possibly followed by the notes that got it there.
const MAX_TASK_CHARS = 600;

// composeBrief({ task, brief, notes }) -> the text a started session
// actually receives as its brief.
//
// A brief the model wrote itself wins outright: by the time it writes one,
// the interview is over and the model has already folded the notes into its
// own account of the task, better than this function could re-derive by
// gluing them back onto the original task. Only when there is no such brief
// -- an interview that proceeded without one, or a start with no interview
// at all -- does this compose one from the task plus whatever notes came
// out of the questions.
export function composeBrief({ task, brief, notes } = {}) {
  const cleanedBrief = clean(brief, MAX_BRIEF_CHARS);
  if (cleanedBrief) return cleanedBrief;

  const cleanedTask = clean(task, MAX_TASK_CHARS);
  if (!cleanedTask) return "";

  const usable = Array.isArray(notes) ? notes.filter((note) => typeof note === "string" && note) : [];
  if (usable.length === 0) return cleanedTask;

  const context = `Context from the conversation: ${usable.map(withStop).join(" ")}`;
  return `${cleanedTask} ${context}`.slice(0, MAX_BRIEF_CHARS);
}
