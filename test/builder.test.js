import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpawnArgs, configuredMcpServers, run, stepSpec } from "../lib/builder.js";
import marketingSite from "../primitives/marketing-site.mjs";

// The command line is unit-tested directly. run() is tested against small fake
// CLIs written to a temp dir: real spawning, real streams, real exit codes and
// signals, but no network, no cost, and no dependency on Claude Code being
// installed on the machine running the suite.

// --- buildSpawnArgs -------------------------------------------------------

const primitive = {
  id: "test-thing",
  systemPrompt: (p) => `make ${p.subject}`,
  allowedTools: ["Write", "Edit", "Read"],
  mcp: [],
  outputContract: "index.html",
  doneLine: () => "done",
  timeoutMs: 5000,
};

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test("passes the repo settings file, so build hooks match the chat session", () => {
  const args = buildSpawnArgs(primitive, { subject: "coffee" });
  assert.ok(args.includes("--settings"));
  assert.ok(argValue(args, "--settings").endsWith("claude-settings.json"));
});

test("appends the primitive's system prompt, rendered with the params", () => {
  const args = buildSpawnArgs(primitive, { subject: "coffee" });
  assert.equal(argValue(args, "--append-system-prompt"), "make coffee");
});

test("grants exactly the primitive's allowed tools", () => {
  const args = buildSpawnArgs(primitive, { subject: "coffee" });
  const start = args.indexOf("--allowedTools");
  assert.notEqual(start, -1);
  assert.deepEqual(args.slice(start + 1, args.indexOf("--")), ["Write", "Edit", "Read"]);
});

