import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KILL_GRACE_MS, runCli } from "../lib/run-cli.js";
import { writeFakeCli } from "./helpers.js";

let workspace;
const fake = {};

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dante-run-cli-"));
  const writeFake = (name, body) => writeFakeCli(workspace, name, body);

  fake.echoes = await writeFake(
    "claude-echoes.cjs",
    'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));',
  );
  fake.complains = await writeFake(
    "claude-complains.cjs",
    ['console.error("error: unknown subcommand");', "process.exitCode = 2;"].join("\n"),
  );
  fake.floods = await writeFake("claude-floods.cjs", 'process.stdout.write("x".repeat(5000));');
  // Prints, then ignores the polite ask and never exits: only the deadline
  // ends it, and only SIGKILL actually gets rid of it.
  fake.hangs = await writeFake(
    "claude-hangs.cjs",
    [
      'process.stdout.write("partial");',
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  // Reads nothing, but would block forever if handed a stdin that never closes.
  fake.waitsOnStdin = await writeFake(
    "claude-waits-on-stdin.cjs",
    ['process.stdin.on("data", () => {});', 'process.stdin.on("end", () => process.exit(0));'].join("\n"),
  );
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

test("a child that exits is reported with its code and everything it printed", async () => {
  const result = await runCli(fake.echoes, ["agents", "--json"], { timeoutMs: 5000 });
  assert.equal(result.status, "exited");
  assert.equal(result.code, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(JSON.parse(result.stdout).args, ["agents", "--json"]);
});

test("the child runs where it is told to", async () => {
  const result = await runCli(fake.echoes, [], { cwd: workspace, timeoutMs: 5000 });
  assert.equal(JSON.parse(result.stdout).cwd, workspace);
});

test("a non-zero exit keeps what stderr said, which is the sentence worth repeating", async () => {
  const result = await runCli(fake.complains, [], { timeoutMs: 5000 });
  assert.equal(result.status, "exited");
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown subcommand/);
});

test("stderr past the cap is read and dropped rather than left to fill the pipe", async () => {
  const result = await runCli(fake.complains, [], { timeoutMs: 5000, maxStderr: 0 });
  assert.equal(result.code, 2);
  assert.equal(result.stderr, "");
});

test("stdout past the cap is cut and marked, never read to the end", async () => {
  const result = await runCli(fake.floods, [], { timeoutMs: 5000, maxStdout: 100 });
  assert.equal(result.status, "exited");
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 100);
});

test("a child that never answers is abandoned at the deadline rather than waited on", async () => {
  const started = Date.now();
  const result = await runCli(fake.hangs, [], { timeoutMs: 150, killGraceMs: 50 });
  assert.equal(result.status, "timed-out");
  assert.equal(result.code, null);
  // What it printed before hanging is still handed back.
  assert.equal(result.stdout, "partial");
  assert.ok(Date.now() - started < 2000, "the runner did not wait on the child");
});

test("a binary that is not there is not-started, not a crash", async () => {
  const result = await runCli(join(workspace, "no-such-binary"), [], { timeoutMs: 5000 });
  assert.equal(result.status, "not-started");
  assert.equal(result.code, null);
});

test("stdin is closed, so a child waiting on it gets its end of file at once", async () => {
  const result = await runCli(fake.waitsOnStdin, [], { timeoutMs: 2000 });
  assert.equal(result.status, "exited");
  assert.equal(result.code, 0);
});

test("the grace between the two signals is short and shared", () => {
  // Three callers used to each pick their own. One number, one place.
  assert.equal(KILL_GRACE_MS, 250);
});
