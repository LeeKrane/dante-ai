// What the build readout is allowed to show, and how much of it.
//
// This is the client's half of the progress contract. It lives here rather than
// in app.js for the same reason stt-policy.js and visibility-policy.js do: app.js
// touches the DOM on its first line and can never be unit-tested, so anything
// that can be stated as a pure decision is stated here instead.
//
// It accepts BOTH the bare string the server sends today and the envelope it will
// send once the builder learns about steps. That is deliberate: the two land in
// different releases, and a browser that only understood the new shape would
// silently render an empty readout against an older server.

// A build can run for minutes and emit hundreds of lines. Only the last few are
// worth showing: enough to prove something is happening, not so much that the
// HUD turns into a log file.
export const PROGRESS_MAX = 5;

// This text is written by the model running the build, so it is untrusted input
// on its way to the screen. It is rendered with textContent (never HTML), and
// control characters are dropped because they can forge extra lines.
export function cleanProgressLine(line) {
  return String(line ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

// A position in the chain is only worth rendering if it is a real count. A
// float, a negative, a NaN or the string "2" all mean the producer sent
// something this readout has no honest way to display, so they become "no
// position" rather than being coerced into one.
function wholeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// normalizeProgress(line) -> a renderable entry, or null.
//
//   {kind:"line", step, text}                 something the build is doing
//   {kind:"step", step, state, index, of}     a boundary between two steps
//
// null means "nothing worth showing" and is the answer for every shape this
// module does not recognize. Returning null rather than a best guess is the
// whole point: the alternative is String(payload) reaching the screen as
// "[object Object]", which looks enough like text to ship unnoticed.
export function normalizeProgress(line) {
  if (typeof line === "string") {
    const text = cleanProgressLine(line);
    return text ? { kind: "line", step: "", text } : null;
  }

  if (!line || typeof line !== "object" || Array.isArray(line)) return null;

  if (line.kind === "line") {
    const text = cleanProgressLine(line.text);
    return text ? { kind: "line", step: cleanProgressLine(line.step), text } : null;
  }

  if (line.kind === "step") {
    // An unnamed boundary says nothing a person could act on, and it would
    // render as a blank heading with the lines of the next step under it.
    const step = cleanProgressLine(line.step);
    if (!step) return null;
    return {
      kind: "step",
      step,
      state: cleanProgressLine(line.state),
      index: wholeCount(line.index),
      of: wholeCount(line.of),
    };
  }

  return null;
}

// Mutates `buffer` and returns it, so app.js can keep one long-lived array
// rather than reassigning a module-scope binding on every line. A null entry —
// what normalizeProgress returns for anything unusable — is dropped here, so
// callers can pipe one straight into the other.
export function pushProgressEntry(buffer, entry, max = PROGRESS_MAX) {
  if (!entry) return buffer;
  buffer.push(entry);
  while (buffer.length > max) buffer.shift();
  return buffer;
}

// "1 of 3", or "" when the producer did not say. Spelled out rather than "1/3"
// because it is read as words in the HUD's step row and on its record.
export function stepPosition(entry) {
  if (!entry || entry.index === null || entry.of === null) return "";
  return `${entry.index + 1} of ${entry.of}`;
}

// One row of the readout, as text. The tree shape is the whole point of this
// function: a boundary sits at the left margin and the lines belonging to it are
// indented under it, which is as much of a tree as a five-row list can carry.
//
// The indent is spaces rather than CSS because #progress div is already
// `white-space: pre` for its ellipsis, so it costs nothing and keeps the
// stylesheet out of it. A line with no step is never indented: a build without
// steps has to render exactly as it did before there were any.
export function progressRowText(entry) {
  if (!entry) return "";
  if (entry.kind === "step") {
    const position = stepPosition(entry);
    return position ? `${position} \u00b7 ${entry.step}` : entry.step;
  }
  return entry.step ? `  ${entry.text}` : entry.text;
}
