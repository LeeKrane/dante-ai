import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askResilient } from "../lib/brain.js";

let workspace;
let log;

// Same shape as writeFake in builder.test.js: a real executable on disk, passed
// as opts.bin, so the spawn path is exercised for real rather than stubbed. Each
// fake logs the arguments it was called with, which is how a test can tell the
// retry went out cold.
async function writeFake(name, body) {
  const path = join(workspace, name);
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `const LOG = ${JSON.stringify(join(workspace, "calls.log"))};`,
      'fs.appendFileSync(LOG, process.argv.slice(2).join(" ") + "\\n");',
      body,
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

const OK = 'process.stdout.write(JSON.stringify({ result: "Very good, sir.", session_id: "fresh-1" }));';
const DIE = 'process.stderr.write("no conversation found"); process.exit(1);';

async function calls() {
  return (await readFile(log, "utf8")).trim().split("\n");
}

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "jarvis-resume-"));
  log = join(workspace, "calls.log");
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

test("a call that works first time reports that nothing had to be recovered", async () => {
  const bin = await writeFake("ok.js", OK);
  const result = await askResilient("Status report.", null, { bin });
  assert.deepEqual(result, { reply: "Very good, sir.", sessionId: "fresh-1", recovered: false });
});

test("a resumed call that works first time is not marked recovered", async () => {
  await rm(log, { force: true });
  const bin = await writeFake("ok2.js", OK);
  const result = await askResilient("Status report.", "old-session", { bin });
  assert.equal(result.recovered, false);
  assert.equal((await calls()).length, 1);
});

test("a stale session id is dropped and the turn retried from cold", async () => {
  await rm(log, { force: true });
  const bin = await writeFake("stale.js", `if (process.argv.includes("--resume")) { ${DIE} }\n${OK}`);
  const result = await askResilient("Status report.", "old-session", { bin });
  assert.deepEqual(result, { reply: "Very good, sir.", sessionId: "fresh-1", recovered: true });
});

test("the retry carries no session id at all", async () => {
  await rm(log, { force: true });
  const bin = await writeFake("stale2.js", `if (process.argv.includes("--resume")) { ${DIE} }\n${OK}`);
  await askResilient("Status report.", "old-session", { bin });
  const [first, second] = await calls();
  assert.ok(first.includes("--resume old-session"));
  assert.equal(second.includes("--resume"), false);
});

test("a cold failure is just a failure, retried never and flagged never", async () => {
  await rm(log, { force: true });
  const bin = await writeFake("dead.js", DIE);
  await assert.rejects(
    () => askResilient("Status report.", null, { bin }),
    (e) => e.sessionExhausted === undefined,
  );
  assert.equal((await calls()).length, 1);
});

test("when the cold retry fails too the error says the session is exhausted", async () => {
  await rm(log, { force: true });
  const bin = await writeFake("dead2.js", DIE);
  await assert.rejects(
    () => askResilient("Status report.", "old-session", { bin }),
    (e) => e.sessionExhausted === true,
  );
  assert.equal((await calls()).length, 2);
});
