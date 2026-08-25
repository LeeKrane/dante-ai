import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_SESSIONS,
  MAX_TASK_CHARS,
  buildStartArgs,
  newSessionId,
  refuseStart,
  startSession,
} from "../lib/spawn-session.js";

const ID = "abcd1234-0000-4000-8000-000000000000";

function spec(overrides = {}) {
  return {
    name: "jarvis-1-fix-failing-builder-test",
    sessionId: ID,
    task: "fix the failing builder test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildStartArgs
// ---------------------------------------------------------------------------

test("a session starts detached, named, and with an id jarvis chose", () => {
  // The id is assigned rather than scraped back out of the output, which is
  // what lets everything afterwards refer to this session without waiting.
  assert.deepEqual(buildStartArgs(spec()), [
    "--bg",
    "-n",
    "jarvis-1-fix-failing-builder-test",
    "--session-id",
    ID,
    "--",
    "fix the failing builder test",
  ]);
});

test("the task always comes after the options terminator", () => {
  // A task that begins with a dash is a sentence someone said, not a flag. The
  // terminator is what keeps that true.
  const args = buildStartArgs(spec({ task: "--help me name this thing" }));
  assert.equal(args[args.length - 2], "--");
  assert.equal(args[args.length - 1], "--help me name this thing");
});

test("a kind's model, effort and prompt reach the command line", () => {
  const args = buildStartArgs(
    spec({ model: "opus", effort: "high", systemPrompt: "Review the changes and report." }),
  );
  assert.deepEqual(args, [
    "--bg",
    "-n",
    "jarvis-1-fix-failing-builder-test",
    "--session-id",
    ID,
    "--model",
    "opus",
    "--effort",
    "high",
    "--append-system-prompt",
    "Review the changes and report.",
    "--",
    "fix the failing builder test",
  ]);
});

test("nothing on this path can ever remove a session's guardrails", () => {
  // Voice is a lossy channel. A misheard sentence must not be able to produce
  // a session that skips every permission prompt — if you want that mode you
  // type it in a terminal, where you can see what you asked for.
  // What matters is the flag region — everything before the terminator. After
  // it, the same words are prompt text the session reads, which is harmless and
  // is the whole reason the terminator is there.
  const flagsOf = (args) => (args ?? []).slice(0, (args ?? []).indexOf("--"));

  for (const hostile of [
    "--dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "-p --dangerously-skip-permissions",
  ]) {
    for (const field of ["task", "name", "model", "effort", "systemPrompt"]) {
      const flags = flagsOf(buildStartArgs(spec({ [field]: hostile })));
      assert.ok(!flags.some((arg) => arg.startsWith("--dangerously")), `${field}=${hostile}`);
      assert.ok(!flags.includes("--permission-mode"), `${field}=${hostile}`);
      assert.ok(!flags.includes("bypassPermissions"), `${field}=${hostile}`);
    }
  }
});

test("a value that would be read as a flag is refused rather than escaped", () => {
  // There is no shell here — spawn takes an argv array — but the CLI would
  // still read a leading dash as an option, and that is the class to shut.
  const args = buildStartArgs(spec({ name: "-n", model: "-x", effort: "-y" }));
  assert.equal(args, null, "a name that is a flag leaves nothing to call the session");
  assert.equal(buildStartArgs(spec({ model: "-x" })).includes("--model"), false);
  assert.equal(buildStartArgs(spec({ effort: "-y" })).includes("--effort"), false);
});

test("a request with nothing to do, or nothing to call it, is not startable", () => {
  assert.equal(buildStartArgs(spec({ task: "" })), null);
  assert.equal(buildStartArgs(spec({ task: "   " })), null);
  assert.equal(buildStartArgs(spec({ task: null })), null);
  assert.equal(buildStartArgs(spec({ name: "" })), null);
  assert.equal(buildStartArgs(spec({ name: undefined })), null);
  assert.equal(buildStartArgs(), null);
});

test("a session id that is not a session id is refused", () => {
  // --session-id wants a uuid. Anything else starts a session that nothing can
  // resume, queue against, or thread a Slack conversation by.
  for (const bad of ["", "abcd1234", "not-a-uuid", ID.slice(0, -1), 42, null]) {
    assert.equal(buildStartArgs(spec({ sessionId: bad })), null, String(bad));
  }
  assert.ok(buildStartArgs(spec({ sessionId: newSessionId() })));
});

test("a task longer than anyone spoke is clipped rather than carried whole", () => {
  const args = buildStartArgs(spec({ task: "x".repeat(MAX_TASK_CHARS * 3) }));
  assert.equal(args[args.length - 1].length, MAX_TASK_CHARS);
});

test("control characters and bidi overrides never reach the command line", () => {
  const args = buildStartArgs(spec({ task: "fix\u0000 the\u202e tests" }));
  assert.equal(args[args.length - 1], "fix the tests");
});

test("a multi-line task becomes one line", () => {
  // It is an argv token, not a document, and a newline in one is the kind of
  // thing that forges structure wherever the command is later rendered.
  const args = buildStartArgs(spec({ task: "fix the tests\nthen push" }));
  assert.equal(args[args.length - 1], "fix the tests then push");
});

// ---------------------------------------------------------------------------
// startSession — against a real fake CLI on disk
// ---------------------------------------------------------------------------

let workspace;
const fake = {};

async function writeFake(name, body) {
  const path = join(workspace, name);
  await writeFile(path, ["#!/usr/bin/env node", body].join("\n"), { mode: 0o755 });
  return path;
}

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "jarvis-spawn-"));

  // A background agent detaches and leaves the parent alone, which from here
  // looks like a clean exit.
  fake.detaches = await writeFake("claude-detaches.cjs", 'console.log("started");');

  // Refuses outright: an unknown flag, a model that does not exist, a login
  // that expired. All of them look like this.
  fake.refuses = await writeFake(
    "claude-refuses.cjs",
    ['console.error("error: unknown option --bg");', "process.exitCode = 1;"].join("\n"),
  );

  // Alive past the startup window below, and then gone. A session started this
  // way is deliberately detached, so a fake that ran forever really would run
  // forever -- and node's test runner waits on it.
  fake.lingers = await writeFake("claude-lingers.cjs", "setTimeout(() => {}, 400);");

  // Writes its argv and cwd where the test can read them back.
  fake.records = await writeFake(
    "claude-records.cjs",
    [
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.env.RECORD_TO, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));',
    ].join("\n"),
  );
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

