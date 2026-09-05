// The wording of an event, in one place.
//
// Pure on purpose. What Dante says when a session finishes is the thing you
// actually read at the end of the day, from a phone, having forgotten what you
// asked for -- so it is worth testing, and testing it means it cannot live
// inline in a poller callback.
//
// Two forms of every event. The recap log is the durable one and carries the
// detail; the spoken one is shorter, because a sentence you can interrupt is
// not a place to recite a task string back.

// This cap used to be its own private `const MAX_DO_THIS_FIRST_CHARS = 240`,
// redefined verbatim from lib/transcript.js's export -- one of three copies
// of the same number (the third was MAX_EVENT_DO_THIS_FIRST_CHARS in
// lib/memory.js). Imported now, so a change to the real one cannot leave
// this file's defensive second cap (see where it is used below) disagreeing
// with it.
import { MAX_DO_THIS_FIRST_CHARS } from "./transcript.js";

// Everything here is capped: a name comes off a roster, a task and a summary
// come from a model, and a detail comes from a hook payload. None of that is
// trusted to be short.
const MAX_NAME_CHARS = 60;
export const MAX_TASK_CHARS = 200;
export const MAX_SUMMARY_CHARS = 300;
// Exported so lib/watch.js can shorten a watcher's read-back against the
// same number the recap clause below actually applies, rather than a copy
// of it that could drift.
export const MAX_DETAIL_CHARS = 200;

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

// The four things worth interrupting someone about. Anything else is noise
// dressed as news.
export const KINDS = new Set(["started", "needs-attention", "complete", "failed"]);

const HEADLINE = {
  started: "started",
  "needs-attention": "waiting on you",
  complete: "done",
  failed: "failed",
};

