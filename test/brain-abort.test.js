import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask, askResilient } from "../lib/brain.js";

// Same shape as test/brain-resume.test.js: real fake CLIs on disk, passed as
// opts.bin, each recording that it ran so an abandoned turn can be proved not to
// have spawned a second one.
let workspace;
const fake = {};

async function writeFake(name, body) {
  const path = join(workspace, name);
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `const LOG = ${JSON.stringify(join(workspace, "calls.log"))};`,
      'fs.appendFileSync(LOG, "ran\\n");',
      body,
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

const callCount = async () =>
  existsSync(join(workspace, "calls.log"))
    ? (await readFile(join(workspace, "calls.log"), "utf8")).trim().split("\n").length
    : 0;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dante-abort-"));

  // Answers, but not for a second — long enough to be interrupted.
  fake.slow = await writeFake(
    "claude-slow.cjs",
    [
      "setTimeout(() => {",
      '  process.stdout.write(JSON.stringify({ result: "Tokyo, sir.", session_id: "slow-1" }));',
      "}, 1000);",
    ].join("\n"),
  );

  fake.ok = await writeFake(
    "claude-ok.cjs",
    'process.stdout.write(JSON.stringify({ result: "Very good, sir.", session_id: "fresh-1" }));',
  );
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

test("a call abandoned mid-flight rejects instead of answering", async () => {
  const controller = new AbortController();
  const pending = ask("what time is it in Tokyo", null, {
    bin: fake.slow,
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(pending, (err) => err.aborted === true);
});

test("a controller already aborted never starts a process at all", async () => {
  const before = await callCount();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    ask("never mind", null, { bin: fake.slow, signal: controller.signal }),
    (err) => err.aborted === true,
  );
  assert.equal(await callCount(), before);
});

test("abandoning a resumed turn does not spend a second call retrying it", async () => {
  // askResilient exists to heal a stale session id with one cold retry. An
  // abandoned turn is the one failure that must NOT earn that retry: nobody is
  // waiting on the answer, and the call superseding it is already on its way.
  const before = await callCount();
  const controller = new AbortController();
  const pending = askResilient("what time is it in Tokyo", "some-session-id", {
    bin: fake.slow,
    signal: controller.signal,
  });

  // Abandon it only once the child has actually started, so the count below is
  // measuring a retry rather than a process that was killed before it ran.
  while ((await callCount()) === before) await new Promise((r) => setTimeout(r, 10));
  controller.abort();

  await assert.rejects(pending, (err) => err.aborted === true);
  assert.equal(await callCount(), before + 1, "an abandoned turn was retried");
});

test("a signal that is never fired leaves an ordinary call alone", async () => {
  const controller = new AbortController();
  const { reply, recovered } = await askResilient("hello", null, {
    bin: fake.ok,
    signal: controller.signal,
  });
  assert.equal(reply, "Very good, sir.");
  assert.equal(recovered, false);
});

test("a call with no signal at all still works, as every existing caller does it", async () => {
  const { reply } = await ask("hello", null, { bin: fake.ok });
  assert.equal(reply, "Very good, sir.");
});
