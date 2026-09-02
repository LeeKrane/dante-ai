// Ask out loud before the two things worth being interrupted for.
//
// Sessions Dante starts run under your own permissions, which is the decision
// this whole feature follows from: a session that hits a permission prompt with
// nobody at the terminal just stops. A PreToolUse hook can block and return a
// decision, so it can ask you instead -- and you can answer from across the
// room.
//
// SCOPED, deliberately, to two things: a file write outside the session's own
// repository, and a git operation that publishes. That is the smallest set with
// the highest consequence, which is the right trade for a channel that
// interrupts you. Everything else falls through to whatever the terminal would
// have done, which is the behaviour you already have.
//
// Both functions here are pure and heavily tested, because inApprovalScope
// decides whether you get interrupted and parseYesNo decides whether a
// `git push` happens.

import { isAbsolute, resolve, sep } from "node:path";

const MAX_SPOKEN_CHARS = 200;

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

// The tools that write. MultiEdit is included by name even where a given CLI
// build no longer ships it: a tool that vanishes costs nothing here, and one
// that reappears would otherwise write outside the repo unannounced.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Anything that leaves the machine. Matched against the whole command rather
// than its first word, because `cd /tmp && git push` is one command and the
// interesting half is at the end.
//
// This is a decision about whether to ASK, never a sandbox. A command crafted
// to slip past these patterns simply gets the behaviour it would have had
// without Dante -- the session's own permission prompt -- so the failure mode
// of a miss is "not interrupted", not "silently allowed".
const PUBLISHES = [
  [/\bgit\s+push\b/, "push to the remote"],
  [/\bgh\s+pr\s+create\b/, "open a pull request"],
  [/\bgh\s+release\s+create\b/, "publish a release"],
  [/\bnpm\s+publish\b/, "publish to npm"],
];

function cleanText(value, maxChars = MAX_SPOKEN_CHARS) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

// The last path segment, for saying out loud. A full path read aloud is a
// sentence nobody can follow, and the directory is what matters anyway.
function tail(path, segments = 2) {
  const parts = path.split(sep).filter(Boolean);
  return parts.slice(-segments).join("/") || path;
}

// inApprovalScope(toolName, input, workspaceRoot) -> null | { kind, spoken }
//
// null means "not worth interrupting anyone about", which is the answer for
// almost everything.
export function inApprovalScope(toolName, input, workspaceRoot) {
  if (typeof toolName !== "string" || !input || typeof input !== "object") return null;

  if (WRITE_TOOLS.has(toolName)) {
    const path = cleanText(input.file_path ?? input.notebook_path ?? "", 500);
    if (!path) return null;
    // A root that is not an absolute path cannot contain anything, and
    // guessing at one would mean asking about every write in the repo.
    if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot)) return null;

    const root = resolve(workspaceRoot);
    // A relative path is relative to the session's own directory, which is the
    // root itself -- so it cannot escape, and resolve() proves it either way.
    const full = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (full === root || full.startsWith(root + sep)) return null;

    return { kind: "outside-repo", spoken: `wants to write to ${tail(full)}, outside the repo` };
  }

  if (toolName === "Bash") {
    const command = cleanText(input.command ?? "", 500);
    if (!command) return null;
    for (const [pattern, phrase] of PUBLISHES) {
      if (pattern.test(command)) return { kind: "publish", spoken: `wants to ${phrase}` };
    }
    return null;
  }

  return null;
}

// A strict vocabulary, and strict is the point.
//
// This never goes through the model. Routing it through one would make a
// prompt-injected tool description able to argue for its own approval, and
// there is no wording of a system prompt that reliably survives that. A word
// list cannot be talked around.
// Exported so lib/confirm.js's readConfirmingAnswer can build an allowlist
// out of the same vocabulary rather than keeping its own copy that could
// drift from this one.
export const YES = new Set([
  "yes", "yeah", "yep", "yup", "ya", "sure", "ok", "okay", "affirmative",
  "allow", "allowed", "approve", "approved", "granted", "permitted", "proceed", "continue",
]);
export const NO = new Set([
  "no", "nope", "nah", "negative", "deny", "denied", "decline", "declined",
  "refuse", "refused", "stop", "cancel", "abort", "never", "dont", "don't", "wait",
  // "not" earns its place by making "not yes" ambiguous rather than an
  // approval. It costs a few sentences their answer -- "yes, not a problem"
  // becomes a re-ask -- and that is the direction to be wrong in.
  "not",
]);
// Two-word answers people actually say. Checked as phrases because their words
// mean nothing alone: "go" and "do" are not answers.
export const YES_PHRASES = [/\bgo ahead\b/, /\bgo for it\b/, /\bdo it\b/, /\bplease do\b/, /\bfine by me\b/];
export const NO_PHRASES = [/\bdo not\b/, /\bno way\b/, /\bhold off\b/, /\bleave it\b/, /\bforget it\b/];

// parseYesNo(text) -> "yes" | "no" | "unclear"
//
// "unclear" is the safe answer and the common one. It never becomes a decision:
// the caller re-asks once and then falls through to normal behaviour, so a
// sentence this cannot read costs a question rather than a wrong `git push`.
export function parseYesNo(text) {
  if (typeof text !== "string") return "unclear";
  const clean = cleanText(text, 300)
    .toLowerCase()
    // Apostrophes survive so "don't" stays one word; everything else goes.
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "unclear";

  const words = clean.split(" ");
  let yes = words.some((word) => YES.has(word)) || YES_PHRASES.some((p) => p.test(clean));
  let no = words.some((word) => NO.has(word)) || NO_PHRASES.some((p) => p.test(clean));

  // "not yes" and "no, go ahead" are both real sentences and neither is an
  // answer this is allowed to guess at.
  if (yes && no) return "unclear";
  if (yes) return "yes";
  if (no) return "no";
  return "unclear";
}

// The shape a PreToolUse hook writes on stdout, verified against the installed
// CLI (2.1.245). An empty object is "no decision": the session falls back to
// whatever it would have done on its own, which is the answer whenever nobody
// is listening or nobody answered clearly.
export function buildDecision(answer, reason = "") {
  if (answer !== "yes" && answer !== "no") return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: answer === "yes" ? "allow" : "deny",
      permissionDecisionReason: cleanText(reason) || (answer === "yes" ? "approved by voice" : "denied by voice"),
    },
  };
}
