import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseResultEvent, buildSucceeded, describeFailure } from "../lib/outcome.js";

// Real temp dirs and real files: the detector's whole job is answering
// "did a file actually land on disk?", so stubbing fs would test nothing.
const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "outcome-"));
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// The exact shape of the lines a streamed build emits, with a synthetic session id.
const RESULT_LINE = '{"type":"result","subtype":"success","is_error":false,"duration_ms":81406,"duration_api_ms":81044,"num_turns":2,"total_cost_usd":0.473455,"session_id":"00000000-0000-4000-8000-000000000001"}';
const TOOL_USE_LINE = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/private/var/tmp/index.html","content":"<!DOCTYPE html>"}}]}}';

test("parses the terminal result event", () => {
  const result = parseResultEvent(RESULT_LINE);
  assert.equal(result.is_error, false);
  assert.equal(result.subtype, "success");
  assert.equal(result.duration_ms, 81406);
  assert.equal(result.total_cost_usd, 0.473455);
  assert.equal(result.num_turns, 2);
  assert.equal(result.session_id, "00000000-0000-4000-8000-000000000001");
});

test("ignores every non-result event in the stream", () => {
  assert.equal(parseResultEvent(TOOL_USE_LINE), null);
  assert.equal(parseResultEvent('{"type":"system","subtype":"init"}'), null);
  assert.equal(parseResultEvent('{"type":"system","subtype":"hook_started"}'), null);
  assert.equal(parseResultEvent('{"type":"user"}'), null);
  assert.equal(parseResultEvent('{"type":"rate_limit_event"}'), null);
  assert.equal(parseResultEvent('{"type":"assistant","message":{"content":[]}}'), null);
});

test("returns null instead of throwing on malformed input", () => {
  assert.equal(parseResultEvent(""), null);
  assert.equal(parseResultEvent("   "), null);
  assert.equal(parseResultEvent("not json at all"), null);
  assert.equal(parseResultEvent('{"type":"result","is_error":fal'), null); // truncated write
  assert.equal(parseResultEvent("null"), null);
  assert.equal(parseResultEvent("42"), null);
  assert.equal(parseResultEvent('"result"'), null);
  assert.equal(parseResultEvent(undefined), null);
  assert.equal(parseResultEvent(null), null);
  assert.equal(parseResultEvent({ type: "result" }), null);
});

test("succeeds when the exit code is clean and the artifact is on disk", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html><title>ok</title>");
  const result = parseResultEvent(RESULT_LINE);
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "index.html", result }), true);
});

test("succeeds without a result event, since the exit code still stands", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html>");
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "index.html" }), true);
});

test("fails when the artifact was never written", () => {
  const dir = tempDir();
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "index.html" }), false);
});

test("fails when a directory sits where the artifact should be", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "index.html"));
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "index.html" }), false);
});

test("fails on a non-zero exit even with the artifact present", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html>");
  assert.equal(buildSucceeded({ code: 1, dir, outputContract: "index.html" }), false);
});

test("fails when the result event reports an error, even on exit 0", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html>");
  const result = parseResultEvent('{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":30}');
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "index.html", result }), false);
});

test("fails when there is no output contract to check", () => {
  const dir = tempDir();
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "" }), false);
  assert.equal(buildSucceeded({ code: 0, outputContract: "index.html" }), false);
});

test("explains a timeout ahead of the symptoms it caused", () => {
  const dir = tempDir();
  const message = describeFailure({
    code: 143,
    dir,
    outputContract: "index.html",
    timedOut: true,
  });
  assert.match(message, /time/i);
  assert.equal(message.includes("143"), false);
});

test("explains a reported error ahead of the exit code", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html>");
  const result = parseResultEvent('{"type":"result","subtype":"error_max_turns","is_error":true}');
  const message = describeFailure({ code: 1, dir, outputContract: "index.html", result });
  assert.match(message, /error/i);
  assert.equal(message.includes("1"), false);
});

test("explains a non-zero exit", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html>");
  const message = describeFailure({ code: 2, dir, outputContract: "index.html" });
  assert.match(message, /2/);
  assert.match(message, /stop|exit/i);
});

test("names the file that was never written", () => {
  const dir = tempDir();
  const message = describeFailure({ code: 0, dir, outputContract: "index.html" });
  assert.match(message, /index\.html/);
});