test("a session that started is reported started, by name and id", async () => {
  const result = await startSession({ ...spec(), cwd: workspace }, { bin: fake.detaches });
  assert.equal(result.ok, true);
  assert.equal(result.name, "jarvis-1-fix-failing-builder-test");
  assert.equal(result.sessionId, ID);
});

test("a session still running when the window closes is a session that started", async () => {
  // The ordinary successful case. Waiting for it to finish would defeat the
  // entire point of starting one by voice.
  const result = await startSession({ ...spec(), cwd: workspace }, { bin: fake.lingers, startupMs: 120 });
  assert.equal(result.ok, true);
});

test("a CLI that refuses says why, in words rather than a stack", async () => {
  const result = await startSession({ ...spec(), cwd: workspace }, { bin: fake.refuses });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown option/);
});

test("a CLI that is not installed is a refusal, not a crash", async () => {
  const result = await startSession({ ...spec(), cwd: workspace }, { bin: join(workspace, "nope") });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be started/);
});

test("a session without a workspace to run in is refused before anything spawns", async () => {
  assert.equal((await startSession(spec(), { bin: fake.detaches })).ok, false);
  assert.equal((await startSession({ ...spec(), cwd: "" }, { bin: fake.detaches })).ok, false);
});

test("an unstartable request never reaches a child process", async () => {
  const result = await startSession({ ...spec({ task: "" }), cwd: workspace }, { bin: fake.detaches });
  assert.equal(result.ok, false);
  assert.match(result.error, /not startable/);
});

test("the session runs in the repository it was asked for, with the arguments it was given", async () => {
  const record = join(workspace, "record.json");
  const previous = process.env.RECORD_TO;
  process.env.RECORD_TO = record;
  try {
    const result = await startSession(
      { ...spec({ model: "opus" }), cwd: workspace },
      { bin: fake.records, startupMs: 2000 },
    );
    assert.equal(result.ok, true);
    const { readFileSync } = await import("node:fs");
    const written = JSON.parse(readFileSync(record, "utf8"));
    assert.deepEqual(written.args, buildStartArgs(spec({ model: "opus" })));
    assert.equal(written.cwd, workspace);
  } finally {
    if (previous === undefined) delete process.env.RECORD_TO;
    else process.env.RECORD_TO = previous;
  }
});

// ---------------------------------------------------------------------------
// refuseStart
// ---------------------------------------------------------------------------

const WORKSPACE = { alias: "jarvis", path: "/home/you/development/jarvis" };

test("a startable request is not refused", () => {
  assert.equal(refuseStart({ task: "fix the tests" }, { workspace: WORKSPACE, running: 2 }), null);
});

test("a refusal is a sentence to say, not an error to catch", () => {
  // Every reason to refuse here is something a person is waiting to hear.
  const spoken = refuseStart({ task: "" }, { workspace: WORKSPACE });
  assert.match(spoken, /did not catch what that session should do/);
});

test("an unknown repository is refused by name, and the known ones are offered", () => {
  const spoken = refuseStart({ task: "x", repo: "fitness" }, { workspaces: { jarvis: "/p", api: "/q" } });
  assert.match(spoken, /fitness/);
  assert.match(spoken, /jarvis, api/);
});

test("no repository at all asks which one rather than guessing", () => {
  assert.match(refuseStart({ task: "x" }, { workspaces: { jarvis: "/p" } }), /Which repository/);
});

test("with no repositories known at all, the answer says so instead of listing nothing", () => {
  const spoken = refuseStart({ task: "x" }, { workspaces: {} });
  assert.match(spoken, /do not know where to start that/);
  assert.ok(!spoken.includes("I know ."), spoken);
});

test("the ceiling is counted from the roster, so a session started in a terminal counts", () => {
  const spoken = refuseStart({ task: "x" }, { workspace: WORKSPACE, running: MAX_SESSIONS });
  assert.match(spoken, new RegExp(`${MAX_SESSIONS} sessions running`));
});

test("a refusal for being full names the obvious one to stop", () => {
  // The difference between a refusal and a dead end: the next thing said is
  // "stop that one, then".
  const spoken = refuseStart(
    { task: "x" },
    { workspace: WORKSPACE, running: MAX_SESSIONS, oldestIdle: "jarvis-2-review" },
  );
  assert.match(spoken, /jarvis-2-review is idle/);
});

test("being full with nothing idle says so without inventing a name", () => {
  const spoken = refuseStart({ task: "x" }, { workspace: WORKSPACE, running: MAX_SESSIONS });
  assert.ok(!spoken.includes("idle"), spoken);
});
