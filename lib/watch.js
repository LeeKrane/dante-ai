// A watcher: "tell me when this session stops working." Each one names
// exactly one running session, and fires exactly once -- the moment that
// session goes from working to anything else -- then removes itself. State
// lives in memory only and is never written to disk: nothing here survives a
// restart, and a Dante that just restarted has plainly stopped watching
// whatever it was watching before.
//
// Split the way the rest of lib/ is split: everything here is pure except
// the tiny registry createWatchers returns, which is the one stateful thing
// this module owns (the same split lib/memory.js's queue and chain table
// keep). Who may be watched, what a tick finds, and how a cancellation
// resolves are all logic, not wiring, and belong on the testable side of
// that line.

import { countWord, isWorking, matchSessions } from "./agents.js";
import { doThisFirstClause } from "./notify.js";
import { MAX_READ_CHARS } from "./transcript.js";

// However many sessions Dante can plausibly be asked to keep an eye on at
// once. Past this, one more "Shall I, sir?" is a promise it cannot actually
// keep track of -- the fix is cancelling one, not raising this number.
export const MAX_WATCHERS = 5;

// The question readSession is asked once a watcher fires. Not readSession's
// own default ("what did this session do, and what did it produce?") --
// a watcher exists because someone walked away mid-task, so what the session
// is waiting on now (a permission prompt, nothing at all) is as much the
// answer as what it produced.
export const WATCH_QUESTION =
  "What did this session just do, what did it produce, and what, if anything, is it waiting on now?";

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

// The same cleaning lib/confirm.js's cleanText does. Not imported from there
// -- that helper is not exported, and four lines duplicated here is cheaper
// than opening a module boundary neither side otherwise needs.
function cleanText(value, maxChars) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

// A roster record can carry `name: null`, and a sentence with a hole where
// the name goes is worse than one that says "that session" -- the same
// fallback lib/verdict.js's own subject() uses.
function subject(name) {
  return typeof name === "string" && name ? name : "that session";
}

// refuseWatch(record, watchers) -> the sentence a watch proposal must be
// refused with, or null when it may proceed. Order matters: each check
// assumes the ones above it already passed, and every reason is specific to
// why a promise about THIS session cannot be made.
export function refuseWatch(record, watchers) {
  if (!record) return "That session is no longer running, sir.";
  // Checked right after the missing-record refusal, before anything else: the
  // spoken report and a later cancel both need a real name to say, and
  // "watching that session, sir" is indistinguishable from any other session
  // with no name -- confirming it would be a promise that cannot be told
  // apart from a different one moments later.
  if (typeof record.name !== "string" || record.name === "") {
    return "I cannot watch a session with no name, sir.";
  }
  const name = record.name;
  if (watchers.has(record.sessionId)) return `I am already watching ${name}, sir.`;
  // A watcher only ever fires on working -> anything else. A session that is
  // not working right now would never cross that line, and confirming a
  // watch on it would be a promise nothing is ever going to keep.
  if (!isWorking(record)) return `${name} is not working just now, sir, so there is nothing to wait for.`;
  if (watchers.size() >= MAX_WATCHERS) {
    return `I am already watching ${countWord(watchers.size())} sessions, sir. Cancel one first.`;
  }
  return null;
}