test("has nothing to explain when the build succeeded", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html>");
  const result = parseResultEvent(RESULT_LINE);
  assert.equal(describeFailure({ code: 0, dir, outputContract: "index.html", result }), "");
});

// A build killed by a signal (the timeout path SIGTERMs it) exits with a null
// code, and "exit code null" is nonsense to hear out loud.
test("does not read a signal kill as an exit code", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html>");
  assert.equal(buildSucceeded({ code: null, dir, outputContract: "index.html" }), false);
  const message = describeFailure({ code: null, dir, outputContract: "index.html" });
  assert.equal(message.includes("null"), false);
  assert.match(message, /stopped/i);
});

// The regression that matters most: an absolute contract resolves outside the
// build dir, so a file that was already there would report a build that wrote
// nothing as a success.
test("an absolute output contract is never a success", () => {
  const dir = tempDir();
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "/etc/hosts" }), false);
  assert.match(describeFailure({ code: 0, dir, outputContract: "/etc/hosts" }), /relative path/i);
});

test("an output contract that climbs out of the build dir is never a success", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html>");
  const escaping = join("..", basename(dir), "index.html"); // resolves back to the real file
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: escaping }), false);
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "a/../../out/index.html" }), false);
});

// The escape check must not catch ordinary names that happen to start with dots.
test("accepts a contract in a subdirectory or with a leading-dot name", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "<!DOCTYPE html>");
  writeFileSync(join(dir, "..hidden.html"), "<!DOCTYPE html>");
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "dist/index.html" }), true);
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "./dist/index.html" }), true);
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "..hidden.html" }), true);
});

// A malformed primitive is a bug in someone's primitives/*.mjs, and it must
// surface as a spoken failure rather than as an exception out of the voice loop.
test("survives an unusable output contract instead of throwing", () => {
  const dir = tempDir();
  const nasty = [
    123,
    ["index.html"],
    { file: "index.html" },
    "index\0.html",
    "a".repeat(5000), // ENAMETOOLONG: statSync throws even with throwIfNoEntry
    "index.html/nested.txt", // a file where a directory is expected
    ".",
    "..",
    "índex✨.html",
    "in\ndex.html",
  ];
  for (const outputContract of nasty) {
    assert.equal(buildSucceeded({ code: 0, dir, outputContract }), false, `succeeded on ${outputContract}`);
    const message = describeFailure({ code: 0, dir, outputContract });
    assert.ok(message.length > 0, `silent on ${outputContract}`);
  }
});

test("survives a non-string build dir instead of throwing", () => {
  assert.equal(buildSucceeded({ code: 0, dir: { path: "/tmp" }, outputContract: "index.html" }), false);
  assert.equal(buildSucceeded({ code: 0, dir: 42, outputContract: "index.html" }), false);
  assert.match(describeFailure({ code: 0, dir: 42, outputContract: "index.html" }), /index\.html/);
});

test("survives being called with nothing at all", () => {
  assert.equal(buildSucceeded(), false);
  assert.equal(buildSucceeded(null), false);
  assert.ok(describeFailure().length > 0);
  assert.ok(describeFailure(null).length > 0);
});

// An older draft of this contract was positional. Destructuring a number yields
// undefined for every field, so a positional call would have reported every
// build as failed — silently. Better to be loud at the call site.
test("rejects a positional call instead of answering wrongly", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html>");
  assert.throws(() => buildSucceeded(0, dir, "index.html"), {
    name: "TypeError",
    message: /buildSucceeded\(\) takes one options object/,
  });
  assert.throws(() => describeFailure(0, dir, "index.html"), {
    name: "TypeError",
    message: /describeFailure\(\) takes one options object/,
  });
});

test("stays plain enough to read aloud", () => {
  const dir = tempDir();
  const messages = [
    describeFailure({ code: 143, dir, outputContract: "index.html", timedOut: true }),
    describeFailure({ code: 0, dir, outputContract: "index.html", result: { is_error: true } }),
    describeFailure({ code: 2, dir, outputContract: "index.html" }),
    describeFailure({ code: 0, dir, outputContract: "index.html" }),
    describeFailure({ code: null, dir, outputContract: "index.html" }),
    describeFailure({ code: 0, dir, outputContract: "/etc/hosts" }),
  ];
  for (const message of messages) {
    assert.ok(message.length > 0 && message.length < 120, `unreadable: ${message}`);
    assert.match(message, /^[A-Z].*\.$/s);
  }
});
