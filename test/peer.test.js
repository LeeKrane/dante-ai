import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRIORITIES,
  DEFAULT_PRIORITY,
  MAX_MESSAGE_CHARS,
  CONNECT_TIMEOUT_MS,
  buildAuthFrame,
  buildMessageFrame,
  encodeFrames,
  steerText,
  planDelivery,
  vetSocketPath,
  readPeerAddress,
  sendToSession,
} from "../lib/peer.js";

const SESSION_ID = "abcd1234-0000-4000-8000-000000000000";
const OTHER_SESSION_ID = "ffffffff-0000-4000-8000-000000000000";
const TOKEN = "0123456789abcdef0123456789abcdef";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("PRIORITIES, DEFAULT_PRIORITY and CONNECT_TIMEOUT_MS agree with each other", () => {
  assert.deepEqual([...PRIORITIES].sort(), ["later", "next", "now"]);
  assert.ok(PRIORITIES.has(DEFAULT_PRIORITY), "the default must be one of the priorities it falls back from");
  assert.ok(Number.isFinite(CONNECT_TIMEOUT_MS) && CONNECT_TIMEOUT_MS > 0);
});

// ---------------------------------------------------------------------------
// buildAuthFrame
// ---------------------------------------------------------------------------

test("a well-formed token becomes an auth frame", () => {
  assert.deepEqual(buildAuthFrame(TOKEN), { type: "auth", token: TOKEN });
});

test("anything that is not exactly 32 lowercase hex characters is refused, not thrown", () => {
  for (const bad of [
    TOKEN.toUpperCase(),
    TOKEN.slice(0, -1),
    `${TOKEN}0`,
    "not-hex-at-all-000000000000000000",
    "",
    "   ",
    null,
    undefined,
    42,
  ]) {
    assert.equal(buildAuthFrame(bad), null, String(bad));
  }
});

// ---------------------------------------------------------------------------
// buildMessageFrame
// ---------------------------------------------------------------------------

test("a well-formed request becomes a user frame with sane defaults", () => {
  const frame = buildMessageFrame({ sessionId: SESSION_ID, text: "also run the tests" });
  assert.equal(frame.type, "user");
  assert.equal(frame.session_id, SESSION_ID);
  assert.equal(frame.message.content, "also run the tests");
  assert.equal(frame.priority, DEFAULT_PRIORITY);
  assert.match(frame.uuid, UUID_SHAPE);
});

test("every priority the CLI knows is honoured", () => {
  for (const priority of PRIORITIES) {
    const frame = buildMessageFrame({ sessionId: SESSION_ID, text: "x", priority });
    assert.equal(frame.priority, priority);
  }
});

test("a priority the CLI would not recognise falls back to the default", () => {
  for (const bad of ["URGENT", "immediately", "", null, undefined, 42]) {
    const frame = buildMessageFrame({ sessionId: SESSION_ID, text: "x", priority: bad });
    assert.equal(frame.priority, DEFAULT_PRIORITY, String(bad));
  }
});

test("a caller-supplied uuid is kept when it is shaped like one", () => {
  const uuid = randomUUID();
  const frame = buildMessageFrame({ sessionId: SESSION_ID, text: "x", uuid });
  assert.equal(frame.uuid, uuid);
});

test("a caller-supplied uuid that is not one is replaced rather than passed through", () => {
  const frame = buildMessageFrame({ sessionId: SESSION_ID, text: "x", uuid: "not-a-uuid" });
  assert.notEqual(frame.uuid, "not-a-uuid");
  assert.match(frame.uuid, UUID_SHAPE);
});

test("a session id that is not a session id leaves nothing to build", () => {
  for (const bad of ["", "abcd1234", "not-a-uuid", SESSION_ID.slice(0, -1), 42, null, undefined]) {
    assert.equal(buildMessageFrame({ sessionId: bad, text: "x" }), null, String(bad));
  }
});

test("text that cleans to nothing leaves nothing to send", () => {
  for (const bad of ["", "   ", "\n\n", null, undefined, 42]) {
    assert.equal(buildMessageFrame({ sessionId: SESSION_ID, text: bad }), null, String(bad));
  }
});

