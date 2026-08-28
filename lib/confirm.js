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
import { countWord, matchSessions } from "./agents.js";

// A proposal is answered in the next breath or not at all. Past this it is not
// answerable: a "yes" ten minutes later is agreeing to something the person has
// long stopped thinking about, and it would start a real process.
export const PROPOSAL_TTL_MS = 120_000;

// Long enough to say what the work is, short enough to be one spoken sentence.
export const MAX_TASK_CHARS = 140;
export const MAX_NAME_CHARS = 60;

// The four verbs that reach a live process. verb=read is deliberately absent
// -- see the comment on it inside describeBody below, which is the actual
// reasoning: a read touches nothing, so nothing there needs a "Shall I, sir?"
// in front of it. recap is absent for the same reason (and its own comment,
// further down).
export const CONFIRMED_VERBS = new Set(["start", "tell", "interrupt", "stop"]);

export function needsConfirmation(session) {
  const verb = typeof session?.verb === "string" ? session.verb.toLowerCase() : "";
  return CONFIRMED_VERBS.has(verb);
}

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

// However many sessions could plausibly ever be numbered -- MAX_LISTED
// (lib/agents.js) is fifteen -- with enormous headroom so this is never the
// thing that refuses a legitimate number. It exists only to stop a value that
// technically passes Number.isInteger from reaching countWord's fallback:
// Number.isInteger(1e21) is true, and a spoken refusal would then say "There
// is no session 1e+21, sir." rather than treating an absurd value as the
// unparseable one it obviously is.
const MAX_SESSION_NUMBER = 999;

// parseSessionNumber(value) -> a positive integer no larger than
// MAX_SESSION_NUMBER, or null.
//
// The tag arrives as text ("3", from `number="3"` in a machine tag) but a
// caller resolving a record already pulled off the roster may have the
// integer in hand instead, so both are accepted. Anything else -- "0", a
// negative number, "3a", a float, a number too large to be a real position --
// is refused: zero and negative are not positions on a 1-based list, and a
// partial or oversized match is not a number Jesse actually said.
export function parseSessionNumber(value) {
  if (Number.isSafeInteger(value) && value > 0 && value <= MAX_SESSION_NUMBER) return value;
  if (typeof value === "string") {
    // 1-3 digits only, which caps the string form at 999 the same way the
    // numeric branch above does, with no separate size check needed.
    const trimmed = value.trim();
    if (/^[1-9][0-9]{0,2}$/.test(trimmed)) return Number(trimmed);
  }
  return null;
}

// findTarget(roster, query, { number, sessionId }) -> { record, refusal },
// exactly one of which is non-null. The pure half of server.js's
// resolveSession: matching a spoken name (or a numbered line, or an exact
// process already in hand) against the roster and choosing the sentence for
// each outcome is logic, not wiring, and belongs on this side of the line
// where it can be tested without a live process behind it.
//
// The roster-readable check moves above every path -- sessionId, number, and
// name: a listing that failed is "I cannot see what is running" whichever way
// the session was addressed, not just when it was addressed by name.
export function findTarget(roster, query, { number, sessionId } = {}) {
  // null is "I could not ask", not "nothing is running". Saying "I do not
  // know a session by that name" of a session that exists is worse than
  // admitting the listing failed -- especially for stop, where the next thing
  // the person does is try again louder.
  if (!Array.isArray(roster)) {
    return { record: null, refusal: "I cannot see what is running just now, sir." };
  }

  // A sessionId wins over everything else, and is checked first: it is not
  // something Jesse ever says, it is server.js re-targeting the exact process
  // a proposal already resolved once (see proposeSession's own comment on why
  // the number is cleared for this second lookup) -- so it must never be
  // second-guessed by a name or a number that happens to also be on the tag.
  // "No longer running" rather than a not-found sentence built for a name or
  // a number: this is the one path where the caller already knows exactly
  // which session it meant and is only confirming it is still there.
  if (typeof sessionId === "string" && sessionId !== "") {
    const record = roster.find((r) => r.sessionId === sessionId);
    return record
      ? { record, refusal: null }
      : { record: null, refusal: "That session is no longer running, sir." };
  }

  // A number is exclusive, never a fallback to the name: "session three" means
  // the line marked three, full stop. Falling back to a name that happens to
  // also be on the tag would let a model that guessed wrong about the number
  // still land on a session by name, which defeats the whole point of asking
  // for the number in the first place -- a resolution nobody actually meant.
  //
  // Branched on RAW presence (undefined/null means no number key was on the
  // tag at all), not on whether it parsed: `number="3a"` is an addressing
  // attempt that garbled, not "no number, try the name instead" -- falling
  // through on a parse failure would make the exclusivity above pointless the
  // moment a number is merely malformed rather than absent.
  if (number !== undefined && number !== null) {
    const wanted = parseSessionNumber(number);
    if (wanted === null) return { record: null, refusal: "I did not catch which session, sir." };
    const record = roster.find((r) => r.number === wanted);
    if (record) return { record, refusal: null };
    const count = roster.length === 0 ? "none" : countWord(roster.length);
    return {
      record: null,
      refusal: `There is no session ${countWord(wanted)}, sir. I count ${count}.`,
    };
  }

  const named = cleanText(query, 100);
  if (!named) return { record: null, refusal: "Which session, sir?" };

  const matches = matchSessions(roster, named);
  if (matches.length === 0) {
    // `named` rather than the record name, because there is no record: this
    // has to read correctly both before a proposal is made and after a yes,
    // when the session it named has since gone.
    return { record: null, refusal: `I cannot find ${named} running, sir.` };
  }
  if (matches.length > 1) {
    // Never the first of several, and never by position: "the third one" is
    // precisely the sentence that gets misheard.
    const names = matches.slice(0, 3).map((record) => record.name).join(", ");
    return { record: null, refusal: `Which one, sir? ${names}.` };
  }
  return { record: matches[0], refusal: null };
}

