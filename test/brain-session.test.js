import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  askResilient,
  buildSessionArgs,
  createBrainSession,
  createLineReader,
  encodeTurn,
  readResult,
} from "../lib/brain.js";

let workspace;
let log;

// Same shape as writeFake in builder.test.js and brain-resume.test.js: a real
// executable on disk, passed as opts.bin, so the spawn path is exercised for
// real. One line per spawn in calls.log, which is how a test counts processes —
// the whole point of this stage being that there is normally only ever one.
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

// A CLI that speaks stream-json: one prompt per line in, one result event per
// line out, and a system event before each to prove the reader ignores them.
const warmBody = (delayMs = 0, sessionId = "warm-1") => `
let buf = "";
let n = 0;
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const asked = JSON.parse(line).message.content;
    const turn = ++n;
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(sessionId)} }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "result", subtype: "success", is_error: false,
        session_id: ${JSON.stringify(sessionId)},
        result: "answer " + turn + ": " + asked,
      }) + "\\n");
    }, ${delayMs});
  }
});
`;

function dieOnce(marker) {
  return `
const MARK = ${JSON.stringify(join(workspace, marker))};
if (!fs.existsSync(MARK)) { fs.writeFileSync(MARK, "x"); process.stdin.on("data", () => process.exit(3)); }
else {
${warmBody()}
}
`;
}

async function calls() {
  return (await readFile(log, "utf8")).trim().split("\n");
}

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "jarvis-session-"));
  log = join(workspace, "calls.log");
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

// --- the pure parts ---------------------------------------------------------

test("a warm session is spawned with no prompt and no terminator", () => {
  // The whole difference from a cold call: there is no sentence yet. Every
  // sentence arrives later, down stdin, and a `--` here would be a promise that
  // something follows it.
  const args = buildSessionArgs("PERSONA");
  assert.equal(args.includes("--"), false);
  assert.equal(args.includes("--resume"), false);
  assert.equal(args[args.indexOf("--system-prompt") + 1], "PERSONA");
  for (const flag of ["--input-format", "--output-format"]) {
    assert.equal(args[args.indexOf(flag) + 1], "stream-json", flag);
  }
  // --output-format stream-json is refused without it.
  assert.equal(args.includes("--verbose"), true);
});

test("a warm session still asks for no tools and no MCP servers", () => {
  // Stage 17's saving is per-turn, not per-process, so it has to survive here.
  const args = buildSessionArgs("PERSONA");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args.includes("--allowedTools"), false);
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: {} });
});

test("a warm session picks up an earlier conversation when it is given one", () => {
  const args = buildSessionArgs("PERSONA", "yesterday-1");
  assert.equal(args[args.indexOf("--resume") + 1], "yesterday-1");
});

test("a turn is written as one line of JSON, because the line is the frame", () => {
  const line = encodeTurn("Status report.");
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.indexOf("\n"), line.length - 1);
  assert.deepEqual(JSON.parse(line), {
    type: "user",
    message: { role: "user", content: "Status report." },
  });
});

test("a sentence with a newline in it cannot break the frame", () => {
  // Nothing puts one there today, but the frame is a line and JSON.stringify is
  // what keeps a stray newline from being read as the start of another turn.
  const line = encodeTurn("one\ntwo");
  assert.equal(line.indexOf("\n"), line.length - 1);
  assert.equal(JSON.parse(line).message.content, "one\ntwo");
});