test("whitespace is collapsed before the unprintable strip, so a newline does not fuse two words", () => {
  // \n sits inside the UNPRINTABLE range as well as being whitespace. Strip it
  // first and the words on either side fuse into one; collapse first and the
  // strip is left with an ordinary space to leave alone. This is the same
  // ordering lib/spawn-session.js's clean() uses, and for the same reason.
  const frame = buildMessageFrame({ sessionId: SESSION_ID, text: "fix the tests\nthen push" });
  assert.equal(frame.message.content, "fix the tests then push");
});

test("control characters and bidi overrides never reach the frame", () => {
  const frame = buildMessageFrame({ sessionId: SESSION_ID, text: "fix\u0000 the\u202e tests" });
  assert.equal(frame.message.content, "fix the tests");
});

test("text longer than the cap is capped, not carried whole", () => {
  const frame = buildMessageFrame({ sessionId: SESSION_ID, text: "x".repeat(MAX_MESSAGE_CHARS * 3) });
  assert.equal(frame.message.content.length, MAX_MESSAGE_CHARS);
});

// ---------------------------------------------------------------------------
// encodeFrames
// ---------------------------------------------------------------------------

test("every frame becomes its own newline-terminated line, in order", () => {
  const auth = buildAuthFrame(TOKEN);
  const message = buildMessageFrame({ sessionId: SESSION_ID, text: "hi" });
  assert.equal(encodeFrames([auth, message]), `${JSON.stringify(auth)}\n${JSON.stringify(message)}\n`);
});

test("null and non-object entries are dropped rather than failing the whole batch", () => {
  const auth = buildAuthFrame(TOKEN);
  const message = buildMessageFrame({ sessionId: SESSION_ID, text: "hi" });
  const encoded = encodeFrames([null, auth, "nope", 42, message, undefined, [1, 2]]);
  assert.equal(encoded, `${JSON.stringify(auth)}\n${JSON.stringify(message)}\n`);
});

test("an empty list, one that is all nulls, or a non-array encodes to nothing", () => {
  assert.equal(encodeFrames([]), "");
  assert.equal(encodeFrames([null, null]), "");
  assert.equal(encodeFrames("not an array"), "");
  assert.equal(encodeFrames(null), "");
  assert.equal(encodeFrames(undefined), "");
});

// ---------------------------------------------------------------------------
// steerText
// ---------------------------------------------------------------------------

test("a steer carries the new instruction plus one sentence naming it a steer", () => {
  const text = steerText("also fix the header");
  assert.ok(text.startsWith("also fix the header"));
  assert.match(text, /change of instruction/i);
});

test("text that cleans to nothing produces no steer at all", () => {
  for (const bad of ["", "   ", "\n\n", null, undefined, 42]) {
    assert.equal(steerText(bad), "", String(bad));
  }
});

test("the cap applies to the caller's text, not to the appended sentence", () => {
  const long = "x".repeat(MAX_MESSAGE_CHARS * 3);
  const text = steerText(long);
  // Exactly MAX_MESSAGE_CHARS worth of the caller's text survives, followed by
  // something more (the appended sentence) that is not itself more "x"s.
  assert.ok(text.startsWith("x".repeat(MAX_MESSAGE_CHARS)));
  assert.ok(!text.startsWith("x".repeat(MAX_MESSAGE_CHARS + 1)));
  assert.ok(text.length > MAX_MESSAGE_CHARS);
});

test("an instruction that ends mid-sentence is stopped before the steer sentence starts", () => {
  assert.equal(
    steerText("also fix the header"),
    "also fix the header. This is a change of instruction to fold into the work already in progress, not a new task.",
  );
});

test("an instruction that already ends in punctuation is not given a second full stop", () => {
  for (const ending of [".", "!", "?"]) {
    assert.ok(steerText(`stop that${ending}`).startsWith(`stop that${ending} This is`), ending);
  }
});

// ---------------------------------------------------------------------------
// planDelivery
// ---------------------------------------------------------------------------

test("telling a session something queues it behind the work already in flight", () => {
  assert.deepEqual(planDelivery("tell", "run the tests as well"), {
    priority: "next",
    content: "run the tests as well",
  });
});

test("interrupting a session cuts in front of that work and says so", () => {
  const plan = planDelivery("interrupt", "use the other branch");
  assert.equal(plan.priority, "now");
  assert.ok(plan.content.startsWith("use the other branch."));
  assert.match(plan.content, /change of instruction/i);
});

test("the verb is read case-insensitively, because it arrives through a model", () => {
  assert.equal(planDelivery("INTERRUPT", "stop and rebase").priority, "now");
});

