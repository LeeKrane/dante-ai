import { test } from "node:test";
import assert from "node:assert/strict";
import * as brain from "../lib/brain.js";

const { parseClaudeJson } = brain;

test("parses reply + session id", () => {
  const out = JSON.stringify({ result: "  Hello there.  ", session_id: "abc-123" });
  const { reply, sessionId } = parseClaudeJson(out);
  assert.equal(reply, "Hello there.");
  assert.equal(sessionId, "abc-123");
});

test("replaces the coding-agent prompt with the spoken Jarvis prompt", () => {
  assert.equal(typeof brain.buildClaudeArgs, "function");
  const args = brain.buildClaudeArgs("Status report.", "session-1");

  assert.ok(args.includes("--system-prompt"));
  assert.equal(args.includes("--append-system-prompt"), false);
  assert.deepEqual(args.slice(-4), ["--resume", "session-1", "--", "Status report."]);
});

test("closes stdin so Claude does not wait for piped input", () => {
  assert.equal(typeof brain.buildSpawnOptions, "function");
  assert.deepEqual(brain.buildSpawnOptions("/tmp/jarvis"), {
    cwd: "/tmp/jarvis",
    stdio: ["ignore", "pipe", "pipe"],
  });
});