// readTarget(roster, candidates, session) -> { record, refusal }.
//
// dispatchRead's own resolution, pulled out of server.js so the number-then-
// name sequence is logic that can be tested without a live roster or a real
// transcript on disk -- the same reason findTarget lives here rather than in
// server.js.
//
// It reads from a different list than it resolves a number against: a number
// only ever names a session still on the current roster tick (a finished one
// carries none, since it fell off the roster entirely), so that half goes
// through findTarget against the live `roster`. What dispatchRead actually
// needs back -- task, running -- lives in `candidates`
// (recallableSessions' own shape) instead, keyed by the same sessionId, which
// is why the live record findTarget resolves is re-keyed into that list
// rather than used directly. Addressing by name goes against `candidates`
// from the start: a finished session is exactly what "what did
// fix-failing-builder-test come up with" is usually asking about, and that
// session has already left `roster` (and its number along with it).
export function readTarget(roster, candidates, session = {}) {
  const list = Array.isArray(candidates) ? candidates : [];

  // Raw presence, the same convention findTarget itself uses: a garbled
  // number ("3a") is an addressing attempt that failed, not "no number, try
  // the name instead," and findTarget already refuses that case by itself.
  if (session.number !== undefined && session.number !== null) {
    const { record: live, refusal } = findTarget(roster, "", { number: session.number });
    if (refusal) return { record: null, refusal };
    // A live record just off the roster has no transcript check behind it --
    // recallableSessions is what confirms one exists on disk -- so a session
    // findTarget resolves can still come back absent here: started this very
    // tick, with nothing written yet. Refused rather than read, the same as a
    // name that resolves to nothing readable.
    const record = list.find((c) => c.sessionId === live.sessionId);
    return record
      ? { record, refusal: null }
      : { record: null, refusal: "I have nothing readable by that number, sir." };
  }

  // matchSessions rather than findTarget for the name path: every session
  // named this way may have already left the live roster, and matchSessions
  // works on anything carrying a name, live or finished alike.
  const matches = matchSessions(list, session.name ?? session.repo);
  if (matches.length === 0) {
    return { record: null, refusal: "I have nothing readable by that name, sir." };
  }
  if (matches.length > 1) {
    // Never the first of several. Reading the wrong session's work back is a
    // quieter mistake than stopping the wrong process, but it is still an
    // answer about work that was never done.
    const names = matches.slice(0, 3).map((record) => record.name).join(", ");
    return { record: null, refusal: `Which one, sir? ${names}.` };
  }
  return { record: matches[0], refusal: null };
}