test("runs headless with a streaming, unattended profile", () => {
  const args = buildSpawnArgs(primitive, { subject: "coffee" });
  assert.ok(args.includes("-p"));
  assert.equal(argValue(args, "--output-format"), "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.equal(argValue(args, "--permission-mode"), "acceptEdits");
});

test("terminates options immediately before the kick prompt", () => {
  const args = buildSpawnArgs(primitive, { subject: "coffee" });
  assert.equal(args[args.length - 2], "--");
  assert.ok(args[args.length - 1].length > 0);
  // The prompt must not be mistakable for one more variadic tool name.
  assert.ok(!args[args.length - 1].startsWith("-"));
});

test("pins the effort level instead of inheriting the machine's", () => {
  const args = buildSpawnArgs(primitive, { subject: "coffee" });
  // The settings file disables thinking, and the API rejects the top effort
  // levels in that state — an inherited "xhigh" 400s the build before it starts.
  assert.equal(argValue(args, "--effort"), "high");
  assert.equal(argValue(buildSpawnArgs(primitive, {}, { effort: "medium" }), "--effort"), "medium");
  assert.ok(!buildSpawnArgs(primitive, {}, { effort: "" }).includes("--effort"));
});

test("denies the tools that could reach outside the build directory", () => {
  const args = buildSpawnArgs(primitive, { subject: "coffee" });
  const start = args.indexOf("--disallowedTools");
  assert.notEqual(start, -1);
  const denied = args.slice(start + 1, args.indexOf("--allowedTools"));
  // Granting Write/Edit/Read does not, on its own, take Bash away from a build.
  assert.ok(denied.includes("Bash"));
  assert.ok(denied.includes("WebFetch"));
  assert.ok(denied.includes("Task"));
  // Never denied and granted at the same time; the deny would win silently.
  for (const tool of primitive.allowedTools) assert.ok(!denied.includes(tool));
});

test("a primitive that asks for a far-reaching tool by name still gets it", () => {
  const withBash = { ...primitive, allowedTools: ["Write", "Bash"] };
  const args = buildSpawnArgs(withBash, { subject: "coffee" });
  const denied = args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--allowedTools"));
  assert.ok(!denied.includes("Bash"));
  assert.ok(denied.includes("WebFetch")); // the rest of the floor stays in place
});

test("skips an MCP slot that is not configured on this machine", () => {
  const withMcp = { ...primitive, mcp: ["refero"] };
  const args = buildSpawnArgs(withMcp, { subject: "coffee" }, { mcpServers: [] });
  assert.ok(!args.some((a) => a.includes("refero")));
  assert.ok(!args.some((a) => a.startsWith("mcp__")));
});

test("grants a configured MCP slot and only that one", () => {
  const withMcp = { ...primitive, mcp: ["refero", "not-installed"] };
  const args = buildSpawnArgs(withMcp, { subject: "coffee" }, { mcpServers: ["refero", "other"] });
  assert.ok(args.includes("mcp__refero"));
  assert.ok(!args.includes("mcp__not-installed"));
  assert.ok(!args.includes("mcp__other")); // configured, but this primitive never asked for it
});

test("accepts the configured servers as a Set as well as an array", () => {
  const withMcp = { ...primitive, mcp: ["refero"] };
  const args = buildSpawnArgs(withMcp, { subject: "coffee" }, { mcpServers: new Set(["refero"]) });
  assert.ok(args.includes("mcp__refero"));
});

test("a primitive with no tools at all still produces a valid command line", () => {
  const bare = { ...primitive, allowedTools: [] };
  const args = buildSpawnArgs(bare, { subject: "coffee" });
  assert.ok(!args.includes("--allowedTools"));
  assert.equal(args[args.length - 2], "--");
});

// --- run ------------------------------------------------------------------

let workspace;
const fake = {};

// One canned stream-json line of each kind the parser cares about.
const TOOL_USE_LINE =
  'JSON.stringify({ type: "assistant", message: { content: [' +
  '{ type: "tool_use", name: "Write", input: { file_path: "index.html", content: BIG } }] } })';
const RESULT_LINE =
  'JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 2 })';

// Every invocation records the prompt it was given, so a chain can be checked
// for how many times the CLI ran and in what order.
const RECORD_CALL =
  'const i = process.argv.indexOf("--append-system-prompt");' +
  'fs.appendFileSync("calls.log", process.argv[i + 1].replace(/\\s+/g, " ") + "\\n");';

// The first step writes plan.md, the second writes index.html. Which one this
// invocation is is read off the directory the previous step left behind.
const CHAIN_WRITE = [
  RECORD_CALL,
  'const first = !fs.existsSync("plan.md");',
  'fs.writeFileSync(first ? "plan.md" : "index.html", first ? "the plan" : "<!doctype html>");',
].join("\n");

const CHAIN_BODY = (secondExit) => [
  CHAIN_WRITE,
  `console.log(${TOOL_USE_LINE});`,
  `if (!first) process.exitCode = ${secondExit};`,
  `console.log(${RESULT_LINE});`,
].join("\n");

// A fake CLI ignores its arguments entirely: it exists to produce a stream and
// an exit code. `BIG` makes the tool_use line larger than one pipe chunk, which
// is what proves the line reassembly in run() actually works.
async function writeFake(name, body) {
  const path = join(workspace, name);
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const BIG = "x".repeat(200000);',
      body,
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dante-builder-"));

  fake.success = await writeFake(
    "claude-success.cjs",
    [
      `console.log(${TOOL_USE_LINE});`,
      'fs.writeFileSync("index.html", "<!doctype html><title>ok</title>");',
      `console.log(${RESULT_LINE});`,
    ].join("\n"),
  );

  // Wrote the file, then failed anyway: proves the exit code is checked and not
  // just the artifact.
  fake.exitTwo = await writeFake(
    "claude-exit-two.cjs",
    [
      'fs.writeFileSync("index.html", "half a page");',
      'console.error("boom");',
      "process.exitCode = 2;",
    ].join("\n"),
  );

  // Exit 0, model says success, but nothing was written: the output contract is
  // the only thing that can catch this.
  fake.noArtifact = await writeFake("claude-no-artifact.cjs", `console.log(${RESULT_LINE});`);

  // Refuses to die politely, so the SIGKILL path is the one under test.
  fake.hang = await writeFake(
    "claude-hang.cjs",
    [
      `console.log(${TOOL_USE_LINE});`,
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );

  // A chain fake decides what to do from what is already in the directory,
  // which is the only way one script can stand in for several different steps —
  // and it means a step running out of order writes the wrong file and fails the
  // test rather than passing by accident.
  fake.chain = await writeFake("claude-chain.cjs", CHAIN_BODY("0"));

  // Same, but the step that builds the page falls over instead.
  fake.chainFailsSecond = await writeFake("claude-chain-fail.cjs", CHAIN_BODY("2"));

  // Writes its file and then refuses to end, but exits cleanly when asked. A
  // step like this satisfies its contract and still spends the whole budget.
  fake.slowStep = await writeFake(
    "claude-slow-step.cjs",
    [
      CHAIN_WRITE,
      'process.on("SIGTERM", () => process.exit(0));',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

const root = () => join(workspace, "builds");

test("success: exit 0 plus the artifact on disk", async () => {
  const seen = [];
  const r = await run(primitive, { subject: "coffee" }, (line) => seen.push(line), {
    bin: fake.success,
    root: root(),
  });

  assert.equal(r.ok, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.artifact, join(r.dir, "index.html"));
  assert.ok(existsSync(r.artifact));
  assert.equal(r.result.subtype, "success");
  // Progress survived a JSON line far larger than a single pipe chunk. It is an
  // envelope even here, where there are no steps to distinguish: one shape for
  // every build means no consumer ever has to branch on typeof.
  assert.deepEqual(seen, [{ kind: "line", step: "", text: "Writing index.html" }]);
});

test("a build with no steps names no step, so the readout looks exactly as it did", async () => {
  const seen = [];
  await run(primitive, { subject: "coffee" }, (line) => seen.push(line), {
    bin: fake.success,
    root: root(),
  });
  assert.equal(seen[0].step, "");
});

test("every build gets its own directory", async () => {
  const opts = { bin: fake.success, root: root() };
  const first = await run(primitive, { subject: "a" }, null, opts);
  const second = await run(primitive, { subject: "b" }, null, opts);
  assert.notEqual(first.dir, second.dir);
});

test("writes the raw stream to build.log for inspection", async () => {
  const r = await run(primitive, { subject: "coffee" }, null, { bin: fake.success, root: root() });
  assert.equal(r.log, join(r.dir, "build.log"));
  const log = await readFile(r.log, "utf8");
  assert.ok(log.includes('"tool_use"'));
  assert.ok(log.includes('"result"'));
});

test("a non-zero exit is a failed build, even with the artifact present", async () => {
  const r = await run(primitive, { subject: "coffee" }, null, { bin: fake.exitTwo, root: root() });
  assert.equal(r.ok, false);
  assert.equal(r.artifact, null);
  assert.equal(r.timedOut, false);
  assert.ok(existsSync(join(r.dir, "index.html"))); // it really did write one
  // stderr lands in the same log as stdout.
  assert.ok((await readFile(r.log, "utf8")).includes("boom"));
});

test("exit 0 with no artifact is a failed build", async () => {
  const r = await run(primitive, { subject: "coffee" }, null, {
    bin: fake.noArtifact,
    root: root(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.artifact, null);
  assert.equal(r.result.subtype, "success"); // the model's own verdict was optimistic
});

test("timeout: killed, reported as an outcome, never a rejection", async () => {
  // Long enough for the fake CLI to boot and emit its first line on a busy
  // machine, short enough to keep the test quick. At 300ms this failed roughly
  // one run in six under load: Node had not finished starting before the
  // deadline fired, so the log assertion below read an empty file.
  const impatient = { ...primitive, timeoutMs: 1500 };
  const started = Date.now();
  const r = await run(impatient, { subject: "coffee" }, null, {
    bin: fake.hang,
    root: root(),
    killGraceMs: 150,
  });

  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.equal(r.artifact, null);
  // SIGTERM was ignored, so this only returns because SIGKILL followed.
  assert.ok(Date.now() - started < 5000);
  // The log still holds whatever the build managed to emit before it was killed.
  assert.ok((await readFile(r.log, "utf8")).includes('"tool_use"'));
});

test("a progress callback that throws does not take the build down", async () => {
  let calls = 0;
  const r = await run(
    primitive,
    { subject: "coffee" },
    () => {
      calls++;
      throw new Error("the HUD exploded");
    },
    { bin: fake.success, root: root() },
  );
  assert.equal(calls, 1);
  assert.equal(r.ok, true);
});

test("no progress callback is fine", async () => {
  const r = await run(primitive, { subject: "coffee" }, undefined, {
    bin: fake.success,
    root: root(),
  });
  assert.equal(r.ok, true);
});

test("rejects only when the CLI cannot be started at all", async () => {
  await assert.rejects(
    run(primitive, { subject: "coffee" }, null, {
      bin: join(workspace, "definitely-not-here"),
      root: root(),
    }),
    (err) => err.code === "ENOENT",
  );
});

test("a CLI that cannot start leaves no empty build.log behind", async () => {
  // Its own root, so the directory this build made is the only one to inspect.
  const isolated = join(workspace, "builds-enoent");
  await assert.rejects(
    run(primitive, { subject: "coffee" }, null, {
      bin: join(workspace, "definitely-not-here"),
      root: isolated,
    }),
    (err) => err.code === "ENOENT",
  );
  const dirs = await readdir(isolated);
  assert.equal(dirs.length, 1);
  // An empty log reads as "the build ran and said nothing", which is the one
  // thing that did not happen.
  assert.equal(existsSync(join(isolated, dirs[0], "build.log")), false);
});

// --- configuredMcpServers -------------------------------------------------

test("reads the server names out of the user's CLI config", async () => {
  const path = join(workspace, "claude-config.json");
  await writeFile(path, JSON.stringify({ mcpServers: { refero: {}, other: {} } }));
  assert.deepEqual(configuredMcpServers({ configPath: path }).sort(), ["other", "refero"]);
});

test("a missing or unreadable config means no optional slots, not a crash", () => {
  assert.deepEqual(configuredMcpServers({ configPath: join(workspace, "nope.json") }), []);
});

test("a config with no MCP section means no optional slots", async () => {
  const path = join(workspace, "claude-config-empty.json");
  await writeFile(path, JSON.stringify({ theme: "dark" }));
  assert.deepEqual(configuredMcpServers({ configPath: path }), []);
});

// --- stepSpec ---------------------------------------------------------------

const chainPrimitive = {
  ...primitive,
  id: "chain-thing",
  mcp: ["refero"],
  timeoutMs: 20000,
  steps: [
    {
      id: "plan",
      systemPrompt: () => "Write plan.md.",
      allowedTools: ["Write"],
      outputContract: "plan.md",
    },
    {
      id: "build",
      systemPrompt: (p) => `Read ${p.previous.artifact} and build the page.`,
      allowedTools: ["Write", "Edit", "Read"],
      outputContract: "index.html",
    },
  ],
};

test("a step is told the overall goal before its own instructions", () => {
  const spec = stepSpec(chainPrimitive, chainPrimitive.steps[0]);
  const prompt = spec.systemPrompt({ subject: "coffee" });
  assert.ok(prompt.startsWith("make coffee"), prompt);
  assert.ok(prompt.includes("Write plan.md."));
});

test("a step runs with its own tools and never the primitive's", () => {
  const spec = stepSpec(chainPrimitive, chainPrimitive.steps[0]);
  assert.deepEqual(spec.allowedTools, ["Write"]);
  // The primitive grants Edit and Read; the planning step must not get them.
  assert.ok(!spec.allowedTools.includes("Edit"));
});

test("a step inherits the primitive's MCP slots only when it names none of its own", () => {
  assert.deepEqual(stepSpec(chainPrimitive, chainPrimitive.steps[0]).mcp, ["refero"]);
  const withOwn = { ...chainPrimitive.steps[0], mcp: ["other"] };
  assert.deepEqual(stepSpec(chainPrimitive, withOwn).mcp, ["other"]);
});

// --- runSteps ---------------------------------------------------------------

const callsIn = async (dir) => (await readFile(join(dir, "calls.log"), "utf8")).trim().split("\n");

test("a chain runs the CLI once per step, in order", async () => {
  const r = await run(chainPrimitive, { subject: "coffee" }, null, {
    bin: fake.chain,
    root: root(),
  });

  assert.equal(r.ok, true);
  const calls = await callsIn(r.dir);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("Write plan.md."), calls[0]);
  assert.ok(calls[1].includes("build the page"), calls[1]);
});

test("a step is handed what the step before it produced", async () => {
  const r = await run(chainPrimitive, { subject: "coffee" }, null, {
    bin: fake.chain,
    root: root(),
  });
  const calls = await callsIn(r.dir);
  assert.ok(calls[1].includes(join(r.dir, "plan.md")), calls[1]);
});

test("the first step is told there is nothing before it, rather than handed a null", async () => {
  // A null here would throw inside buildSpawnArgs and reject the whole build,
  // turning a primitive-authoring typo into an unexplained TypeError.
  const seen = [];
  const nosy = {
    ...chainPrimitive,
    steps: [
      {
        ...chainPrimitive.steps[0],
        systemPrompt: (p) => {
          seen.push(p.previous);
          return "Write plan.md.";
        },
      },
      chainPrimitive.steps[1],
    ],
  };
  const r = await run(nosy, { subject: "coffee" }, null, { bin: fake.chain, root: root() });
  assert.equal(seen[0].id, null);
  assert.equal(seen[0].artifact, null);
  assert.equal(seen[0].dir, r.dir);
});

test("a chain keeps one directory and one log for the whole run", async () => {
  const r = await run(chainPrimitive, { subject: "coffee" }, null, {
    bin: fake.chain,
    root: root(),
  });
  assert.equal(r.log, join(r.dir, "build.log"));
  assert.ok(existsSync(join(r.dir, "plan.md")));
  assert.ok(existsSync(join(r.dir, "index.html")));
});

test("the shared log names each step before it starts, so 900 seconds of it can be read", async () => {
  const r = await run(chainPrimitive, { subject: "coffee" }, null, {
    bin: fake.chain,
    root: root(),
  });
  const log = await readFile(r.log, "utf8");
  assert.ok(log.includes("=== step: plan ==="));
  assert.ok(log.includes("=== step: build ==="));
  assert.ok(log.indexOf("=== step: plan ===") < log.indexOf("=== step: build ==="));
});

test("a chain reports the primitive's own artifact, not the last step's working file", async () => {
  const r = await run(chainPrimitive, { subject: "coffee" }, null, {
    bin: fake.chain,
    root: root(),
  });
  assert.equal(r.artifact, join(r.dir, "index.html"));
  assert.equal(r.failedStep, null);
});

test("progress from a chain names the step it came from", async () => {
  const seen = [];
  await run(chainPrimitive, { subject: "coffee" }, (line) => seen.push(line), {
    bin: fake.chain,
    root: root(),
  });
  const lines = seen.filter((e) => e.kind === "line");
  assert.deepEqual([...new Set(lines.map((e) => e.step))], ["plan", "build"]);
});

test("each step announces itself and its place in the chain", async () => {
  const seen = [];
  await run(chainPrimitive, { subject: "coffee" }, (line) => seen.push(line), {
    bin: fake.chain,
    root: root(),
  });
  assert.deepEqual(
    seen.filter((e) => e.kind === "step"),
    [
      { kind: "step", step: "plan", state: "start", index: 0, of: 2 },
      { kind: "step", step: "build", state: "start", index: 1, of: 2 },
    ],
  );
});

test("a failing step names itself and the steps after it never run", async () => {
  const r = await run(chainPrimitive, { subject: "coffee" }, null, {
    bin: fake.chainFailsSecond,
    root: root(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, "build");
  assert.equal(r.artifact, null);
  assert.equal((await callsIn(r.dir)).length, 2);
});

test("a chain that fails at its first step never starts the second", async () => {
  const doomed = {
    ...chainPrimitive,
    steps: [
      { ...chainPrimitive.steps[0], outputContract: "never-written.md" },
      chainPrimitive.steps[1],
    ],
  };
  const r = await run(doomed, { subject: "coffee" }, null, { bin: fake.chain, root: root() });
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, "plan");
  assert.equal((await callsIn(r.dir)).length, 1);
});

test("the wall clock is what the budget is spent from, however generous the shares", async () => {
  const greedy = {
    ...chainPrimitive,
    timeoutMs: 1500,
    steps: chainPrimitive.steps.map((step) => ({ ...step, timeoutShareMs: 60000 })),
  };
  const started = Date.now();
  const r = await run(greedy, { subject: "coffee" }, null, {
    bin: fake.hang,
    root: root(),
    killGraceMs: 150,
  });

  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.failedStep, "plan");
  // A share bigger than the ceiling must be clamped to it, not honoured.
  assert.ok(Date.now() - started < 5000, "the chain outlived its own timeout");
});

test("a step with no time left is not started, because it could only overrun further", async () => {
  const tight = { ...chainPrimitive, timeoutMs: 1200 };
  const r = await run(tight, { subject: "coffee" }, null, {
    bin: fake.slowStep,
    root: root(),
    killGraceMs: 150,
  });

  // The first step wrote its file before it was stopped, so it satisfied its own
  // contract — and still left nothing for the one after it.
  assert.ok(existsSync(join(r.dir, "plan.md")));
  assert.equal((await callsIn(r.dir)).length, 1);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.failedStep, "build");
});

test("a single-shot build reports no failed step at all, as it always has", async () => {
  const r = await run(primitive, { subject: "coffee" }, null, { bin: fake.success, root: root() });
  assert.equal("failedStep" in r, false);
});

test("the real marketing-site primitive runs end to end as three sessions", async () => {
  const seen = [];
  const r = await run(marketingSite, { subject: "a coffee roaster", vibe: "warm" }, (line) => seen.push(line), {
    bin: fake.chain,
    root: root(),
  });

  assert.equal(r.ok, true);
  assert.equal(r.failedStep, null);
  assert.equal(r.artifact, join(r.dir, "index.html"));
  assert.deepEqual(
    seen.filter((e) => e.kind === "step").map((e) => e.step),
    ["plan", "build-pages", "verify"],
  );
  // The build step is told where the plan is, by absolute path, because it runs
  // in a cold session that never saw the step that wrote it.
  const calls = await callsIn(r.dir);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].includes(join(r.dir, "plan.md")), calls[1]);
});
