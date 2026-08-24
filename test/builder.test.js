import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpawnArgs, configuredMcpServers, run } from "../lib/builder.js";

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
  workspace = await mkdtemp(join(tmpdir(), "jarvis-builder-"));

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
