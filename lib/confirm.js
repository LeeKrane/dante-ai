// Propose, then act.
//
// Everything Dante can do to a live process arrives the same way: a model
// writes a tag, the tag is stripped before anyone hears it, and the dispatcher
// runs. Nothing sat in between, and it showed -- a request to START a session
// once ended with a different, working session STOPPED. Voice is a lossy
// channel and a model fills gaps with plausible guesses; the guardrail for that
// is not a better prompt, it is a confirmation the person actually gives.
//
// So the tag becomes a sentence, the sentence is said out loud, and the next
// thing said decides. Yes runs it, no drops it, and anything else is treated as
// a correction rather than an answer.
//
// The sentence is built HERE, from the parsed tag -- never from the model's own
// spoken reply, which is discarded for any turn that carried one. That is the
// property this module exists for: a model that says "I'll review the fitness
// repo" while tagging repo=jarvis cannot mislead anyone, because what is spoken
// is generated from what will actually run.

import { parseYesNo } from "./approval.js";

// A proposal is answered in the next breath or not at all. Past this it is not
// answerable: a "yes" ten minutes later is agreeing to something the person has
// long stopped thinking about, and it would start a real process.
export const PROPOSAL_TTL_MS = 120_000;

// Long enough to say what the work is, short enough to be one spoken sentence.
export const MAX_TASK_CHARS = 140;
export const MAX_NAME_CHARS = 60;

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

function cleanText(value, maxChars) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

// A task read back as part of a sentence rather than quoted at someone. The
// trailing full stop goes because the sentence supplies its own, and a leading
// capital goes because it lands mid-sentence ("...to Summarize the README").
function asClause(value, maxChars = MAX_TASK_CHARS) {
  const text = cleanText(value, maxChars).replace(/[.!?]+$/, "");
  if (!text) return "";
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

// "landing-page" -> "a landing page". A primitive id is the only human name a
// build has; the registry does not carry a title.
function buildName(id) {
  const words = cleanText(id, 60).replace(/[-_]+/g, " ").trim();
  if (!words) return "";
  return /^[aeiou]/i.test(words) ? `an ${words}` : `a ${words}`;
}

// describeIntent(intent) -> the sentence to say, or null when there is nothing
// describable -- in which case the caller dispatches as before and lets the
// dispatcher explain itself. Never invent a description for a tag that cannot
// be read: a confirmation nobody understands is worse than none.
export function describeIntent(intent = {}) {
  const body = describeBody(intent);
  return body ? `${body} Shall I, sir?` : null;
}

function describeBody({ session, action, primitive, workspace } = {}) {
  if (session) {
    const verb = typeof session.verb === "string" ? session.verb.toLowerCase() : "";
    // The alias Dante resolved beats the one the model wrote: they can differ,
    // and the resolved one is where the session will actually run.
    const where = cleanText(workspace?.alias ?? session.repo, 40);
    const task = asClause(session.task ?? session.text ?? session.message);
    const name = cleanText(session.name, MAX_NAME_CHARS);

    if (verb === "start") {
      const place = where ? ` in ${where}` : "";
      // A successor is only worth saying back once there is a first task for it
      // to follow -- "then" with nothing before it has no clause to hang off.
      const then = task ? asClause(session.then) : "";
      const tail = then ? `, then ${then}` : "";
      return task ? `Start a session${place} to ${task}${tail}.` : `Start a session${place}.`;
    }
    if (verb === "tell") {
      const who = name || where;
      if (!who) return null;
      return task ? `Tell ${who} to ${task}.` : null;
    }
    if (verb === "stop") {
      const who = name || where;
      return who ? `Stop ${who}.` : null;
    }
    // verb=read is deliberately not describable, which is what makes it run
    // without a confirmation. This module exists because start, tell and stop
    // reach a real process and a misheard sentence must not be able to move one;
    // a read touches nothing, and holding "what did jarvis three do?" for a
    // "Shall I, sir?" would put a spoken round trip in front of every question
    // someone asks about their own work. Returning null here is the mechanism --
    // describeIntent gives back null, propose declines to hold it, and the
    // dispatcher runs it and speaks the answer.
    return null;
  }

  if (action) {
    const what = buildName(primitive?.id ?? action.primitive);
    if (!what) return null;
    // The first answered question is the subject of the build, and saying it
    // back is the difference between confirming "a landing page" and
    // confirming the landing page someone actually asked for.
    const subject = asClause(action.params?.subject ?? action.params?.topic, 80);
    return subject ? `Build ${what} for ${subject}.` : `Build ${what}.`;
  }

  return null;
}

// An answer to "Shall I, sir?" is short. Anything longer is carrying something
// the answer vocabulary cannot see -- and the sentence that made this necessary
// is exactly that shape: "no, the whole repo, not just the README" reads as a
// flat refusal to parseYesNo, which would drop the correction on the floor and
// make the person say it twice.
//
// Four words covers what people actually answer with ("yes", "go ahead", "yes
// that's fine", "not now") and stops well short of a sentence. Being wrong here
// costs a re-proposal, never an action nobody asked for.
export const MAX_ANSWER_WORDS = 4;

// readAnswer(text) -> "yes" | "no" | "amend"
//
// The vocabulary is parseYesNo's, unchanged -- it was written and tested for
// deciding whether a `git push` happens, and this is the same job. What differs
// is what anything else means here: not a re-ask, but a correction.
//
// That is what makes the loop worth having. A correction is not a refusal and
// not an approval; it is the next turn, and the warm CLI still holds its own
// proposal in context, so it re-proposes correctly with no machinery at all.
export function readAnswer(text) {
  const words = cleanText(text, 300).split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_ANSWER_WORDS) return "amend";
  const answer = parseYesNo(text);
  return answer === "unclear" ? "amend" : answer;
}

// Whether a proposal made at `at` may still be answered.
export function isAnswerable(at, now = Date.now(), ttlMs = PROPOSAL_TTL_MS) {
  if (!Number.isFinite(at)) return false;
  return now - at < ttlMs;
}