// createWatchers() -> { add, cancel, has, size, names, list, tick }
//
// The one stateful thing in this module: a Map keyed by sessionId, held at
// module scope by the caller (server.js) rather than per-conversation -- a
// watcher has to outlive the tab that created it, the same reason the queue
// and the chain table in lib/memory.js do.
export function createWatchers() {
  const watches = new Map();

  return {
    // add({ sessionId, name, cwd, task, state }, now) -> boolean. Refuses
    // (returns false, never throws) a sessionId that is not a non-empty
    // string, one already present, or a watch that would push past
    // MAX_WATCHERS -- enforced here too, not only in refuseWatch, so a
    // caller that reaches this without going through the confirmation gate
    // still cannot exceed the cap.
    add(record, now) {
      const sessionId = record?.sessionId;
      if (typeof sessionId !== "string" || sessionId === "") return false;
      if (watches.has(sessionId)) return false;
      if (watches.size >= MAX_WATCHERS) return false;
      watches.set(sessionId, {
        sessionId,
        name: record.name,
        cwd: record.cwd,
        task: record.task,
        at: now,
        state: record.state,
        // The session kind Dante started this session with, when there was
        // one -- carried through so a fired watch can gate its own
        // do-this-first line on speaksVerdict the same way reportComplete
        // does, rather than reading every watched session's transcript as an
        // authoritative verdict.
        kindId: record.kindId ?? null,
      });
      return true;
    },

    // cancel(sessionId) -> the removed watch, or null when there was none.
    cancel(sessionId) {
      const watch = watches.get(sessionId);
      if (!watch) return null;
      watches.delete(sessionId);
      return watch;
    },

    has(sessionId) {
      return watches.has(sessionId);
    },

    size() {
      return watches.size;
    },

    // Insertion order, for the machine-state line -- the same order a
    // roster numbers sessions in, oldest first. subject() stands in for a
    // null name so the WATCHING line always lists every watch, never a
    // blank item -- refuseWatch keeps a nameless record from ever being
    // added in the first place, but a watch already added before that
    // guard existed, or added directly in a test, should still read as a
    // sentence rather than an empty spot in the list.
    names() {
      return [...watches.values()].map((watch) => subject(watch.name));
    },

    // The raw watch records, insertion order. Not part of the surface the
    // spec for this module names, but cancelTarget below needs something to
    // match names() against, and this is that something -- exposed here
    // rather than duplicated as a second private map.
    list() {
      return [...watches.values()];
    },

    // tick(roster, now) -> [{ watch, change, record }], and every fired
    // watch is removed from the registry as it fires: a watcher exists to
    // say one thing once, and a second firing would be the same promise
    // kept twice.
    //
    // A non-array roster is a failed listing, not evidence that anything
    // ended -- diffRoster (lib/agents.js) treats a failed listing the same
    // way, for the same reason: a hiccup in `claude agents --json` must
    // never be read as "everything finished".
    tick(roster, now) {
      if (!Array.isArray(roster)) return [];
      const fired = [];
      for (const watch of watches.values()) {
        const record = roster.find((r) => r.sessionId === watch.sessionId) ?? null;
        let change = null;
        if (!record) {
          change = "gone";
        } else if (!isWorking(record)) {
          change = "idle";
        } else if (record.state === "blocked" && watch.state !== "blocked") {
          // isWorking() counts a blocked session as still working -- it is
          // still queued, still able to resume on its own -- but a session
          // sitting on a permission prompt has stopped working in every
          // sense that matters to someone waiting to be told, and that is
          // the sense a watcher exists for. Guarded by watch.state so a
          // watch created while the session was ALREADY blocked does not
          // fire the instant it is added: only a fresh transition into
          // blocked counts as news.
          change = "blocked";
        } else {
          watch.state = record.state;
        }
        if (change) {
          watches.delete(watch.sessionId);
          fired.push({ watch, change, record });
        }
      }
      return fired;
    },
  };
}

// resumedAmong(reported, roster) -> the sessionIds in `reported` (anything
// with a has()) that the roster now shows back at work: working, and not
// sitting on a permission prompt. server.js keeps a record of every session
// a watcher has already reported on, so the generic "complete" and
// "needs-attention" lines are not spoken again seconds after the watcher's
// own read-back. That record must not outlive the news it describes: a
// session that went blocked, was answered at the terminal, and is working
// again will block or finish again later, and those are fresh events; the
// same goes for one told to carry on after an idle report. A session seen
// working again is therefore the signal to forget the report, and this is
// the pure half of that sweep. A non-array roster is a failed listing and
// forgets nothing, the same rule tick() follows.
export function resumedAmong(reported, roster) {
  if (!Array.isArray(roster)) return [];
  const ids = [];
  for (const record of roster) {
    const id = record?.sessionId;
    if (!reported.has(id)) continue;
    if (isWorking(record) && record.state !== "blocked") ids.push(id);
  }
  return ids;
}