test("output split across chunk boundaries is reassembled into whole lines", () => {
  const read = createLineReader();
  assert.deepEqual(read.push('{"a":'), []);
  assert.deepEqual(read.push('1}\n{"b":2}\n{"c'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(read.push('":3}\n'), ['{"c":3}']);
});

test("a blank line between events is not an event", () => {
  const read = createLineReader();
  assert.deepEqual(read.push("\n\nx\n"), ["x"]);
});

test("only a terminal result is an answer", () => {
  // system/init arrives once per turn, not once per process, so waiting on it or
  // treating it as the end of a turn would answer the wrong sentence.
  assert.equal(readResult({ type: "system", subtype: "init" }), null);
  assert.equal(readResult({ type: "assistant" }), null);
  assert.equal(readResult({ type: "rate_limit_event" }), null);
  assert.deepEqual(
    readResult({ type: "result", subtype: "success", is_error: false, result: " Very good, sir. ", session_id: "s1" }),
    { reply: "Very good, sir.", sessionId: "s1" },
  );
});

test("a result the CLI marks as an error is a failure, not an answer to speak", () => {
  assert.throws(
    () => readResult({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }),
    /boom/,
  );
});

// --- the session itself -----------------------------------------------------

test("a second turn costs no second process, which is the whole point", async () => {
  await rm(log, { force: true });
  const bin = await writeFake("warm.js", warmBody());
  const session = createBrainSession({ persona: "P", bin });
  try {
    assert.equal((await session.ask("one")).reply, "answer 1: one");
    assert.equal((await session.ask("two")).reply, "answer 2: two");
    assert.equal((await calls()).length, 1);
  } finally { session.close(); }
});

test("a warm session reports the conversation it is holding", async () => {
  const bin = await writeFake("warm2.js", warmBody(0, "held-1"));
  const session = createBrainSession({ persona: "P", bin });
  try {
    assert.equal((await session.ask("one")).sessionId, "held-1");
    assert.equal(session.sessionId, "held-1");
  } finally { session.close(); }
});

test("turns are answered in the order they were asked", async () => {
  // The CLI queues rather than interrupting, which is measured behaviour and not
  // an assumption; the pending list has to match that order or every answer
  // after an overlap belongs to the wrong question.
  const bin = await writeFake("warm3.js", warmBody(20));
  const session = createBrainSession({ persona: "P", bin });
  try {
    const both = await Promise.all([session.ask("one"), session.ask("two")]);
    assert.deepEqual(both.map((r) => r.reply), ["answer 1: one", "answer 2: two"]);
  } finally { session.close(); }
});

test("an abandoned turn rejects at once, without waiting for the CLI to finish it", async () => {
  const bin = await writeFake("warm4.js", warmBody(200));
  const session = createBrainSession({ persona: "P", bin });
  const abort = new AbortController();
  try {
    const pending = session.ask("one", { signal: abort.signal });
    abort.abort();
    await assert.rejects(pending, (e) => e.aborted === true);
  } finally { session.close(); }
});

test("an abandoned turn's answer is not handed to the turn waiting behind it", async () => {
  // The one thing a shared process gets wrong if the pending list is naive. The
  // CLI cannot be told to forget a queued turn, so its answer still arrives and
  // has to be consumed by the entry that asked for it — as a tombstone — rather
  // than resolving whoever is next in line.
  await rm(log, { force: true });
  const bin = await writeFake("warm5.js", warmBody(60));
  const session = createBrainSession({ persona: "P", bin });
  const abort = new AbortController();
  try {
    const abandoned = session.ask("one", { signal: abort.signal });
    const second = session.ask("two");
    abort.abort();
    await assert.rejects(abandoned, (e) => e.aborted === true);
    assert.equal((await second).reply, "answer 2: two");
    assert.equal((await calls()).length, 1);
  } finally { session.close(); }
});

test("a turn abandoned before it was ever written costs nothing at all", async () => {
  const bin = await writeFake("warm6.js", warmBody());
  const session = createBrainSession({ persona: "P", bin });
  const abort = new AbortController();
  abort.abort();
  try {
    await assert.rejects(session.ask("one", { signal: abort.signal }), (e) => e.aborted === true);
    // The turn behind it still works, which is what proves nothing was written.
    assert.equal((await session.ask("two")).reply, "answer 1: two");
  } finally { session.close(); }
});

test("a process that dies rejects every turn still waiting on it", async () => {
  const bin = await writeFake("dies.js", 'process.stdin.on("data", () => process.exit(3));');
  const session = createBrainSession({ persona: "P", bin });
  try {
    await assert.rejects(session.ask("one"), /exited 3/);
  } finally { session.close(); }
});

test("a session that lost its process spawns another for the next turn", async () => {
  // The server holds one of these for its whole life. A CLI that dies at three in
  // the morning must not cost every turn after it.
  await rm(log, { force: true });
  const bin = await writeFake("flaky.js", dieOnce("flaky-1"));
  const session = createBrainSession({ persona: "P", bin });
  try {
    await assert.rejects(session.ask("one"), /exited 3/);
    assert.equal((await session.ask("two")).reply, "answer 1: two");
    assert.equal((await calls()).length, 2);
  } finally { session.close(); }
});

test("a restarted session drops the conversation it was resuming", async () => {
  // Same reasoning as the cold path's retry: the id is the thing most likely to
  // be what broke, so a replay that carried it would fail the same way twice.
  const bin = await writeFake("warm7.js", warmBody());
  const session = createBrainSession({ persona: "P", bin, resume: "stale-1" });
  try {
    assert.equal(session.resumeId, "stale-1");
    session.restart();
    assert.equal(session.resumeId, null);
  } finally { session.close(); }
});

test("a closed session refuses further turns rather than quietly spawning again", async () => {
  const bin = await writeFake("warm8.js", warmBody());
  const session = createBrainSession({ persona: "P", bin });
  await session.ask("one");
  session.close();
  await assert.rejects(session.ask("two"), /closed/);
});

// --- askResilient over a warm session ---------------------------------------

test("a warm turn that fails is replayed once through a fresh process", async () => {
  await rm(log, { force: true });
  const bin = await writeFake("flaky2.js", dieOnce("flaky-2"));
  const session = createBrainSession({ persona: "P", bin, resume: "stale-1" });
  try {
    const result = await askResilient("one", "stale-1", { session });
    assert.equal(result.reply, "answer 1: one");
    assert.equal(result.recovered, true);
    assert.equal((await calls()).length, 2);
  } finally { session.close(); }
});

test("an abandoned warm turn is never replayed", async () => {
  // Nobody is waiting on it, and the turn that superseded it is already on its
  // way. Same rule the cold path has always had.
  await rm(log, { force: true });
  const bin = await writeFake("warm9.js", warmBody(200));
  const session = createBrainSession({ persona: "P", bin });
  const abort = new AbortController();
  try {
    const pending = askResilient("one", null, { session, signal: abort.signal });
    abort.abort();
    await assert.rejects(pending, (e) => e.aborted === true);
    // The turn behind it lands on the same process, which is what "never
    // replayed" means here — a replay would have spawned a second one.
    assert.equal((await session.ask("two")).reply, "answer 2: two");
    assert.equal((await calls()).length, 1);
  } finally { session.close(); }
});

test("a warm turn that fails twice is flagged so the stored id can be cleared", async () => {
  const bin = await writeFake("dead.js", 'process.stdin.on("data", () => process.exit(3));');
  const session = createBrainSession({ persona: "P", bin, resume: "stale-1" });
  try {
    await assert.rejects(
      askResilient("one", "stale-1", { session }),
      (e) => e.sessionExhausted === true,
    );
  } finally { session.close(); }
});
