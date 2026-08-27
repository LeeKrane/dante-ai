// The wording of an event, in one place.
//
// Pure on purpose. What Dante says when a session finishes is the thing you
// actually read at the end of the day, from a phone, having forgotten what you
// asked for -- so it is worth testing, and testing it means it cannot live
// inline in a poller callback.
//
// Two forms of every event. Slack is the durable one and carries the detail;
// the spoken one is shorter, because a sentence you can interrupt is not a
// place to recite a task string back.

// Everything here is capped: a name comes off a roster, a task and a summary
// come from a model, and a detail comes from a hook payload. None of that is
// trusted to be short.
export const MAX_NAME_CHARS = 60;
export const MAX_TASK_CHARS = 200;
export const MAX_SUMMARY_CHARS = 300;
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

// formatEvent(event) -> the line that goes to Slack, or "" for an event with
// nothing in it worth posting.
//
//   jarvis-1-builder-test-fix - started - "fix the failing builder test"
//   jarvis-1-builder-test-fix - done in 4m 12s - fixed the timeout assertion
//
// A started event is a thread parent and names the task, because that is the
// only place the task appears. Every later event is a reply inside that thread,
// where the task is already on screen -- repeating it there would push the
// thing that actually changed off the end of the line.
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

  return tail ? `${name} - ${headline} - ${tail}` : `${name} - ${headline}`;
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
  return summary ? `${opener} ${sentence(summary)}` : opener;
}

// A summary written for reading rarely ends in a full stop, and a spoken line
// that runs into the next one is the thing that makes an assistant sound rushed.
function sentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
