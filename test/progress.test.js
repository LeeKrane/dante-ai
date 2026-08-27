import { test } from "node:test";
import assert from "node:assert/strict";
import { progressLine, progressLines, createProgressStream } from "../lib/progress.js";

const toolEvent = (...blocks) =>
  JSON.stringify({ type: "assistant", message: { content: blocks } });
const toolUse = (name, input) => ({ type: "tool_use", name, input });

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
  assert.equal(progressLine(WRITE), "Writing index.html");
  assert.equal(progressLine(READ), "Reading config.json");
  assert.equal(progressLine(EDIT), "Editing index.html");
});

test("a tool_use without a file path falls back to a verb plus the tool name", () => {
  assert.equal(progressLine(BASH), "Running Bash");
  assert.equal(progressLine(MYSTERY), "Using Sparkle");
});

test("events with nothing worth showing return null", () => {
  for (const line of [RESULT, INIT, HOOK_STARTED, HOOK_RESPONSE, USER, RATE_LIMIT, TEXT_ONLY]) {
    assert.equal(progressLine(line), null);
  }
});

test("empty, blank, and malformed lines return null instead of throwing", () => {
  for (const line of ["", "   ", "not json at all", "{", "[]", "null", "3", undefined, null]) {
    assert.equal(progressLine(line), null);
  }
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
    assert.equal(progressLine(toolEvent(toolUse(name, { file_path: "/b/index.html" }))), `Using index.html`);
    assert.equal(progressLine(toolEvent(toolUse(name, {}))), `Using ${name}`);
  }
});

test("a tool_use with a missing or empty name is not a progress line", () => {
  assert.equal(progressLine(toolEvent(toolUse("", { file_path: "/b/index.html" }))), null);
  assert.equal(progressLine(toolEvent(toolUse(7, { file_path: "/b/index.html" }))), null);
  assert.equal(progressLine(toolEvent({ type: "tool_use", input: {} })), null);
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
  // progressLine stays single-valued, and reports the first of the batch.
  assert.equal(progressLine(parallel), "Reading one.js");
});

test("NotebookEdit names the notebook instead of repeating the tool name", () => {
  assert.equal(progressLine(toolEvent(toolUse("NotebookEdit", { notebook_path: "/b/run.ipynb" }))), "Editing run.ipynb");
});

// The path comes from the model and lands in a terminal and the HUD, so control
// characters (a forged second line, cursor moves) must not survive.
test("control characters and bidi overrides are stripped from the file name", () => {
  assert.equal(
    progressLine(toolEvent(toolUse("Write", { file_path: "/b/evil\nRunning rm -rf /" }))),
    "Writing evilRunning rm -rf ",
  );
  // \u001b = ESC (an ANSI colour sequence), \u202e = right-to-left override.
  assert.equal(progressLine(toolEvent(toolUse("Write", { file_path: "/b/\u001b[31mred.html" }))), "Writing [31mred.html");
  assert.equal(progressLine(toolEvent(toolUse("Write", { file_path: "/b/\u202egnp.exe" }))), "Writing gnp.exe");
});

test("an absurdly long file name is truncated without splitting a character", () => {
  const line = progressLine(toolEvent(toolUse("Write", { file_path: "/b/" + "\u{1F600}".repeat(500) + ".html" })));
  assert.equal([...line].length, "Writing ".length + 61); // 60 code points + the ellipsis
  assert.ok(line.endsWith("…"));
  // Every unit is a whole code point: a mid-surrogate slice would leave a lone half.
  assert.ok([...line].every((c) => c.codePointAt(0) < 0xd800 || c.codePointAt(0) > 0xdfff));
});

test("unicode file names survive intact", () => {
  assert.equal(progressLine(toolEvent(toolUse("Write", { file_path: "/b/café-日本語.html" }))), "Writing café-日本語.html");
});

test("odd tool_use payloads never throw", () => {
  for (const input of [undefined, null, "nope", ["a"], 42, { file_path: 42 }, { file_path: "" }, { file_path: "/" }]) {
    assert.equal(progressLine(toolEvent(toolUse("Write", input))), "Writing Write");
  }
});

// stdout arrives in arbitrary chunks and a `Write` of a whole HTML file is far
// bigger than one pipe chunk, so the split line is the one that matters most.
test("a line split across chunks is recovered, not lost", () => {
  const write = toolEvent(toolUse("Write", { file_path: "/b/index.html", content: "y".repeat(80000) }));
  const stream = createProgressStream();
  assert.deepEqual(stream.push(write.slice(0, 65536)), []);
  assert.deepEqual(stream.push(write.slice(65536) + "\n"), ["Writing index.html"]);
});

test("the stream carries a partial line across many chunks and flushes the last one", () => {
  const read = toolEvent(toolUse("Read", { file_path: "/b/config.json" }));
  const stream = createProgressStream();
  const out = [];
  for (const ch of read + "\n" + toolEvent(toolUse("Edit", { file_path: "/b/index.html" }))) {
    out.push(...stream.push(ch)); // one character at a time: worst-case chunking
  }
  assert.deepEqual(out, ["Reading config.json"]); // the second line has no newline yet
  assert.deepEqual(stream.flush(), ["Editing index.html"]);
  assert.deepEqual(stream.flush(), []); // flushing twice must not repeat the line
});

// stdout hands over Buffers, and a multi-byte character can straddle two of them.
test("a utf-8 character split across two buffers is not mangled", () => {
  const full = Buffer.from(toolEvent(toolUse("Write", { file_path: "/b/café-日本語.html" })) + "\n");
  const cut = full.indexOf(Buffer.from("日")) + 1; // mid-character
  const stream = createProgressStream();
  assert.deepEqual(stream.push(full.subarray(0, cut)), []);
  assert.deepEqual(stream.push(full.subarray(cut)), ["Writing café-日本語.html"]);
});

test("the stream ignores junk and non-string chunks without throwing", () => {
  const stream = createProgressStream();
  assert.deepEqual(stream.push("garbage\n\n>>>\n"), []);
  assert.deepEqual(stream.push(null), []);
  assert.deepEqual(stream.push(undefined), []);
  assert.deepEqual(stream.push(Buffer.from(toolEvent(toolUse("Read", { file_path: "/b/a.js" })) + "\n")), ["Reading a.js"]);
  assert.deepEqual(stream.flush(), []);
});