// cancelTarget(watchers, session) -> { watch, refusal }, exactly one of
// which is non-null. The pure resolution behind verb=unwatch, pulled out so
// it can be tested without a live registry -- the same reason findTarget
// lives in lib/confirm.js rather than in server.js.
//
// session.sessionId, when present, is checked first and resolves outright --
// the same rule findTarget follows, because it names the exact watch a
// caller already has in hand rather than something spoken -- and a sessionId
// that matches no watch refuses right there instead of falling through to
// name/no-name resolution: a stale id is not "no id given", and treating it
// as such could cancel an unrelated watch that happens to be the only one
// live. A name or repo is matched next, via matchSessions: it only ever
// reads `.name` off each candidate, and a watch record carries one, so the
// watch list can stand in for a roster with no translation needed.
// session.number is deliberately never consulted -- a number names a line on
// the CURRENT roster, and a session that has since finished or been
// renumbered may carry none, or the wrong one; a number-only tag is treated
// as no name given at all. Finally, with nothing named: exactly one watch
// resolves on its own, none is a plain refusal, and several is "which one".
export function cancelTarget(watchers, session = {}) {
  const list = watchers.list();

  // A sessionId is the exact watch a caller already has in hand, never
  // something spoken -- so a sessionId that names no watch here is a stale
  // id, not "no id given", and must refuse outright rather than fall through
  // to name/no-name resolution. Without this, a stale id sitting next to one
  // live watch would silently cancel that unrelated watch instead of saying
  // so: the no-name branch below would find "exactly one" and resolve it.
  if (typeof session.sessionId === "string" && session.sessionId !== "") {
    const watch = list.find((w) => w.sessionId === session.sessionId);
    return watch
      ? { watch, refusal: null }
      : { watch: null, refusal: "That session is no longer being watched, sir." };
  }

  const named = cleanText(session.name ?? session.repo, 100);
  if (named) {
    const matches = matchSessions(list, named);
    if (matches.length === 0) return { watch: null, refusal: `I am not watching ${named}, sir.` };
    if (matches.length > 1) {
      const names = matches.slice(0, 3).map((w) => subject(w.name)).join(", ");
      return { watch: null, refusal: `Which one, sir? ${names}.` };
    }
    return { watch: matches[0], refusal: null };
  }

  if (list.length === 0) return { watch: null, refusal: "I am not watching anything, sir." };
  if (list.length === 1) return { watch: list[0], refusal: null };
  const names = list.slice(0, 3).map((w) => subject(w.name)).join(", ");
  return { watch: null, refusal: `Which one, sir? ${names}.` };
}

export function watchVerdict({ name } = {}) {
  return `Watching ${subject(name)}, sir. I will tell you the moment it stops working.`;
}

export function unwatchVerdict({ name } = {}) {
  return `No longer watching ${subject(name)}, sir.`;
}

// describeFired({ name, change, state, text, reason, doThisFirst }) -> the
// spoken report a fired watcher makes, once. Always ends with "Ready for the
// next step, sir?" -- the report is not just information, it is the moment
// for the next instruction, and asking says so.
//
// `text` is what readSession actually read back, and it is never dropped in
// favour of a generic "it changed state" line: when it is empty, the reason
// readSession gave stands in for it instead, so the sentence still says
// something specific about why there is nothing to report.
//
// `doThisFirst` is the council's own next step -- see extractDoThisFirst in
// lib/transcript.js -- and only ever non-empty when server.js already gated
// it on the watched session's kind (speaksVerdict, lib/sessions.js) the same
// way reportComplete does. doThisFirstClause is the exact sentence
// formatSpoken appends to the generic "finished" line, shared here so a
// watcher's own report says it identically rather than in a second voice.
export function describeFired({ name, change, state, text, reason, doThisFirst } = {}) {
  const who = cleanText(name, 60) || "that session";
  const cleanedText = cleanText(text, MAX_READ_CHARS);
  const said = cleanedText
    || (reason === "no-transcript" ? "It left nothing I can read." : "I could not read what it produced.");
  const clause = doThisFirstClause(doThisFirst);
  const tail = clause ? ` ${clause}` : "";

  if (change === "gone") {
    return `${who} has finished, sir. ${said}${tail} Ready for the next step, sir?`;
  }
  if (change === "blocked") {
    return `${who} is blocked, sir, waiting on a permission prompt. ${said}${tail} Ready for the next step, sir?`;
  }

  // idle. The state word is spoken only when it is short and plain enough to
  // actually be a word ("done", "idle") rather than something a future CLI
  // value would land in the ear as jargon -- the same caution lib/agents.js's
  // own activity() takes with an unrecognised status.
  // Capped generously here, not at 20 -- the regex below is what enforces
  // the 20-character ceiling, and it must see the value UNTRUNCATED to
  // reject an overlong one rather than have cleanText quietly shorten it
  // into something that happens to pass.
  const cleanedState = cleanText(state, 100).toLowerCase();
  const stateClause = /^[a-z-]{1,20}$/.test(cleanedState) ? `; it is ${cleanedState} now.` : ".";
  return `${who} has stopped working, sir${stateClause} ${said}${tail} Ready for the next step, sir?`;
}

// watchingLine(names) -> the WATCHING line for the machine-state block, or ""
// when nothing is being watched -- the same opt-in shape the roster and
// interview lines take in lib/turns.js, so a turn with no watchers is
// byte-identical to one before this module existed.
export function watchingLine(names) {
  const list = Array.isArray(names) ? names.filter((n) => typeof n === "string" && n) : [];
  if (list.length === 0) return "";
  return `WATCHING: ${list.join(", ")} - you will be told the moment each stops working.`;
}
