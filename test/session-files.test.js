import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseStateFile, listSessionFiles, processAlive } from "../lib/session-files.js";

// A real interactive session's state file, copied off this machine (the pid,
// procStart and timestamps are the ones the CLI actually wrote). Kept as a
// fixture function rather than one frozen object so each test only overrides
// the field it is actually exercising.
const SESSION_ID = "0c395916-b318-4c36-b014-ba76a849734a";
const OTHER_SESSION_ID = "1a2b3c4d-0000-4000-8000-000000000000";

function state(pid, overrides = {}) {
  return {
    pid,
    sessionId: SESSION_ID,
    cwd: "/home/krane/development/jarvis",
    startedAt: 1787829257018,
    procStart: "299878812",
    version: "2.1.247",
    peerProtocol: 1,
    peerFeatures: ["notify_idle", "artifact_yield"],
    kind: "interactive",
    entrypoint: "cli",
    messagingSocketPath: `/run/user/1000/cc-socks/${pid}.sock`,
    name: "jarvis-7a",
    nameSource: "derived",
    status: "idle",
    ...overrides,
  };
}

function expectedRecord(pid, overrides = {}) {
  return {
    sessionId: SESSION_ID,
    id: null,
    name: "jarvis-7a",
    cwd: "/home/krane/development/jarvis",
    kind: "interactive",
    status: "idle",
    state: null,
    pid,
    startedAt: 1787829257018,
    procStart: "299878812",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseStateFile
// ---------------------------------------------------------------------------

test("a well-formed interactive state file parses into a roster record", () => {
  const pid = 2646447;
  const record = parseStateFile(JSON.stringify(state(pid)), pid);
  assert.deepEqual(record, expectedRecord(pid));
});

test("kind \"bg\" reads as the CLI's \"background\"", () => {
  const pid = 2646448;
  const record = parseStateFile(JSON.stringify(state(pid, { kind: "bg" })), pid);
  assert.deepEqual(record, expectedRecord(pid, { kind: "background" }));
});

test("a spare pre-warmed process is not a session", () => {
  const pid = 2646449;
  // The fixture's own cwd (a real, already-whitelisted workspace root) is
  // left untouched here on purpose: a live spare observed on this machine
  // sat in exactly such a directory, under a name that read as legitimate,
  // so this is evidence the flag alone -- not the cwd -- is what disqualifies
  // it.
  const record = parseStateFile(JSON.stringify(state(pid, { spare: true })), pid);
  assert.equal(record, null);
});

test("a state file whose pid disagrees with its filename is not trusted", () => {
  const filenamePid = 2646450;
  const bodyPid = 2646451;
  const record = parseStateFile(JSON.stringify(state(bodyPid)), filenamePid);
  assert.equal(record, null);
});

test("malformed JSON is nothing, not a crash", () => {
  assert.equal(parseStateFile("{ not json", 2646452), null);
});

test("a session id that is not a uuid is not a session", () => {
  const pid = 2646453;
  const record = parseStateFile(JSON.stringify(state(pid, { sessionId: "not-a-uuid" })), pid);
  assert.equal(record, null);
});

// ---------------------------------------------------------------------------
// listSessionFiles -- against real temp directories, like test/peer.test.js
// ---------------------------------------------------------------------------

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "jarvis-session-files-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

// Lays out <home>/.claude/sessions/<pid>.json and, when given, a matching
// *.key file -- the same shape test/peer.test.js's writeSessionFiles lays
// out, redeclared here rather than imported because this file's reasons to
// change its own fixtures are its own.
async function writeSessionFiles(home, pid, { state: body, key } = {}) {
  const dir = join(home, ".claude", "sessions");
  await mkdir(dir, { recursive: true });
  if (body !== undefined) {
    await writeFile(join(dir, `${pid}.json`), typeof body === "string" ? body : JSON.stringify(body));
  }
  if (key !== undefined) {
    const name = `${pid}.${"a".repeat(64)}.key`;
    await writeFile(join(dir, name), typeof key === "string" ? key : JSON.stringify(key));
  }
  return dir;
}

test("listSessionFiles finds every well-formed file", async () => {
  const home = join(root, "home-multi");
  const pidA = 3000001;
  const pidB = 3000002;
  const dir = await writeSessionFiles(home, pidA, { state: state(pidA), key: { peerToken: "x" } });
  await writeSessionFiles(home, pidB, {
    state: state(pidB, { kind: "bg", sessionId: OTHER_SESSION_ID, name: "jarvis-spare" }),
  });
  // Neither of these matches the <pid>.json shape and both must be ignored,
  // even though the .key file sits right next to a real state file.
  await writeFile(join(dir, "notes.txt"), "not a session file");

  const records = await listSessionFiles({ home, alive: async () => true });
  assert.deepEqual(
    records.map((r) => r.sessionId).sort(),
    [OTHER_SESSION_ID, SESSION_ID].sort(),
  );
});

test("listSessionFiles keeps only the first file for a duplicate session id", async () => {
  // Two state files claiming the same sessionId is the file-source version of
  // the CLI listing carrying a duplicate: whichever the directory listing
  // happens to return first is kept, and the second is dropped rather than
  // producing two rows a later stage could act on as if they were a fork.
  const home = join(root, "home-duplicate");
  const pidA = 3000004;
  const pidB = 3000005;
  await writeSessionFiles(home, pidA, { state: state(pidA) });
  await writeSessionFiles(home, pidB, { state: state(pidB) });

  const records = await listSessionFiles({ home, alive: async () => true });
  assert.equal(records.length, 1);
  assert.equal(records[0].sessionId, SESSION_ID);
});

test("a filename with a leading zero is never read as a pid", async () => {
  const home = join(root, "home-leading-zero");
  const dir = join(home, ".claude", "sessions");
  await mkdir(dir, { recursive: true });
  // "0" here alone would parse to pid 0, which asPid-style validation
  // elsewhere in this codebase refuses to act on -- but this file is
  // excluded before parsing is ever attempted, on shape alone.
  await writeFile(join(dir, "03000006.json"), JSON.stringify(state(3000006)));

  const records = await listSessionFiles({ home, alive: async () => true });
  assert.deepEqual(records, []);
});

test("a dead pid's file is dropped", async () => {
  const home = join(root, "home-dead");
  const pid = 3000003;
  await writeSessionFiles(home, pid, { state: state(pid) });
  const records = await listSessionFiles({ home, alive: async () => false });
  assert.deepEqual(records, []);
});

test("a missing sessions directory is nothing running, not a failure", async () => {
  const home = join(root, "home-nothing-here");
  const records = await listSessionFiles({ home, alive: async () => true });
  assert.deepEqual(records, []);
});

// ---------------------------------------------------------------------------
// processAlive -- against real processes, not mocks
// ---------------------------------------------------------------------------

test("processAlive against process.pid with the real starttime is true, and with a wrong procStart is false", async () => {
  // Same last-")" slicing processAlive itself does, done here independently
  // so the test proves the function against a starttime it did not compute.
  const text = readFileSync("/proc/self/stat", "utf8");
  const idx = text.lastIndexOf(")");
  const fields = text.slice(idx + 1).trim().split(/\s+/);
  const realProcStart = fields[19];

  assert.equal(await processAlive(process.pid, realProcStart), true);
  assert.equal(await processAlive(process.pid, "not-the-real-starttime"), false);
});

test("on Linux a state file without procStart is not trusted as alive", async () => {
  // This used to fall back to a bare kill(pid, 0), which cannot distinguish
  // the real session from an unrelated process now holding the same pid --
  // exactly the gap a missing procStart would otherwise let through for
  // free, given that this pid is what stopSession goes on to SIGTERM.
  assert.equal(await processAlive(process.pid, null), false);
  assert.equal(await processAlive(process.pid, ""), false);
});

test("processAlive on a pid that surely does not exist is false, with or without a procStart", async () => {
  // spawnSync blocks until the child has actually exited, so there is no race
  // between "it exited" and the liveness check below -- unlike a freshly
  // chosen large pid number, this one is guaranteed to have been a real
  // process that is now gone.
  const finished = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(await processAlive(finished.pid, null), false);
  // A procStart that cannot be read back (the pid is gone, so /proc/<pid>/stat
  // is gone with it) must also read as dead rather than hopping down to the
  // kill(0) fallback -- the unreadable-/proc branch, not just the
  // missing-procStart one.
  assert.equal(await processAlive(finished.pid, "299878812"), false);
});
