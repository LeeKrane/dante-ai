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
// Every new line pulls the view back to newest. A gentler rule -- let a plain
// reply land quietly while someone reads an older line, snap only for a
// question or an error -- was tried and dropped: every spoken line reaches
// the tab as the same reply_text, so the tab cannot tell "Allow?" from an
// answer, and a question it did not pull into view is a question that goes
// unanswered. Being pulled away is recoverable with one press; missing a
// question is not.
//
// State is a plain object and every function returns a new one, so app.js can
// treat it like the other policy modules. `cursor` is null when the view is
// live (showing the newest entry as it arrives) and an index into `entries`
// when a person has stepped back.

export const HISTORY_CAP = 200;

export function createHistory() {
  return { entries: [], cursor: null };
}

export function append(state, { who, text, at } = {}) {
  if (typeof text !== "string" || !text.trim()) return state;
  const entries = [...state.entries, { who, text, at }];
  if (entries.length > HISTORY_CAP) entries.shift();
  return { entries, cursor: null };
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
    entry,
    canOlder: shown > 0,
    canNewer: !live,
    index: entry ? shown + 1 : 0,
    total: entries.length,
  };
}

// Mirrors getVisibilityToggle: nothing while the talk key is down, so a stray
// arrow mid-sentence does not move the view the interim text is about to
// overwrite anyway. A modified arrow is the browser's (Alt+Left is Back) or
// the text's (Shift+Left extends a selection), never a step.
export function historyStep(key, holding, modified = false) {
  if (holding || modified) return null;
  if (key === "ArrowLeft") return "older";
  if (key === "ArrowRight") return "newer";
  return null;
}

export function formatTime(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
