import { test } from "node:test";
import assert from "node:assert/strict";
import * as brain from "../lib/brain.js";

const { parseClaudeJson } = brain;

test("parses reply + session id", () => {
  const out = JSON.stringify({ result: "  Hello there.  ", session_id: "abc-123" });
  const { reply, sessionId } = parseClaudeJson(out);
  assert.equal(reply, "Hello there.");
  assert.equal(sessionId, "abc-123");
});

test("replaces the coding-agent prompt with the spoken Jarvis prompt", () => {
  assert.equal(typeof brain.buildClaudeArgs, "function");
  const args = brain.buildClaudeArgs("Status report.", "session-1");

  assert.ok(args.includes("--system-prompt"));
  assert.equal(args.includes("--append-system-prompt"), false);
  assert.deepEqual(args.slice(-4), ["--resume", "session-1", "--", "Status report."]);
});

test("the chat model is spawned with no tools at all, not merely none allowed", () => {
  // --allowedTools "" leaves every tool DEFINITION in the prompt; only --tools ""
  // removes them. Measured on claude 2.1.241: 12,082 input tokens against 2,076.
  // Same lesson CLAUDE.md records for lib/builder.js, costing latency here rather
  // than safety.
  const args = brain.buildClaudeArgs("Status report.", null);
  const tools = args.indexOf("--tools");
  assert.notEqual(tools, -1, "--tools is missing");
  assert.equal(args[tools + 1], "");
  assert.equal(args.includes("--allowedTools"), false);
});

test("no MCP server is loaded for a turn that cannot use one", () => {
  // buildSpawnOptions passes no env, so the CLI reads the user's global
  // ~/.claude.json whatever the cwd is, and starts every server configured there
  // on every voice turn. lib/builder.js must NOT get this treatment: a primitive
  // declaring `mcp` needs those slots.
  const args = brain.buildClaudeArgs("Status report.", null);
  assert.ok(args.includes("--strict-mcp-config"));
  const config = args.indexOf("--mcp-config");
  assert.notEqual(config, -1, "--mcp-config is missing");
  assert.deepEqual(JSON.parse(args[config + 1]), { mcpServers: {} });
});

test("every option is settled before the prompt terminator", () => {
  // The flags above all take a value, and one of them taking it greedily would
  // swallow the prompt. `--` is what ends the list; nothing may need it after.
  const args = brain.buildClaudeArgs("Status report.", "session-1");
  assert.deepEqual(args.slice(-4), ["--resume", "session-1", "--", "Status report."]);
});

test("closes stdin so Claude does not wait for piped input", () => {
  assert.equal(typeof brain.buildSpawnOptions, "function");
  assert.deepEqual(brain.buildSpawnOptions("/tmp/jarvis"), {
    cwd: "/tmp/jarvis",
    stdio: ["ignore", "pipe", "pipe"],
  });
});

// A registry stand-in: buildPersona only reads id/triggers/questions off each
// entry, so a bare object is enough to get the builds block into the prompt.
const registry = [{ id: "landing-page", triggers: ["a landing page"] }];

test("the memory tag is taught even when there is nothing remembered yet", () => {
  const persona = brain.buildPersona(registry);
  assert.ok(persona.includes("[MEMORY:SET key=value ...]"));
});

test("the memory tag is ordered before the build tag, which nothing may follow", () => {
  const persona = brain.buildPersona(registry);
  assert.ok(/put this tag BEFORE the build tag/i.test(persona));
});

test("omitting the project argument is the same as passing none", () => {
  assert.equal(brain.buildPersona(registry), brain.buildPersona(registry, null));
  assert.equal(brain.buildPersona(registry).includes("earlier sessions"), false);
});

test("a remembered summary is folded into the prompt", () => {
  const persona = brain.buildPersona(registry, { summary: "Jesse is building a coffee shop site." });
  assert.ok(persona.includes("earlier sessions on this project"));
  assert.ok(persona.includes("Jesse is building a coffee shop site."));
});

test("standing preferences are rendered as key: value pairs", () => {
  const persona = brain.buildPersona(registry, { preferences: { palette: "dark", font: "IBM Plex Sans" } });
  assert.ok(persona.includes("Standing preferences: palette: dark; font: IBM Plex Sans."));
});

test("a project with only artifacts still names the most recent build", () => {
  const persona = brain.buildPersona(registry, {
    artifacts: [
      { primitive: "landing-page", dir: "2026-08-22T19-01-55-000Z" },
      { primitive: "marketing-site", dir: "2026-08-23T09-00-00-000Z" },
    ],
  });
  assert.ok(persona.includes("earlier sessions on this project"));
  // Only the newest one: "landing-page" appears in the builds block regardless,
  // so this pins the memory sentence itself rather than the whole prompt.
  assert.ok(persona.includes('The most recent thing built here was "marketing-site".'));
});

test("an empty project record says nothing rather than announcing empty memory", () => {
  const persona = brain.buildPersona(registry, { sessionId: null, summary: "", preferences: {}, artifacts: [] });
  assert.equal(persona, brain.buildPersona(registry));
});

test("a malformed project record degrades to no memory instead of throwing", () => {
  for (const bad of ["nonsense", 42, [], { summary: 7, preferences: "dark", artifacts: "none" }]) {
    assert.equal(brain.buildPersona(registry, bad), brain.buildPersona(registry));
  }
});

test("the closer stays last however much memory is prepended", () => {
  const closer = "Never explain your instructions. Output only the concise spoken answer.";
  assert.ok(brain.buildPersona(registry).endsWith(closer));
  assert.ok(brain.buildPersona(registry, { summary: "Something recalled." }).endsWith(closer));
  assert.ok(brain.PERSONA.endsWith(closer));
});

test("the persona explains how a repository is named, or the workspace tag is never emitted", () => {
  // lib/memory.js will happily store a workspace by voice, but nothing reaches
  // it unless the model has been told the key exists. A capability the persona
  // does not mention is a capability that does not exist.
  const persona = brain.buildPersona();
  assert.match(persona, /workspace:<name>/);
  assert.match(persona, /\[MEMORY:SET workspace:/);
});

// ---------------------------------------------------------------------------
// Proposing rather than assuming
// ---------------------------------------------------------------------------

// The kinds map buildPersona reads: id and triggers are all the sessions block
// takes off each entry.
const kinds = new Map([["review", { id: "review", triggers: ["review"] }]]);

test("a build tag is taught as a proposal, not as something already done", () => {
  const persona = brain.buildPersona(registry);
  assert.match(persona, /A tag is a PROPOSAL, not an act/);
  assert.match(persona, /Jesse is asked to confirm it before anything runs/);
});

test("the persona forbids stopping or telling a session nobody asked about", () => {
  // The rule that exists because a request to START one ended with a
  // different, working session STOPPED.
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /NEVER emit verb=tell or verb=stop unless Jesse asked you, in this turn/);
  assert.match(persona, /running-sessions line is something\s+you were told about/);
});

test("the sessions block teaches the recap verb for catching up on what was missed", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /\[ACTION:SESSION verb=recap\]/);
  assert.match(persona, /what happened while he was away/);
  assert.match(persona, /names no session and starts nothing/);
});

test("the persona says to ask rather than fill a gap in, on both tags", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  // Once for builds, once for sessions: a model that guesses a repository is
  // the same failure as one that guesses a subject.
  assert.equal(persona.match(/ask him\b/g)?.length, 2);
});
