import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

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

// One complete stream-json line in, one human-readable line out (or null).
// If the event batched several tool calls, this returns the first; use
// progressLines / createProgressStream to see all of them.
export function progressLine(rawLine) {
  const event = parseEvent(rawLine);
  if (!event) return null;
  return linesForEvent(event)[0] ?? null;
}

// For input already split into whole lines. A chunk straight off a pipe can end
// mid-JSON, and that partial is dropped here — use createProgressStream for
// stdout, where a large Write event routinely straddles a chunk boundary.
export function progressLines(chunk) {
  if (typeof chunk !== "string" || chunk === "") return [];
  return linesFrom(chunk.split("\n"));
}

// Stateful reader for a real stdout stream: holds the trailing partial line and
// glues it to the front of the next chunk. Without this, a `Write` event
// carrying a whole HTML file (bigger than one 64KB pipe chunk) is silently lost
// — which is exactly the line a human most wants to see.
export function createProgressStream() {
  let carry = "";
  // Buffers, not strings, are what `child.stdout.on("data")` hands you by
  // default, and a raw toString() would mangle a UTF-8 character that happens to
  // straddle two chunks. StringDecoder holds the incomplete bytes instead.
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) return [];
      const text = carry + (typeof chunk === "string" ? chunk : decoder.write(chunk));
      const parts = text.split("\n");
      carry = parts.pop() ?? ""; // last part has no newline yet: keep it for next time
      return linesFrom(parts);
    },
    // Call on stream end: the last line often arrives without a trailing newline.
    flush() {
      const raw = carry + decoder.end();
      carry = "";
      const event = parseEvent(raw);
      return event ? linesForEvent(event) : [];
    },
  };
}
