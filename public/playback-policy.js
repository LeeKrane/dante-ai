// When Dante may be interrupted, and where the orb lands when he is.
//
// One of the pure client modules (see the others under public/*-policy.js):
// browser-safe, no DOM, imported by app.js and the tests. app.js touches the
// DOM on its first line and can never be unit-tested, so every decision that
// can be phrased as a function is phrased here instead.

import { retainAnnouncement } from "./attention-policy.js";

// The five states the orb knows. Exported because the handoff a clip carries
// arrives off the wire and has to be checked against something.
export const ORB_STATES = new Set(["idle", "listening", "thinking", "working", "speaking"]);

// canStartListening(state, holding, hasRecognizer)
//
// No state refuses the button any more, which is the whole point: whatever
// Dante is doing, the person gets to talk. A clip being spoken is cancelled by
// the press; a turn still being thought about is superseded by the server, which
// abandons it and folds what was said into the call that replaces it
// (lib/turns.js). Both are the same promise — whoever spoke last has the floor.
//
// `state` is kept in the signature deliberately. This is the one place that
// decides when the button is dead, and the honest answer being "never" is worth
// stating once rather than discovering by reading a call site.
export function canStartListening(state, holding, hasRecognizer) {
  if (!hasRecognizer) return false;
  return !holding;
}

// stateAfterClip(handoff) -> the state the orb takes when a clip stops, whether
// it finished on its own or was cancelled.
//
// A clip can hand the orb to a state instead of ending the turn: the build
// confirmation lands in "working" so the HUD picks up exactly when the voice
// stops. That handoff comes off the WebSocket, so it is checked against
// ORB_STATES rather than passed into setState on trust — an unknown value would
// be written to the screen and looked up in the orb's palette.
export function stateAfterClip(handoff) {
  return ORB_STATES.has(handoff) ? handoff : "idle";
}

// handoffAfterPreempt(cut, incoming) -> the handoff the clip now starting carries.
//
// A clip that arrives while another is audible cuts it off: whoever spoke last
// holds the floor, which is the same rule the record button (stage 12) and the
// turn gate (stage 13) already follow. Two clips really can land together — a
// build's spoken result is deliberately not gated by the turn that superseded
// the conversation, so a done-line and a chat reply can arrive in the same
// second, and both are legitimate.
//
// The subtlety is the handoff, not the audio. The build kickoff line carries
// "working" and the build is genuinely running by the time it is spoken; a reply
// that pre-empts it and lands on idle as usual would leave the HUD of a live
// build never started. So an incoming clip with no handoff of its own inherits
// the one it cut off. This is the opposite of what the record button does with a
// handoff, and deliberately: there setState follows two lines later, whereas the
// pre-empting clip IS the next setState.
//
// Both values arrive off the WebSocket, so neither is inherited on trust.
export function handoffAfterPreempt(cut, incoming) {
  if (ORB_STATES.has(incoming)) return incoming;
  return ORB_STATES.has(cut) ? cut : null;
}

