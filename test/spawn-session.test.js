import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFakeCli } from "./helpers.js";
import {
  MAX_SESSIONS,
  MAX_TASK_CHARS,
  MAX_BRIEF_CHARS,
  buildStartArgs,
  newSessionId,
  MAX_REPLY_CHARS,
  buildTellArgs,
  createInFlight,
  refuseStart,
  startSession,
  stopSession,
  tellSession,
} from "../lib/spawn-session.js";
import { MAX_LISTED } from "../lib/agents.js";

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

test("a session starts detached, named, and with an id Dante chose", () => {
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
  // resume or queue against.
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

test("a brief, when there is one, is what the session is told, and the task still names it", () => {
  const args = buildStartArgs(spec({ brief: "Fix the flaky test. Do not touch lib/builder.js." }));
  assert.equal(args[args.length - 2], "--");
  assert.equal(args[args.length - 1], "Fix the flaky test. Do not touch lib/builder.js.");
  assert.ok(args.includes("-n"));
  assert.ok(args.includes("jarvis-1-fix-failing-builder-test"));
});

test("a start with a brief but no task is still not startable", () => {
  assert.equal(buildStartArgs(spec({ task: "", brief: "x" })), null);
});

test("a brief is capped and cleaned like a task, at its own larger limit", () => {
  const args = buildStartArgs(spec({ brief: "x".repeat(MAX_BRIEF_CHARS * 2) }));
  assert.equal(args[args.length - 1].length, MAX_BRIEF_CHARS);
  const argsWithControl = buildStartArgs(spec({ brief: "fix\u0000 the\u202e tests" }));
  assert.equal(argsWithControl[argsWithControl.length - 1], "fix the tests");
});

test("a brief keeps its line breaks, because its sections are its structure", () => {
  const brief = "Goal: x\nConstraints:\n- y";
  const args = buildStartArgs(spec({ brief }));
  assert.equal(args[args.length - 1], brief);
});

test("a follow-up no longer loses the end of a brief-length message", () => {
  const longText = "x".repeat(1500);
  const args = buildTellArgs({ sessionId: ID, text: longText });
  assert.equal(args[args.length - 1].length, 1500);
});

test("a follow-up keeps its line breaks too, for the same reason a start brief does", () => {
  const text = "Goal: x\nConstraints:\n- y";
  const args = buildTellArgs({ sessionId: ID, text });
  assert.equal(args[args.length - 1], text);
});

// ---------------------------------------------------------------------------
// startSession — against a real fake CLI on disk
// ---------------------------------------------------------------------------

let workspace;
const fake = {};

const writeFake = (name, body) => writeFakeCli(workspace, name, body);

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dante-spawn-"));

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

  // The daemon end of a stop. Logs what it was asked, then answers the way the
  // real CLI does.
  fake.stops = await writeFake(
    "claude-stops.cjs",
    [
      "const fs = require(\"node:fs\");",
      "fs.appendFileSync(process.env.STOP_LOG, process.argv.slice(2).join(\" \") + \"\\n\");",
      "console.log(\"stopped \" + process.argv[3]);",
    ].join("\n"),
  );

  // What the real CLI says of an id it has never heard of, verbatim.
  fake.noJob = await writeFake(
    "claude-no-job.cjs",
    [
      "console.error(\"No job matching 'zzzzzzzz'. Run 'claude agents' to list running sessions.\");",
      "process.exitCode = 1;",
    ].join("\n"),
  );

  // Never answers and ignores the polite ask, so the timeout is the only thing
  // that can end this call.
  fake.hangsOnStop = await writeFake(
    "claude-hangs-on-stop.cjs",
    ["process.on(\"SIGTERM\", () => {});", "setInterval(() => {}, 1000);"].join("\n"),
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

test("the session ceiling matches the panel's own cap, not a number of its own", () => {
  // A numbered line is exactly as sayable at fifteen as it was at five, which
  // is the whole reason this ceiling moved off its old, smaller default -- it
  // has no business drifting from MAX_LISTED (lib/agents.js) again on its own.
  assert.equal(MAX_SESSIONS, MAX_LISTED);
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

// ---------------------------------------------------------------------------
// buildTellArgs
// ---------------------------------------------------------------------------

test("a follow-up resumes the session it names and asks for one answer", () => {
  // --output-format json rather than stream-json: nobody is watching a
  // follow-up happen, only the answer is wanted.
  assert.deepEqual(buildTellArgs({ sessionId: ID, text: "also run the tests" }), [
    "-p",
    "--resume",
    ID,
    "--output-format",
    "json",
    "--",
    "also run the tests",
  ]);
});

test("a follow-up with nothing to say, or nowhere to say it, is not one", () => {
  assert.equal(buildTellArgs({ sessionId: ID, text: "" }), null);
  assert.equal(buildTellArgs({ sessionId: ID, text: null }), null);
  assert.equal(buildTellArgs({ sessionId: "not-a-uuid", text: "x" }), null);
  assert.equal(buildTellArgs(), null);
});

test("a follow-up goes after the terminator too", () => {
  const args = buildTellArgs({ sessionId: ID, text: "--version" });
  assert.equal(args[args.length - 2], "--");
  assert.equal(args[args.length - 1], "--version");
});

// ---------------------------------------------------------------------------
// tellSession
// ---------------------------------------------------------------------------

test("a session's answer comes back as the thing to say", async () => {
  const answers = await writeFake(
    "claude-answers.cjs",
    'console.log(JSON.stringify({ result: "  fixed the timeout assertion  " }));',
  );
  const result = await tellSession({ sessionId: ID, cwd: workspace, text: "how did it go" }, { bin: answers });
  assert.equal(result.ok, true);
  assert.equal(result.reply, "fixed the timeout assertion");
});

test("an answer longer than anyone will sit through is clipped", async () => {
  const long = await writeFake(
    "claude-long.cjs",
    `console.log(JSON.stringify({ result: "x".repeat(${MAX_REPLY_CHARS * 3}) }));`,
  );
  const result = await tellSession({ sessionId: ID, cwd: workspace, text: "how did it go" }, { bin: long });
  assert.equal(result.reply.length, MAX_REPLY_CHARS);
});

test("a session that took the message and said nothing is still a session that took it", async () => {
  const quiet = await writeFake("claude-quiet.cjs", 'console.log(JSON.stringify({ result: "" }));');
  const result = await tellSession({ sessionId: ID, cwd: workspace, text: "noted" }, { bin: quiet });
  assert.equal(result.ok, true);
  assert.equal(result.reply, "");
});

test("a session that refused says why", async () => {
  const refuses = await writeFake(
    "claude-tell-refuses.cjs",
    ['console.error("No conversation found to resume");', "process.exitCode = 1;"].join("\n"),
  );
  const result = await tellSession({ sessionId: ID, cwd: workspace, text: "x" }, { bin: refuses });
  assert.equal(result.ok, false);
  assert.match(result.error, /No conversation found/);
});

test("an answer that is not JSON is a failure rather than a sentence read aloud", async () => {
  const garbage = await writeFake("claude-tell-garbage.cjs", 'console.log("Usage: claude [options]");');
  const result = await tellSession({ sessionId: ID, cwd: workspace, text: "x" }, { bin: garbage });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not read/);
});

test("a session that never answers is abandoned rather than waited on forever", async () => {
  const hangs = await writeFake(
    "claude-tell-hangs.cjs",
    ['process.on("SIGTERM", () => {});', "setInterval(() => {}, 1000);"].join("\n"),
  );
  const result = await tellSession({ sessionId: ID, cwd: workspace, text: "x" }, { bin: hangs, timeoutMs: 150 });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not answer in time/);
});

test("a follow-up with nowhere to run is refused before anything spawns", async () => {
  assert.equal((await tellSession({ sessionId: ID, text: "x" })).ok, false);
  assert.equal((await tellSession({ sessionId: ID, cwd: workspace, text: "" })).ok, false);
});

// ---------------------------------------------------------------------------
// createInFlight
// ---------------------------------------------------------------------------

test("a second run for a key still in flight is skipped rather than started", async () => {
  const guard = createInFlight();
  let resolveFirst;
  const gate = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const first = guard.run("a", async () => {
    await gate;
  });
  const second = await guard.run("a", async () => {});
  assert.equal(second, false);

  resolveFirst();
  assert.equal(await first, true);

  const third = await guard.run("a", async () => {});
  assert.equal(third, true);
});

test("a run whose function throws still releases its key", async () => {
  const guard = createInFlight();
  await assert.rejects(
    guard.run("a", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(await guard.run("a", async () => {}), true);
});

// ---------------------------------------------------------------------------
// stopSession
// ---------------------------------------------------------------------------

// A kill(2) stand-in over a set of pids that are "alive", so the polite-stop
// sequence can be tested without a real process to sacrifice.
function fakeKill(alive, { refuse = false, ignoresTerm = false } = {}) {
  const signals = [];
  const live = new Set(alive);
  const kill = (pid, signal) => {
    signals.push([pid, signal]);
    if (refuse) {
      const err = new Error("operation not permitted");
      err.code = "EPERM";
      throw err;
    }
    if (!live.has(pid)) {
      const err = new Error("no such process");
      err.code = "ESRCH";
      throw err;
    }
    if (signal === "SIGTERM" && !ignoresTerm) live.delete(pid);
  };
  kill.signals = signals;
  return kill;
}

test("stopping a session asks politely and confirms it went", async () => {
  const kill = fakeKill([4242]);
  const result = await stopSession({ pid: 4242, name: "jarvis-1" }, { kill });
  assert.equal(result.ok, true);
  assert.deepEqual(kill.signals[0], [4242, "SIGTERM"]);
});

test("a session mid-write is never killed outright", async () => {
  // It is holding a real file in a real repository. The difference between a
  // polite stop and a hard one is a half-written source file nobody asked for.
  const kill = fakeKill([4242], { ignoresTerm: true });
  const result = await stopSession({ pid: 4242 }, { kill, timeoutMs: 120, pollMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error, /still running/);
  assert.ok(!kill.signals.some(([, signal]) => signal === "SIGKILL"), JSON.stringify(kill.signals));
});

test("a session that had already finished is not a failure to stop it", async () => {
  const result = await stopSession({ pid: 4242 }, { kill: fakeKill([]) });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyGone, true);
});

test("a pid that could signal a whole process group is refused", async () => {
  // kill(2) reads 0 as "my own process group" and a negative pid as that whole
  // group. This is the one function that would act on it.
  for (const pid of [0, -1, -4242, 1.5, "4242", null, undefined]) {
    const kill = fakeKill([]);
    const result = await stopSession({ pid }, { kill });
    assert.equal(result.ok, false, String(pid));
    assert.equal(kill.signals.length, 0, String(pid));
  }
});

test("a session this process may not signal says so rather than claiming success", async () => {
  const result = await stopSession({ pid: 4242 }, { kill: fakeKill([4242], { refuse: true }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /not allowed/);
});

test("a real process really does stop", async () => {
  // The fake above proves the sequence; this proves the sequence is the right
  // one for an actual pid.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const result = await stopSession({ pid: child.pid }, { timeoutMs: 4000, pollMs: 50 });
    assert.equal(result.ok, true);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already stopped, which is what the assertion above wanted.
    }
  }
});

// The daemon path. Background sessions belong to the Claude Code daemon, and a
// worker that is merely signalled comes back ten seconds later -- see the
// comment on stopSession. These pin the other ask.

// A kill(2) stand-in whose pid is alive until the fake CLI has been asked --
// which is how a real worker behaves: `claude stop` is what ends it.
function killUntilAsked(pid, askedLog) {
  const signals = [];
  const kill = (target, signal) => {
    signals.push([target, signal]);
    if (target === pid && !existsSync(askedLog)) return;
    const err = new Error("no such process");
    err.code = "ESRCH";
    throw err;
  };
  kill.signals = signals;
  return kill;
}

test("a background session is stopped through the daemon, never by signalling its worker", async () => {
  const askedLog = join(workspace, "stop-asked.log");
  process.env.STOP_LOG = askedLog;
  const kill = killUntilAsked(4242, askedLog);
  const record = { pid: 4242, id: "3ee7f1c2", kind: "background", name: "stop-probe" };
  const result = await stopSession(record, { kill, bin: fake.stops, pollMs: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.via, "daemon");
  assert.equal(readFileSync(askedLog, "utf8").trim(), "stop 3ee7f1c2");
  // Signal 0 is only a question. Anything else would be the bug this fixes.
  assert.ok(kill.signals.every(([, signal]) => signal === 0), JSON.stringify(kill.signals));
});

test("a background session the daemon refuses to stop is reported, not signalled instead", async () => {
  // Falling back to SIGTERM here would land in the resume-after-ten-seconds
  // this path exists to avoid, while sounding like a success.
  const kill = fakeKill([4242]);
  const record = { pid: 4242, id: "3ee7f1c2", kind: "background" };
  const result = await stopSession(record, { kill, bin: fake.noJob });
  assert.equal(result.ok, false);
  assert.equal(result.via, "daemon");
  assert.match(result.error, /No job matching/);
  assert.ok(!kill.signals.some(([, signal]) => signal === "SIGTERM"), JSON.stringify(kill.signals));
});

test("a background session listed without a pid can still be stopped through the daemon", async () => {
  // The listing drops the pid for the ten seconds between a worker dying and
  // the daemon resuming it -- exactly when a stop is most wanted.
  process.env.STOP_LOG = join(workspace, "stop-nopid.log");
  const kill = fakeKill([]);
  const result = await stopSession({ id: "3ee7f1c2", kind: "background" }, { kill, bin: fake.stops });
  assert.equal(result.ok, true);
  assert.equal(result.via, "daemon");
  assert.equal(kill.signals.length, 0);
});

test("a background session whose worker had already left is reported as already gone", async () => {
  process.env.STOP_LOG = join(workspace, "stop-gone.log");
  const result = await stopSession({ pid: 4242, id: "3ee7f1c2", kind: "background" }, { kill: fakeKill([]), bin: fake.stops });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyGone, true);
  // Still asked, so the lease is settled and the daemon does not resume it.
  assert.equal(existsSync(join(workspace, "stop-gone.log")), true);
});

test("a background session whose worker outlives the daemon's answer is not called stopped", async () => {
  process.env.STOP_LOG = join(workspace, "stop-lingers.log");
  const kill = fakeKill([4242], { ignoresTerm: true });
  const record = { pid: 4242, id: "3ee7f1c2", kind: "background" };
  const result = await stopSession(record, { kill, bin: fake.stops, timeoutMs: 120, pollMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error, /still running/);
});

test("an interactive session has no daemon to ask and is still signalled", async () => {
  // fake.noJob would fail the stop if it were consulted; the signal path must
  // not go near the CLI.
  const kill = fakeKill([4242]);
  const result = await stopSession({ pid: 4242, id: null, kind: "interactive" }, { kill, bin: fake.noJob });
  assert.equal(result.ok, true);
  assert.equal(result.via, "signal");
  assert.deepEqual(kill.signals[0], [4242, "SIGTERM"]);
});

test("a listed id that could be read as an option never becomes a CLI argument", async () => {
  const askedLog = join(workspace, "stop-flag.log");
  process.env.STOP_LOG = askedLog;
  const kill = fakeKill([4242]);
  for (const id of ["--all", "-", "", " ", "3ee7 f1c2", null]) {
    const result = await stopSession({ pid: 4242, id, kind: "background" }, { kill, bin: fake.stops });
    assert.equal(result.via, "signal", JSON.stringify(id));
  }
  assert.equal(existsSync(askedLog), false);
});

test("a CLI that never answers a stop is abandoned rather than waited on forever", async () => {
  const kill = fakeKill([4242]);
  const record = { pid: 4242, id: "3ee7f1c2", kind: "background" };
  const result = await stopSession(record, { kill, bin: fake.hangsOnStop, timeoutMs: 150, killGraceMs: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.via, "daemon");
  assert.match(result.error, /did not answer/);
});

test("a missing CLI is a stop that did not go through, not a crash", async () => {
  const record = { pid: 4242, id: "3ee7f1c2", kind: "background" };
  const result = await stopSession(record, { kill: fakeKill([4242]), bin: join(workspace, "nope") });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be started/);
});