function cleanText(value, maxChars) {
  if (typeof value !== "string") return "";
  // Whitespace collapsed BEFORE the strip: a newline is both, and stripping it
  // first fuses the words on either side into one.
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

// "4m 12s", "38s", "1h 5m". Spoken and read, so no decimals and no zero units.
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// formatEvent(event) -> the detailed line that goes to the recap log, or ""
// for an event with nothing in it worth recording.
//
//   jarvis-1-builder-test-fix - started - "fix the failing builder test"
//   jarvis-1-builder-test-fix - done in 4m 12s - fixed the timeout assertion
//
// A started event names the task, because that is the only place the task
// appears. Every later event is its own clause in the recap, where the task
// has already been said -- repeating it there would push the thing that
// actually changed off the end of the line.
export function formatEvent(event = {}) {
  const kind = KINDS.has(event.kind) ? event.kind : null;
  if (!kind) return "";

  const name = cleanText(event.name, MAX_NAME_CHARS) || cleanText(event.alias, MAX_NAME_CHARS) || "a session";
  const duration = formatDuration(event.durationMs);

  // Only "done" wears its duration. A session that failed after four minutes
  // failed; how long it took first is not the news.
  const headline = kind === "complete" && duration ? `done in ${duration}` : HEADLINE[kind];

  const tail = kind === "started"
    ? quoteTask(event.task)
    : cleanText(event.summary, MAX_SUMMARY_CHARS) || cleanText(event.detail, MAX_DETAIL_CHARS);

  const line = tail ? `${name} - ${headline} - ${tail}` : `${name} - ${headline}`;

  // A short trailing clause, not the "The council says, ..." sentence
  // formatSpoken and describeFired share -- this is a log line, read rather
  // than heard, and it already named the session and the outcome in the
  // dashes above it.
  const doThisFirst = cleanText(event.doThisFirst, MAX_DO_THIS_FIRST_CHARS);
  return doThisFirst ? `${line} Do this first: ${sentence(doThisFirst)}` : line;
}

function quoteTask(task) {
  const text = cleanText(task, MAX_TASK_CHARS);
  return text ? `"${text}"` : "";
}

// The same event, out loud. Shorter, and it says nothing a listener cannot act
// on: no task echo, no duration on a failure, no name they did not choose.
//
// The name stays, always. It is how every later command refers to the session,
// and an announcement that omits it leaves nothing to say back.
export function formatSpoken(event = {}) {
  const kind = KINDS.has(event.kind) ? event.kind : null;
  if (!kind) return "";

  const name = cleanText(event.name, MAX_NAME_CHARS) || "A session";
  const summary = cleanText(event.summary, MAX_SUMMARY_CHARS);
  const detail = cleanText(event.detail, MAX_DETAIL_CHARS);
  const duration = formatDuration(event.durationMs);

  if (kind === "started") return `${name} is running, sir.`;
  if (kind === "needs-attention") {
    return detail ? `${name} needs you, sir. ${sentence(detail)}` : `${name} needs you, sir.`;
  }
  if (kind === "failed") {
    return detail ? `${name} failed, sir. ${sentence(detail)}` : `${name} failed, sir.`;
  }
  const opener = duration ? `${name} finished in ${duration}, sir.` : `${name} finished, sir.`;
  const body = summary ? `${opener} ${sentence(summary)}` : opener;

  // The council's one concrete next step, when the transcript happened to
  // carry one -- see extractDoThisFirst in lib/transcript.js. Its own
  // sentence rather than folded into the summary: the summary is one model's
  // account of what a session did, and this is a different session's verdict
  // about what to do next, and keeping them as two sentences keeps that
  // distinction audible rather than blurring the two into one voice.
  const clause = doThisFirstClause(event.doThisFirst);
  return clause ? `${body} ${clause}` : body;
}

// A summary written for reading rarely ends in a full stop, and a spoken line
// that runs into the next one is the thing that makes an assistant sound rushed.
function sentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// doThisFirstClause(doThisFirst) -> "The council says, do this first: ..."
// or "" -- the one full, spoken-out-loud sentence for the council's next
// step, shared by formatSpoken above and describeFired in lib/watch.js, so
// a watcher's own completion report and the generic "finished" line say it
// exactly the same way rather than two announcements drifting apart over
// time.
export function doThisFirstClause(doThisFirst) {
  const clean = cleanText(doThisFirst, MAX_DO_THIS_FIRST_CHARS);
  return clean ? `The council says, do this first: ${sentence(clean)}` : "";
}

// ---------------------------------------------------------------------------
// formatRecap: "what happened while I was out," as one spoken paragraph
// ---------------------------------------------------------------------------
//
// The event log this reads (lib/memory.js) survives a restart, so an entry can
// be minutes or days old by the time anyone asks. A recap that only said WHAT
// happened would read a week-old "needs attention" as fresh news, so every
// clause here carries how long ago it was, in the same words formatDuration
// says everywhere else.
//
// Capped hard in both event count and character length, because this is read
// aloud by a voice someone is standing in a room listening to: a recap that
// takes two minutes to say is worse than none at all.
export const MAX_RECAP_EVENTS = 6;
export const MAX_RECAP_CHARS = 600;

// "12m ago", "1h 5m ago". formatDuration returns "" for anything under half a
// second (or unmeasurable), which reads better as "moments ago" than as a
// missing clause.
function ago(ms) {
  const d = formatDuration(ms);
  return d ? `${d} ago` : "moments ago";
}

function recapName(event) {
  return cleanText(event?.name, MAX_NAME_CHARS) || "A session";
}

// One clause, already ended in a full stop. `sir` is carried per-clause rather
// than stamped on the whole paragraph so the caller can address it exactly
// once -- in the lead clause -- instead of saying it after every sentence,
// which is how a paragraph starts to sound like a checklist read aloud.
function recapClause(event, now, { sir = false } = {}) {
  const name = recapName(event);
  const when = ago(now - event.at);
  const detail = cleanText(event.detail, MAX_DETAIL_CHARS);
  const addr = sir ? ", sir" : "";

  let base;
  if (event.kind === "needs-attention") {
    base = detail
      ? `${name} still needs you${addr} -- ${sentence(detail)} That was ${when}.`
      : `${name} still needs you${addr}, as of ${when}.`;
  } else if (event.kind === "failed") {
    base = detail ? `${name} failed ${when}${addr}: ${sentence(detail)}` : `${name} failed ${when}${addr}.`;
  } else if (event.kind === "started") {
    base = `${name} started ${when}${addr}.`;
  } else {
    // complete
    base = detail ? `${name} finished ${when}${addr}: ${sentence(detail)}` : `${name} finished ${when}${addr}.`;
  }

  // The short form, not formatSpoken's "The council says, ..." sentence --
  // this clause already sits inside a paragraph naming several other
  // sessions, and repeating "the council says" in every one of them would
  // be the paragraph announcing itself.
  const doThisFirst = cleanText(event.doThisFirst, MAX_DO_THIS_FIRST_CHARS);
  return doThisFirst ? `${base} Do this first: ${sentence(doThisFirst)}` : base;
}

// The log keeps every event because every one of them happened, but a session
// that asked for a person and has since ended is not waiting for one any more.
// Left in, it leads the paragraph -- needs-attention always does -- and is then
// contradicted three clauses later by the same session finishing. Said out loud
// that is not a nuance, it is a person walking over to a session that does not
// need them.
function stillWaiting(events, index) {
  const event = events[index];
  if (event.kind !== "needs-attention" || !event.name) return true;
  return !events.some(
    (later, i) =>
      i > index && later.name === event.name && (later.kind === "complete" || later.kind === "failed"),
  );
}

// formatRecap(events, now) -> one spoken paragraph, never a list.
//
// Needs-attention leads, always, because it is the only kind of event left
// with something to act on -- and it is never crowded out by the rest: the
// cap is spent on it first, and whatever room is left goes to everything else,
// in the order it actually happened.
export function formatRecap(events = [], now = Date.now()) {
  const known = Array.isArray(events) ? events.filter((e) => e && KINDS.has(e.kind)) : [];
  const live = known.filter((event, i) => stillWaiting(known, i));
  if (live.length === 0) return "Nothing happened while you were out, sir.";

  const attention = live.filter((e) => e.kind === "needs-attention");
  const rest = live.filter((e) => e.kind !== "needs-attention");

  const attnShown = attention.slice(0, MAX_RECAP_EVENTS);
  const restShown = rest.slice(0, Math.max(0, MAX_RECAP_EVENTS - attnShown.length));
  const shown = [...attnShown, ...restShown];
  const omitted = live.length - shown.length;

  const clauses = shown.map((event, i) => recapClause(event, now, { sir: i === 0 }));
  if (omitted > 0) {
    clauses.push(`${omitted} more thing${omitted === 1 ? "" : "s"} happened besides.`);
  }

  const paragraph = clauses.join(" ");
  // A hard backstop under the per-clause caps above: six long detail strings
  // could still add up to more than anyone should be read at once.
  return paragraph.length > MAX_RECAP_CHARS
    ? `${paragraph.slice(0, MAX_RECAP_CHARS - 1).trimEnd()}…`
    : paragraph;
}
