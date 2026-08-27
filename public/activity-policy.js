// What Dante is doing right now, painted under the status readout.
//
// The server already speaks a sentence about this ("I'll start a session in
// jarvis, sir"); this message is the same event read for the screen rather
// than the ear, sent as a bare `value` (plus whoever is involved) rather than
// a sentence, so the label can be worded for a glance instead of a breath.
//
// public/ is served straight off disk with no bundler, so this cannot import
// lib/confirm.js even though the cleaning below mirrors it closely -- see the
// comment at the top of roster-panel.js for the same constraint. The
// UNPRINTABLE class is confirm.js's own, copied rather than shared (written
// with braced \u{} escapes and the `u` flag so every codepoint stays a
// literal escape in this file rather than a raw control character).

export const MAX_SUBJECT_CHARS = 60;
// Mirrors lib/interview.js's MAX_BRIEF_CHARS by hand, since public/ cannot
// import lib/ -- see the comment at the top of this file. Keep the two in
// step if either changes.
export const MAX_BRIEF_CHARS = 6000;

// The seven things worth a word, plus the null the server sends when nothing
// is going on. Anything else is a value this page does not know yet, and
// guessing at a label for it would be worse than saying nothing.
const KNOWN_VALUES = new Set([
  "interviewing",
  "proposing",
  "starting",
  "telling",
  "interrupting",
  "stopping",
  "reading",
  "building",
]);

const UNPRINTABLE = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200e}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

// The same class, minus \n: a brief is shown pre-wrap, so its line breaks are
// the one piece of the model's own formatting worth keeping. \r and tabs are
// handled separately below rather than folded into this, since one is
// dropped and the other becomes a space rather than nothing.
const UNPRINTABLE_KEEP_NEWLINE = /[\u{0}-\u{9}\u{b}-\u{1f}\u{7f}-\u{9f}\u{200e}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

// A session name, repo alias or primitive id, written by whoever started the
// session -- untrusted text, so it is collapsed, stripped and capped the same
// way confirm.js caps everything it reads back to a person.
function cleanSubject(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, MAX_SUBJECT_CHARS);
}

// "landing-page" -> "landing page". Only a build's subject is a primitive id
// rather than a name someone chose, so only "building" reads its dashes and
// underscores as word breaks -- see buildName in lib/confirm.js for the
// sibling of this on the sentence that gets spoken.
function wordsFromId(subject) {
  return subject.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

// The full multi-sentence prompt a proposal is asking someone to approve.
// The spoken sentence only summarises it, so this is the one place it is
// shown in full -- capped, because it is still text nobody has approved yet.
// A hand-mirror of lib/interview.js's cleanBrief, not a shared import --
// public/ is served straight off disk with no bundler, so it cannot import
// lib/ (see the comment at the top of this file). Keep the two in step by
// hand if either changes: collapse a run of horizontal whitespace to one
// space, then drop a space left stranded right before a newline by that
// collapse, the same order lib/interview.js's version uses and for the same
// reason -- collapsing first turns a tab or a run of spaces into an ordinary
// space, and only then is there a single space to strip before the newline.
function cleanBrief(value) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/\r/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(UNPRINTABLE_KEEP_NEWLINE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, MAX_BRIEF_CHARS);
}

// describeActivity(msg) -> { label, detail }
//
// label is what sits under #status; detail is the brief, shown only while a
// proposal awaits an answer. Always exactly these two keys -- deepEqual is
// strict in this codebase's tests, so a wider shape would break every caller
// that checks the whole object at once.
export function describeActivity(msg) {
  const value = msg && typeof msg === "object" ? msg.value : undefined;
  if (typeof value !== "string" || !KNOWN_VALUES.has(value)) {
    return { label: "", detail: "" };
  }

  if (value === "interviewing") return { label: "interviewing", detail: "" };
  if (value === "proposing") return { label: "awaiting your yes", detail: cleanBrief(msg.brief) };

  let subject = cleanSubject(msg.subject);
  if (value === "building" && subject) subject = wordsFromId(subject);
  return { label: subject ? `${value} ${subject}` : value, detail: "" };
}
