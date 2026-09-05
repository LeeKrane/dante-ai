// What Dante says once a session command has actually run, and how sure it is
// allowed to sound.
//
// Three things can be true after a start, a tell, an interrupt or a stop, and
// the sentence has to tell them apart out loud:
//
//   proposed  - nothing has happened yet ("... Shall I, sir?", lib/confirm.js)
//   attempted - something was sent and nothing reports back what came of it
//   verified  - Dante checked, and can say what is now the case
//
// This module owns the second and third. The failure it exists for is real: a
// stop was reported as "stopped" because the pid it signalled went away, and
// the session was still on the roster two minutes later under another process.
// A sentence built from the signal alone was a claim; the sentence has to be
// built from what the roster says afterwards, and when the roster could not be
// read, it has to say that instead of guessing either way.
//
// Everything here is pure: the caller does the re-read and passes in what it
// found. `listed` is three-valued on purpose -- true, false, or null for "the
// listing could not be taken" -- because "I could not check" and "it is gone"
// are opposite answers to someone who just asked for a session to stop.

// isListed(roster, sessionId) -> true | false | null
//
// null when there is no roster to consult, which createRosterPoller's fresh()
// returns for a listing that failed. A missing sessionId is never "listed":
// nothing to look for cannot be found.
export function isListed(roster, sessionId) {
  if (!Array.isArray(roster)) return null;
  if (typeof sessionId !== "string" || sessionId === "") return false;
  return roster.some((record) => record && record.sessionId === sessionId);
}

// A roster record can carry `name: null` (lib/agents.js's parseRoster keeps
// such records on purpose), and a sentence with a hole where the name goes is
// worse than one that says "that session".
function subject(name) {
  return typeof name === "string" && name ? name : "that session";
}

// stopVerdict({ name, result, listed }) -> { spoken, stopped }
//
// `result` is stopSession's answer, `listed` is whether the session is still
// on a roster taken AFTER that answer. `stopped` is the only thing the caller
// may act on -- the recap's "stopped from here" marker and the dropped queue
// both depend on the session really being gone, so neither happens on a
// signal that landed but did not take, or on a check that could not be made.
export function stopVerdict({ name, result, listed } = {}) {
  const who = subject(name);
  if (!result || result.ok !== true) {
    const why = typeof result?.error === "string" && result.error ? ` ${result.error}.` : "";
    return { spoken: `I could not stop ${who}, sir.${why}`, stopped: false };
  }
  if (listed === true) {
    // The process the roster named is gone and the session is not. That is
    // exactly the shape a daemon-managed session takes when its worker is
    // signalled and the daemon hands the session to another one.
    return {
      spoken: result.alreadyGone
        ? `${who}'s process was already gone, sir, but it is still on the roster.`
        : `The stop went to ${who}, sir, but it is still on the roster.`,
      stopped: false,
    };
  }
  if (listed === null) {
    return { spoken: `The stop went to ${who}, sir, but I could not check that it took.`, stopped: false };
  }
  return {
    spoken: result.alreadyGone ? `${who} had already finished, sir.` : `${who} is stopped, sir.`,
    stopped: true,
  };
}

// tellVerdict({ name, verb, channel, reply }) -> spoken
//
// `channel` is which of dispatchTell's three deliveries carried it:
//
//   "peer"   - written into the live session's socket. The CLI acknowledges
//              nothing for a user frame, so this is an attempt and the sentence
//              says so; "has it" was the old wording and it claimed more than
//              anything here can know.
//   "queued" - not sent at all yet; the roster poller delivers it on the first
//              idle tick. Said plainly, because "queued" and "sent" are
//              different promises and the difference is minutes.
//   "resume" - the older fork-and-resume path, which runs the session to
//              completion and returns its reply. The reply IS the verification:
//              the session answered. Without one, it ran and said nothing.
export function tellVerdict({ name, verb, channel, reply } = {}) {
  const who = subject(name);
  if (channel === "queued") return `${who} is busy, sir. I will pass it on when it stops.`;
  if (channel === "resume") {
    return typeof reply === "string" && reply.trim() ? reply.trim() : `${who} took it, sir, and said nothing back.`;
  }
  const sent = verb === "interrupt" ? `Interrupt sent to ${who}, sir.` : `Sent to ${who}, sir.`;
  return `${sent} I cannot confirm it was read.`;
}

// startVerdict({ name, listed, overriddenKind }) -> spoken
//
// startSession's ok means the CLI was still alive when the startup window
// closed, which is a real check but a check of the process, not of the
// session. "Running as" is kept for the case the roster then agrees; the other
// two say what was and was not seen, and neither pretends.
//
// `overriddenKind` is the id of the kind whose own composed prompt lost to an
// explicit command= (see recordedKind in lib/sessions.js) -- a session that
// silently ran something other than what the kind would have said. Server.js
// used to only log() that, never speak it, which left a person who said
// "brainstorm this" with a command= override hearing nothing different from
// an ordinary start. Appended rather than folded into the three sentences
// above so a caller that never overrides anything (every kind-less start,
// and every kind with no `prompt` hook) reads exactly as it always did.
export function startVerdict({ name, listed, overriddenKind } = {}) {
  const who = subject(name);
  const base = listed === true
    ? `Running as ${who}.`
    : listed === null
    ? `Started as ${who}, sir, but I could not check the roster.`
    : `Started as ${who}, sir. It is not on the roster yet.`;
  if (!overriddenKind) return base;
  // Every branch above ends in a period; replaced with a comma so the clause
  // reads as one sentence rather than a fragment tacked on after a full stop.
  return `${base.slice(0, -1)}, the command replaced the ${overriddenKind} prompt.`;
}