// clarify(intent) -> the question to ask when a confirmable tag cannot be
// described, so that turn is never dispatched unconfirmed -- it is asked
// about instead. In practice only one tag reaches here: a tell whose session
// resolved but which carries no task, one missing detail away from a sentence,
// so the detail is asked for by name. A start always describes, and an
// interrupt or stop that got past findTarget has a name to say. The generic
// question underneath is what a caller hears if that ever stops being true --
// a question rather than a dispatch, which is the whole point of this function.
export function clarify({ session, target } = {}) {
  const verb = typeof session?.verb === "string" ? session.verb.toLowerCase() : "";
  if (!CONFIRMED_VERBS.has(verb)) return null;

  if (verb === "tell") {
    const name = cleanText(session?.name, MAX_NAME_CHARS);
    const where = cleanText(session?.repo, 40);
    // The session Dante resolved beats the one the model wrote, same as
    // describeBody below -- it is the name that will actually be told.
    const who = cleanText(target?.name, MAX_NAME_CHARS) || name || where;
    if (who) return `What should I tell ${who}, sir?`;
  }
  return "Which session, sir?";
}

// describeIntent(intent) -> the sentence to say, or null when there is nothing
// describable. What null means depends on the tag: a build is dispatched as
// before and the dispatcher explains itself, while a start, tell, interrupt or
// stop is asked about instead (see clarify above), since those four must never
// run unconfirmed. Never invent a description for a tag that cannot be read: a
// confirmation nobody understands is worse than none.
export function describeIntent(intent = {}) {
  const body = describeBody(intent);
  return body ? `${body} Shall I, sir?` : null;
}

// Who a tell, interrupt or stop names in the spoken sentence. When the tag
// addressed the session by number, the confirmation says the number back --
// "session three" is what was said, and the ordinary rule elsewhere in this
// module (say back exactly what will run) applies here too -- with the
// resolved name appended when there is one, since "session three, bug-hunt"
// is more useful than the number alone and costs nothing extra to say.
// Otherwise this is unchanged: the resolved name, then the one the model
// wrote, then the repository, whichever is the first that exists.
function whoFor(session, { resolved, name, where } = {}) {
  const number = parseSessionNumber(session?.number);
  if (number !== null) {
    const known = resolved || name;
    return known ? `session ${countWord(number)}, ${known}` : `session ${countWord(number)}`;
  }
  return resolved || name || where;
}

function describeBody({ session, action, primitive, workspace, target } = {}) {
  if (session) {
    const verb = typeof session.verb === "string" ? session.verb.toLowerCase() : "";
    // The alias Dante resolved beats the one the model wrote: they can differ,
    // and the resolved one is where the session will actually run.
    const where = cleanText(workspace?.alias ?? session.repo, 40);
    const task = asClause(session.task ?? session.text ?? session.message);
    const name = cleanText(session.name, MAX_NAME_CHARS);
    // Same reasoning as the workspace alias above: `target` is the roster
    // record findTarget actually resolved, and its name is where the tell,
    // interrupt or stop will actually land, which can differ from what the
    // model wrote (a prefix, a stale case, a repo-qualified form).
    const resolved = cleanText(target?.name, MAX_NAME_CHARS);
    // A brief is several sentences written for the session, and it is shown on
    // the page verbatim rather than read aloud here: the confirmation stays one
    // breath long, and what IS spoken is still built from the tag, which is the
    // property this module exists for. The sentence only says the brief exists.
    const withBrief = cleanText(session.brief, 40) ? ", with the brief on screen" : "";

    if (verb === "start") {
      const place = where ? ` in ${where}` : "";
      // A successor is only worth saying back once there is a first task for it
      // to follow -- "then" with nothing before it has no clause to hang off.
      const then = task ? asClause(session.then) : "";
      const tail = then ? `, then ${then}` : "";
      return task ? `Start a session${place} to ${task}${tail}${withBrief}.` : `Start a session${place}${withBrief}.`;
    }
    if (verb === "tell") {
      const who = whoFor(session, { resolved, name, where });
      if (!who) return null;
      return task ? `Tell ${who} to ${task}${withBrief}.` : null;
    }
    if (verb === "interrupt") {
      const who = whoFor(session, { resolved, name, where });
      if (!who) return null;
      // Unlike tell, a task-less interrupt still gets a sentence: dropping
      // whatever a session is doing is a meaningful act on its own, and a
      // confirmation someone can answer beats silently dispatching it - the
      // same reasoning stop follows below.
      return task ? `Interrupt ${who} and tell it to ${task}${withBrief}.` : `Interrupt ${who}${withBrief}.`;
    }
    if (verb === "stop") {
      const who = whoFor(session, { resolved, name, where });
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