test("any verb that is not interrupt is delivered the patient way", () => {
  for (const verb of ["tell", "", null, undefined, "shout"]) {
    assert.equal(planDelivery(verb, "carry on").priority, "next", String(verb));
  }
});

test("a plan with nothing left to say after cleaning is no plan at all", () => {
  for (const verb of ["tell", "interrupt"]) {
    for (const bad of ["", "   ", "\n", null, 42]) {
      assert.equal(planDelivery(verb, bad), null, `${verb} ${String(bad)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// vetSocketPath
// ---------------------------------------------------------------------------

test("a well-formed default socket path is accepted", () => {
  const path = "/run/user/1000/cc-socks/1550325.sock";
  assert.equal(vetSocketPath(path, 1550325), path);
});

test("a well-formed moved-aside socket path is accepted", () => {
  const path = "/run/user/1000/cc-socks/1550325-deadbeef.sock";
  assert.equal(vetSocketPath(path, 1550325), path);
});

test("the /tmp fallback directory name is accepted", () => {
  const path = "/tmp/cc-socks-1000/1550325.sock";
  assert.equal(vetSocketPath(path, 1550325), path);
});

test("a relative path, an empty string, or a non-string is refused", () => {
  for (const bad of ["run/user/1000/cc-socks/1550325.sock", "", null, undefined, 42, {}]) {
    assert.equal(vetSocketPath(bad, 1550325), null, String(bad));
  }
});

test("a pid that is not a positive integer refuses even a well-formed path", () => {
  const path = "/run/user/1000/cc-socks/1550325.sock";
  for (const badPid of [0, -1, 1.5, "1550325", null, undefined, NaN]) {
    assert.equal(vetSocketPath(path, badPid), null, String(badPid));
  }
});

test("a basename naming a different pid is refused", () => {
  assert.equal(vetSocketPath("/run/user/1000/cc-socks/999.sock", 1550325), null);
});

test("a basename not shaped like <pid>.sock or <pid>-<8 hex>.sock is refused", () => {
  for (const path of [
    "/run/user/1000/cc-socks/1550325.socket",
    "/run/user/1000/cc-socks/1550325-zzzzzzzz.sock", // "z" is not hex
    "/run/user/1000/cc-socks/1550325-deadbee.sock", // seven hex chars, not eight
    "/run/user/1000/cc-socks/1550325-deadbeef00.sock", // ten hex chars, not eight
  ]) {
    assert.equal(vetSocketPath(path, 1550325), null, path);
  }
});

test("a parent directory that is not cc-socks or cc-socks-<digits> is refused", () => {
  for (const path of [
    "/run/user/1000/other/1550325.sock",
    "/run/user/1000/cc-sockss/1550325.sock",
    "/tmp/cc-socks-abc/1550325.sock", // suffix must be digits
    "/1550325.sock", // no parent directory at all worth naming
  ]) {
    assert.equal(vetSocketPath(path, 1550325), null, path);
  }
});

// ---------------------------------------------------------------------------
// readPeerAddress and sendToSession -- against real temp directories and a
// real unix socket server, not mocks.
// ---------------------------------------------------------------------------

let root;
let socksDir;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "jarvis-peer-"));
  // One shared directory for every socket in this file, laid out directly
  // under the mkdtemp root rather than nested under a home directory: a real
  // deployment's cc-socks lives under /run/user/<uid>, nothing to do with
  // $HOME. Unix socket paths are capped at roughly 104 bytes on Linux; a
  // mkdtemp root under the OS temp dir plus "/cc-socks/<pid>.sock" comes in
  // well under that (a sandboxed checkout nested many directories deep could
  // be a different story, which is why this is a real constraint and not
  // just tidiness).
  socksDir = join(root, "cc-socks");
  await mkdir(socksDir, { recursive: true });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

// Lays out <home>/.claude/sessions/<pid>.json and the matching *.key file,
// the same shape the CLI itself writes. `state`/`key` may be an object (JSON-
// stringified) or a raw string (for the malformed-JSON cases).
async function writeSessionFiles(home, pid, { state, key } = {}) {
  const dir = join(home, ".claude", "sessions");
  await mkdir(dir, { recursive: true });
  if (state !== undefined) {
    await writeFile(join(dir, `${pid}.json`), typeof state === "string" ? state : JSON.stringify(state));
  }
  if (key !== undefined) {
    // The 64 hex characters are a fingerprint, not a value readPeerAddress
    // checks against anything -- any run of 64 hex digits satisfies the shape
    // it matches the directory listing against.
    const name = `${pid}.${"a".repeat(64)}.key`;
    await writeFile(join(dir, name), typeof key === "string" ? key : JSON.stringify(key));
  }
  return dir;
}

test("a session with a well-formed state and key file has a reachable address", async () => {
  const pid = 1000001;
  const home = join(root, "home-happy");
  const socketPath = `/run/user/1000/cc-socks/${pid}.sock`;
  await writeSessionFiles(home, pid, {
    state: {
      pid,
      sessionId: SESSION_ID,
      cwd: "/x",
      startedAt: 1,
      procStart: 1,
      version: "2.1.246",
      peerFeatures: ["steer"],
      kind: "default",
      messagingSocketPath: socketPath,
      name: "n",
      status: "idle",
    },
    key: { peerToken: TOKEN, procStart: 1, pidDomain: "d" },
  });

  const address = await readPeerAddress(pid, { home });
  assert.deepEqual(address, { socketPath, sessionId: SESSION_ID, token: TOKEN, features: ["steer"] });
});

test("a missing state file is not reachable", async () => {
  const home = join(root, "home-missing-state");
  await mkdir(join(home, ".claude", "sessions"), { recursive: true });
  assert.equal(await readPeerAddress(1000002, { home }), null);
});

test("malformed JSON in the state file is not reachable", async () => {
  const pid = 1000003;
  const home = join(root, "home-bad-json");
  await writeSessionFiles(home, pid, { state: "{ not json" });
  assert.equal(await readPeerAddress(pid, { home }), null);
});

test("a missing key file is not reachable, even with a good state file", async () => {
  const pid = 1000004;
  const home = join(root, "home-missing-key");
  await writeSessionFiles(home, pid, {
    state: { sessionId: SESSION_ID, messagingSocketPath: `/run/user/1000/cc-socks/${pid}.sock` },
  });
  assert.equal(await readPeerAddress(pid, { home }), null);
});

test("a key file with a malformed token is not reachable", async () => {
  const pid = 1000005;
  const home = join(root, "home-bad-token");
  await writeSessionFiles(home, pid, {
    state: { sessionId: SESSION_ID, messagingSocketPath: `/run/user/1000/cc-socks/${pid}.sock` },
    key: { peerToken: "not-hex", procStart: 1 },
  });
  assert.equal(await readPeerAddress(pid, { home }), null);
});

test("a messagingSocketPath that fails vetting makes the whole address unreachable", async () => {
  const pid = 1000006;
  const home = join(root, "home-bad-socket-path");
  await writeSessionFiles(home, pid, {
    // Right shape of file, wrong directory name -- exactly the kind of thing
    // a stale or tampered state file would produce.
    state: { sessionId: SESSION_ID, messagingSocketPath: `/tmp/not-cc-socks/${pid}.sock` },
    key: { peerToken: TOKEN, procStart: 1 },
  });
  assert.equal(await readPeerAddress(pid, { home }), null);
});

test("peerFeatures normalises to an empty list when it is not a list of strings", async () => {
  const pid = 1000007;
  const home = join(root, "home-bad-features");
  await writeSessionFiles(home, pid, {
    state: {
      sessionId: SESSION_ID,
      messagingSocketPath: `/run/user/1000/cc-socks/${pid}.sock`,
      peerFeatures: [1, 2, 3],
    },
    key: { peerToken: TOKEN, procStart: 1 },
  });
  const address = await readPeerAddress(pid, { home });
  assert.deepEqual(address.features, []);
});

test("a pid that is not a positive integer is never reachable, whatever is on disk", async () => {
  for (const badPid of [0, -1, 1.5, "1000001", null, undefined, NaN]) {
    assert.equal(await readPeerAddress(badPid, { home: join(root, "home-happy") }), null, String(badPid));
  }
});

// ---------------------------------------------------------------------------
// sendToSession -- a real unix socket server records what it received.
// ---------------------------------------------------------------------------

async function listenOn(socketPath, onConnection, options = {}) {
  const server = createServer(options, onConnection);
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolvePromise());
  });
  return server;
}

function lineReader(socket, onLine) {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
}

async function writeReachableSession(pid, home) {
  const socketPath = join(socksDir, `${pid}.sock`);
  await writeSessionFiles(home, pid, {
    state: { sessionId: SESSION_ID, messagingSocketPath: socketPath, peerFeatures: [] },
    key: { peerToken: TOKEN, procStart: 1 },
  });
  return socketPath;
}

test("a message reaches a session's socket as an auth frame followed by a user frame, at the priority asked", async () => {
  const pid = 2000001;
  const home = join(root, "home-send-ok");
  const socketPath = await writeReachableSession(pid, home);

  const lines = [];
  const server = await listenOn(socketPath, (socket) => {
    lineReader(socket, (line) => {
      lines.push(line);
      // The server closes its end once it has both frames, which is what lets
      // the client's socket see a clean full close rather than hang on one.
      if (lines.length >= 2) socket.end();
    });
  });

  try {
    const result = await sendToSession({ pid, sessionId: SESSION_ID, text: "also run the tests", priority: "now" }, { home });
    assert.equal(result.ok, true);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { type: "auth", token: TOKEN });
    const message = JSON.parse(lines[1]);
    assert.equal(message.type, "user");
    assert.equal(message.session_id, SESSION_ID);
    assert.equal(message.priority, "now");
    assert.equal(message.message.content, "also run the tests");
  } finally {
    server.close();
  }
});

test("a session id that does not match the one on record is refused before anything is sent", async () => {
  const pid = 2000002;
  const home = join(root, "home-mismatch");
  const socketPath = await writeReachableSession(pid, home);

  let touched = false;
  const server = await listenOn(socketPath, () => {
    touched = true;
  });

  try {
    const result = await sendToSession({ pid, sessionId: OTHER_SESSION_ID, text: "x" }, { home });
    assert.equal(result.ok, false);
    assert.match(result.error, /not the session I meant/);
    assert.equal(touched, false, "a mismatched session id must never open a connection");
    assert.ok(!result.error.includes(TOKEN));
  } finally {
    server.close();
  }
});

test("a request with nothing left to say after cleaning is refused before anything is sent", async () => {
  const pid = 2000003;
  const home = join(root, "home-empty-text");
  const socketPath = await writeReachableSession(pid, home);

  let touched = false;
  const server = await listenOn(socketPath, () => {
    touched = true;
  });

  try {
    const result = await sendToSession({ pid, sessionId: SESSION_ID, text: "   " }, { home });
    assert.equal(result.ok, false);
    assert.match(result.error, /nothing to pass on/);
    assert.equal(touched, false);
  } finally {
    server.close();
  }
});

test("a socket with nothing listening on it is a clean failure to send, not a crash", async () => {
  const pid = 2000004;
  const home = join(root, "home-unreachable");
  // The path is well-formed and vets cleanly; nothing is ever bound to it.
  const socketPath = join(socksDir, `${pid}.sock`);
  await writeSessionFiles(home, pid, {
    state: { sessionId: SESSION_ID, messagingSocketPath: socketPath, peerFeatures: [] },
    key: { peerToken: TOKEN, procStart: 1 },
  });

  const result = await sendToSession({ pid, sessionId: SESSION_ID, text: "x" }, { home });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not reach/);
  assert.ok(!result.error.includes(TOKEN));
});

test("a session whose socket accepts but never closes is abandoned at the timeout, not waited on forever", async () => {
  const pid = 2000005;
  const home = join(root, "home-timeout");
  const socketPath = await writeReachableSession(pid, home);

  // Accepts and reads, but never ends its own side -- the shape a wedged peer
  // (or one just keeping the channel open for more messages later) takes.
  // allowHalfOpen matters here: without it, Node auto-closes the server's
  // writable side the moment the client's .end() delivers a FIN, which would
  // finish the handshake almost immediately and never exercise the timeout.
  const server = await listenOn(socketPath, (socket) => socket.resume(), { allowHalfOpen: true });

  try {
    const result = await sendToSession({ pid, sessionId: SESSION_ID, text: "x" }, { home, timeoutMs: 150 });
    assert.equal(result.ok, false);
    assert.match(result.error, /did not answer in time/);
    assert.ok(!result.error.includes(TOKEN));
  } finally {
    server.close();
  }
});

test("a pid with no session recorded for it at all is simply not reachable", async () => {
  const result = await sendToSession(
    { pid: 2000006, sessionId: SESSION_ID, text: "x" },
    { home: join(root, "home-nonexistent") },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /not reachable/);
});