// shouldShowCancel(playing, chromeHidden)
//
// The button offers to stop a clip, so it appears exactly while a clip is
// audible and not one moment longer. Driven by whether a source is actually
// playing rather than by the orb's state: "speaking" is set just before
// src.start(), and a button offering to stop something that has not started is
// a button that does nothing when pressed.
//
// `chromeHidden` is the interface hidden with `h`. CSS hides #controls with the
// rest of it, but a button that is only invisible is still focusable and still
// answers the keyboard, and a control nobody can see must not be one they can
// still press.
export function shouldShowCancel(playing, chromeHidden) {
  return Boolean(playing) && !chromeHidden;
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------
//
// A session finishing while nobody asked anything is the first thing Dante has
// to say that nobody is waiting for. The recap log always gets it, durably;
// speaking it is the convenience, and a convenience does not get to interrupt.
//
// So an announcement never barges in. It waits for the floor to be genuinely
// free and is dropped rather than spoken stale -- two minutes later "jarvis-1
// has finished" is not news, and it is already in the recap log for whenever
// anyone asks. Approval requests are the exception and do not come through
// here at all: something is blocked on those, so they are spoken the moment
// they arrive.

// How long an announcement is worth saying. Long enough to survive one reply
// and a follow-up question, short enough that nothing is ever announced about a
// session the person has stopped thinking about.
export const ANNOUNCEMENT_TTL_MS = 120_000;

// A backlog this deep means a long walk away, and the tail of it is history
// rather than news. The recap log has all of it in order.
export const MAX_QUEUED_ANNOUNCEMENTS = 5;

// The three states that mean someone is mid-exchange. "working" is deliberately
// absent: a build running in the background is not a conversation, and holding
// an announcement until it lands would be holding it for minutes.
const BUSY_STATES = new Set(["listening", "thinking", "speaking"]);

// floorIsFree(floor) -> whether an unprompted line may be spoken right now.
//
// Not during a reply, not while the mic is open, not while a question is
// waiting on an answer. Each of those is someone else's turn.
export function floorIsFree(floor = {}) {
  if (floor.holding || floor.listening || floor.playing || floor.awaitingAnswer) return false;
  return !BUSY_STATES.has(floor.state);
}

// queueAnnouncement(queue, item) -> the queue with it on the end, capped.
//
// Oldest out first: with a backlog, the recent endings are the ones worth
// hearing and the old ones are already in the recap log.
export function queueAnnouncement(queue, item, max = MAX_QUEUED_ANNOUNCEMENTS) {
  const list = Array.isArray(queue) ? queue.slice() : [];
  if (!item || typeof item.id !== "string" || !item.id) return list;
  list.push(item);
  return list.length > max ? list.slice(list.length - max) : list;
}

// takeAnnouncement(queue, floor, now) -> { speak, queue, dropped, stale }
//
// `speak` is the one to say now, or null. `queue` is what is left, always --
// callers assign it back unconditionally, because stale entries are swept
// here whether or not anything is spoken. Staleness is decided by
// retainAnnouncement (attention-policy.js), not a bare age check, so a
// watcher's blocked report survives here exactly as long as it survives on
// the server -- one rule, not two that could drift. `dropped` is how many
// went stale and `stale` is those entries themselves, so a cue can still be
// played for one of them even after it is gone from the queue (Commit 2).
export function takeAnnouncement(queue, floor = {}, now = Date.now(), ttlMs = ANNOUNCEMENT_TTL_MS) {
  const list = Array.isArray(queue) ? queue : [];
  const live = [];
  const stale = [];
  let droppedFalsy = 0;
  for (const item of list) {
    // A falsy entry is not "a stale announcement" -- there is nothing there
    // for a cue to play for -- so it is only counted, never handed back in
    // `stale` for a caller to iterate as if it were one.
    if (!item) {
      droppedFalsy++;
      continue;
    }
    if (retainAnnouncement(item, now, ttlMs)) live.push(item);
    else stale.push(item);
  }
  const dropped = stale.length + droppedFalsy;

  if (!floorIsFree(floor)) return { speak: null, queue: live, dropped, stale };
  const [next, ...rest] = live;
  return next
    ? { speak: next, queue: rest, dropped, stale }
    : { speak: null, queue: live, dropped, stale };
}

// clearAnnouncements(queue) -> { queue: [], dropped }
//
// A recap ("what happened while I was out") just said everything sitting in
// this queue, out loud, in one paragraph -- so leaving it queued would repeat
// it the moment the floor next comes free. The server clears its own pending
// map at the same time (see server.js's clear_announcements message); this is
// the client's half, kept pure and testable the same way every other
// announcement decision here is. `dropped` mirrors takeAnnouncement's shape so
// the diagnostics panel can say what happened rather than leaving a silence
// unexplained.
export function clearAnnouncements(queue) {
  const list = Array.isArray(queue) ? queue : [];
  return { queue: [], dropped: list.length };
}
