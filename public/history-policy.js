// What was said in this tab, and which of it the caption is showing.
//
// The caption is one line: the sentence being spoken, or the last thing Dante
// said. This module remembers the finished lines so a person can step back
// through them. It is a flat timeline rather than user/reply pairs, because
// the flow does not pair: one utterance can end in nothing captured, in one
// reply, or in a clarifying question followed by more turns, and a watcher
// firing arrives with no utterance at all. One entry per finished line, one
// step per entry.
//
// Interim transcription never enters here. It rewrites the caption ten times
// per utterance, and none of those rewrites is a thing anyone will step back
// to. The tab records the text it sent on release instead.
//
// State is a plain object and every function returns a new one, so app.js can
// treat it like the other policy modules. `cursor` is null when the view is
// live (showing the newest entry as it arrives) and an index into `entries`
// when a person has stepped back.

export const HISTORY_CAP = 200;

export function createHistory() {
  return { entries: [], cursor: null };
}

// A plain reply that arrives while someone is reading an older line does not
// yank them: it is appended and the newer button lights. An entry that demands
// attention -- a clarifying question, which needs answering, or an error,
// which is the line you step back to diagnose -- always snaps the view to
// newest, whatever was being read.
export function append(state, { who, text, at, demandsAttention = false } = {}) {
  if (typeof text !== "string" || !text.trim()) return state;
  const entries = [...state.entries, { who, text, at, demandsAttention: Boolean(demandsAttention) }];
  let cursor = state.cursor;
  if (entries.length > HISTORY_CAP) {
    entries.shift();
    // The dropped entry sat at index 0, so everything a cursor pointed at moved
    // down one. A cursor on the dropped entry itself lands on the new oldest.
    if (cursor !== null) cursor = Math.max(0, cursor - 1);
  }
  if (cursor !== null && demandsAttention) cursor = null;
  return { entries, cursor };
}

export function stepOlder(state) {
  const { entries, cursor } = state;
  if (entries.length < 2) return state;
  const shown = cursor === null ? entries.length - 1 : cursor;
  if (shown === 0) return state;
  return { entries, cursor: shown - 1 };
}

export function stepNewer(state) {
  const { entries, cursor } = state;
  if (cursor === null) return state;
  const next = cursor + 1;
  return { entries, cursor: next >= entries.length - 1 ? null : next };
}

export function snapToNewest(state) {
  return state.cursor === null ? state : { entries: state.entries, cursor: null };
}

export function view(state) {
  const { entries, cursor } = state;
  const live = cursor === null;
  const shown = live ? entries.length - 1 : cursor;
  const entry = entries[shown] || null;
  return {
    live,
    entry: entry ? { who: entry.who, text: entry.text, at: entry.at } : null,
    canOlder: shown > 0,
    canNewer: !live,
    index: entry ? shown + 1 : 0,
    total: entries.length,
  };
}

// Mirrors getVisibilityToggle: nothing while the talk key is down, so a stray
// arrow mid-sentence does not move the view the interim text is about to
// overwrite anyway.
export function historyStep(key, holding) {
  if (holding) return null;
  if (key === "ArrowLeft") return "older";
  if (key === "ArrowRight") return "newer";
  return null;
}

export function formatTime(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
