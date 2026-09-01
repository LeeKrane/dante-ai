import { test } from "node:test";
import assert from "node:assert/strict";
import { progressLines } from "../lib/progress.js";

const toolEvent = (...blocks) =>
  JSON.stringify({ type: "assistant", message: { content: blocks } });
const toolUse = (name, input) => ({ type: "tool_use", name, input });

// A chunk carrying exactly one event line, the shape every test below feeds
// progressLines to check what one event turns into.
const line = (raw) => progressLines(raw + "\n");

// Fixtures are real lines observed from `claude -p --output-format stream-json --verbose`.
const WRITE = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        name: "Write",
        input: {
          file_path: "/private/var/folders/xy/T/dante-build-1234/index.html",
          content: "<!DOCTYPE html>...",
        },
      },
    ],
  },
});

const READ = JSON.stringify({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/var/tmp/b/config.json" } }],
  },
});

const EDIT = JSON.stringify({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Edit", input: { file_path: "/private/var/tmp/b/index.html" } }],
  },
});

const BASH = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
});

const MYSTERY = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Sparkle", input: {} }] },
});

const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 81406,
  duration_api_ms: 81044,
  num_turns: 2,
  total_cost_usd: 0.473455,
  session_id: "cfc03e00-e3f9-423f-b396-f07298352c25",
});

const INIT = JSON.stringify({ type: "system", subtype: "init" });
const HOOK_STARTED = JSON.stringify({ type: "system", subtype: "hook_started" });
const HOOK_RESPONSE = JSON.stringify({ type: "system", subtype: "hook_response" });
const USER = JSON.stringify({ type: "user" });
const RATE_LIMIT = JSON.stringify({ type: "rate_limit_event" });
const TEXT_ONLY = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "I'll create the page now." }] },
});

test("a tool_use with a file path becomes a short line naming the file", () => {
  assert.deepEqual(line(WRITE), ["Writing index.html"]);
  assert.deepEqual(line(READ), ["Reading config.json"]);
  assert.deepEqual(line(EDIT), ["Editing index.html"]);
});

test("a tool_use without a file path falls back to a verb plus the tool name", () => {
  assert.deepEqual(line(BASH), ["Running Bash"]);
  assert.deepEqual(line(MYSTERY), ["Using Sparkle"]);
});

test("events with nothing worth showing yield no lines", () => {
  for (const raw of [RESULT, INIT, HOOK_STARTED, HOOK_RESPONSE, USER, RATE_LIMIT, TEXT_ONLY]) {
    assert.deepEqual(line(raw), []);
  }
});

test("empty, blank, and malformed lines yield no lines instead of throwing", () => {
  for (const raw of ["", "   ", "not json at all", "{", "[]", "null", "3"]) {
    assert.deepEqual(line(raw), []);
  }
  assert.deepEqual(progressLines(undefined), []);
});

test("a chunk with several events yields only the readable lines, in order", () => {
  const chunk = [INIT, WRITE, HOOK_STARTED, READ, TEXT_ONLY, RESULT].join("\n") + "\n";
  assert.deepEqual(progressLines(chunk), ["Writing index.html", "Reading config.json"]);
});

// stdout arrives in arbitrary chunks, so a chunk can end mid-JSON.
test("a trailing partial line is dropped rather than crashing the stream", () => {
  const chunk = WRITE + "\n" + '{"type":"assistant","message":{"content":[{"type":"too';
  assert.deepEqual(progressLines(chunk), ["Writing index.html"]);
});

test("garbage and empty chunks yield no lines", () => {
  assert.deepEqual(progressLines("garbage\n\n>>>\n"), []);
  assert.deepEqual(progressLines(""), []);
  assert.deepEqual(progressLines(undefined), []);
});

// --- regressions -----------------------------------------------------------

// A tool name is just a string from a subprocess, so it must never be used as a
// bare object key: VERBS["toString"] used to leak the function's source.
test("a tool named after an Object.prototype member gets the default verb", () => {
  for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.deepEqual(line(toolEvent(toolUse(name, { file_path: "/b/index.html" }))), ["Using index.html"]);
    assert.deepEqual(line(toolEvent(toolUse(name, {}))), [`Using ${name}`]);
  }
});

test("a tool_use with a missing or empty name is not a progress line", () => {
  assert.deepEqual(line(toolEvent(toolUse("", { file_path: "/b/index.html" }))), []);
  assert.deepEqual(line(toolEvent(toolUse(7, { file_path: "/b/index.html" }))), []);
  assert.deepEqual(line(toolEvent({ type: "tool_use", input: {} })), []);
});

// Claude batches parallel calls into one assistant message; showing only the
// first one hides most of what the build is doing.
test("every tool_use in one message becomes its own line", () => {
  const parallel = toolEvent(
    toolUse("Read", { file_path: "/b/one.js" }),
    toolUse("Read", { file_path: "/b/two.js" }),
    toolUse("Bash", { command: "ls" }),
  );
  assert.deepEqual(progressLines(parallel), ["Reading one.js", "Reading two.js", "Running Bash"]);
});

test("NotebookEdit names the notebook instead of repeating the tool name", () => {
  assert.deepEqual(line(toolEvent(toolUse("NotebookEdit", { notebook_path: "/b/run.ipynb" }))), ["Editing run.ipynb"]);
});

// The path comes from the model and lands in a terminal and the HUD, so control
// characters (a forged second line, cursor moves) must not survive.
test("control characters and bidi overrides are stripped from the file name", () => {
  assert.deepEqual(
    line(toolEvent(toolUse("Write", { file_path: "/b/evil\nRunning rm -rf /" }))),
    ["Writing evilRunning rm -rf "],
  );
  // \u001b = ESC (an ANSI colour sequence), \u202e = right-to-left override.
  assert.deepEqual(line(toolEvent(toolUse("Write", { file_path: "/b/\u001b[31mred.html" }))), ["Writing [31mred.html"]);
  assert.deepEqual(line(toolEvent(toolUse("Write", { file_path: "/b/\u202egnp.exe" }))), ["Writing gnp.exe"]);
});

test("an absurdly long file name is truncated without splitting a character", () => {
  const [text] = line(toolEvent(toolUse("Write", { file_path: "/b/" + "\u{1F600}".repeat(500) + ".html" })));
  assert.equal([...text].length, "Writing ".length + 61); // 60 code points + the ellipsis
  assert.ok(text.endsWith("…"));
  // Every unit is a whole code point: a mid-surrogate slice would leave a lone half.
  assert.ok([...text].every((c) => c.codePointAt(0) < 0xd800 || c.codePointAt(0) > 0xdfff));
});

test("unicode file names survive intact", () => {
  assert.deepEqual(line(toolEvent(toolUse("Write", { file_path: "/b/café-日本語.html" }))), ["Writing café-日本語.html"]);
});

test("odd tool_use payloads never throw", () => {
  for (const input of [undefined, null, "nope", ["a"], 42, { file_path: 42 }, { file_path: "" }, { file_path: "/" }]) {
    assert.deepEqual(line(toolEvent(toolUse("Write", input))), ["Writing Write"]);
  }
});
