import { basename } from "node:path";

// Turns `claude --output-format stream-json` output into short lines a human can
// read (or hear) while a build runs. Most events carry nothing worth showing, so
// the parser is deliberately quiet: only tool calls make it to the screen.

// Present-participle verbs, so a line reads as "what it's doing right now".
const VERBS = {
  Write: "Writing",
  Edit: "Editing",
  MultiEdit: "Editing",
  NotebookEdit: "Editing",
  Read: "Reading",
  Bash: "Running",
  Glob: "Searching",
  Grep: "Searching",
  WebFetch: "Fetching",
  WebSearch: "Searching",
  Task: "Delegating",
};

const DEFAULT_VERB = "Using";

// Tool names arrive from a subprocess, so `VERBS[name]` alone would happily
// return Object.prototype members ("toString" => "function toString() {...}").
function verbFor(name) {
  return Object.hasOwn(VERBS, name) ? VERBS[name] : DEFAULT_VERB;
}

// Different tools name their path argument differently; NotebookEdit is the one
// that would otherwise fall back to the useless "Editing NotebookEdit".
const PATH_KEYS = ["file_path", "notebook_path"];

// The path is attacker-adjacent (a model picks it), and this string is printed
// to a terminal and pushed to the HUD. Control characters would forge a second
// progress line or move the cursor; bidi overrides would reverse the display.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const MAX_SUBJECT = 60;

// A build runs in a temp dir, so the full path is long noise on screen; the
// basename is the only part a watching human actually recognizes.
function subject(input) {
  if (!input || typeof input !== "object") return "";
  const key = PATH_KEYS.find((k) => typeof input[k] === "string" && input[k] !== "");
  if (!key) return "";

  const clean = basename(input[key]).replace(UNPRINTABLE, "");
  // Slice by code point, so truncation can't leave a lone surrogate half.
  const chars = [...clean];
  return chars.length > MAX_SUBJECT ? chars.slice(0, MAX_SUBJECT).join("") + "…" : clean;
}

// A single assistant message can carry several tool_use blocks (Claude batches
// parallel calls), so every block gets its own line rather than just the first.
function linesForEvent(event) {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return [];

  const lines = [];
  for (const block of content) {
    if (block?.type !== "tool_use") continue;
    if (typeof block.name !== "string" || block.name === "") continue;
    const name = subject(block.input);
    lines.push(name ? `${verbFor(block.name)} ${name}` : `${verbFor(block.name)} ${block.name}`);
  }
  return lines;
}

function parseEvent(rawLine) {
  if (typeof rawLine !== "string" || rawLine.trim() === "") return null;
  try {
    // A bare `catch` on purpose: malformed JSON throws SyntaxError, but deeply
    // nested JSON throws RangeError, and neither is worth crashing a build over.
    const event = JSON.parse(rawLine);
    return event && typeof event === "object" ? event : null;
  } catch {
    // Chunked stdout can split a JSON object mid-line; a partial line is not an error.
    return null;
  }
}

function linesFrom(rawLines) {
  const out = [];
  for (const raw of rawLines) {
    const event = parseEvent(raw);
    if (event) out.push(...linesForEvent(event));
  }
  return out;
}

// For input already split into whole lines. A chunk straight off a pipe can end
// mid-JSON, and that partial is dropped here — lib/builder.js's own
// lineSplitter is what glues stdout chunks into whole lines before handing
// them to this, so a large Write event straddling a chunk boundary still
// arrives whole by the time it gets here (see the why-comment near
// builder.js:302 for why that lives there and not in a stream reader here).
export function progressLines(chunk) {
  if (typeof chunk !== "string" || chunk === "") return [];
  return linesFrom(chunk.split("\n"));
}
