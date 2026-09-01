import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BUILTIN_COMMANDS,
  FORBIDDEN_COMMANDS,
  MAX_ARGS_CHARS,
  commandsBlock,
  describeCommand,
  loadCommands,
  parseCommand,
  refuseCommand,
} from "../lib/commands.js";
import { withTempDir } from "./helpers.js";

const KNOWN = new Map([["review", {}], ["compact", {}], ["cleanup-session-codebase", {}], ["caveman:caveman-commit", {}]]);

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

test("a known command parses to its name, its arguments, and the one line that will run", () => {
  assert.deepEqual(parseCommand("/review high", KNOWN), { name: "review", args: "high", line: "/review high" });
  assert.deepEqual(parseCommand("/compact", KNOWN), { name: "compact", args: "", line: "/compact" });
  assert.deepEqual(parseCommand("/caveman:caveman-commit", KNOWN), {
    name: "caveman:caveman-commit", args: "", line: "/caveman:caveman-commit",
  });
});

test("the name is read case-insensitively and the arguments are collapsed to one line", () => {
  assert.deepEqual(parseCommand("/Review  the\nauth   module ", KNOWN), {
    name: "review", args: "the auth module", line: "/review the auth module",
  });
});

test("a command that is not known is refused, not guessed at", () => {
  assert.equal(parseCommand("/remove", KNOWN), null);
  assert.equal(parseCommand("/review", null), null);
  assert.equal(parseCommand("/review", new Map()), null);
});

test("a forbidden command is refused even when discovery would have listed it", () => {
  for (const name of FORBIDDEN_COMMANDS) {
    assert.equal(parseCommand(`/${name}`, new Map([[name, {}]])), null, name);
  }
});

test("anything that is not a slash command is refused: no slash, a bad name, nothing at all", () => {
  for (const text of ["review", "run /review", "/", "/re view", "/rev!ew", "", null, undefined, 42]) {
    assert.equal(parseCommand(text, KNOWN), null, String(text));
  }
});

test("the allow-list may be a Map, a Set, an array of names, or an array of records", () => {
  assert.ok(parseCommand("/review", new Set(["review"])));
  assert.ok(parseCommand("/review", ["review"]));
  assert.ok(parseCommand("/review", [{ name: "review" }]));
});

test("arguments are capped and stripped of unprintables, because a model wrote them from speech", () => {
  const rlo = String.fromCharCode(0x202e);
  const parsed = parseCommand(`/review ${rlo}${"x".repeat(MAX_ARGS_CHARS * 2)}`, KNOWN);
  assert.equal(parsed.args.includes(rlo), false);
  assert.equal(parsed.args.length, MAX_ARGS_CHARS);
  assert.equal(parsed.line, `/review ${parsed.args}`);
});

// ---------------------------------------------------------------------------
// refuseCommand / describeCommand
// ---------------------------------------------------------------------------

test("the refusal says which kind it is: unknown invites a correction, forbidden does not", () => {
  assert.equal(refuseCommand("/remove", KNOWN), "I do not know a /remove command, sir.");
  assert.equal(refuseCommand("/permissions", KNOWN), "I will not send /permissions by voice, sir.");
  assert.equal(refuseCommand("/PERMISSIONS high", KNOWN), "I will not send /permissions by voice, sir.");
  assert.equal(refuseCommand("review", KNOWN), "I did not catch which command that was, sir.");
  assert.equal(refuseCommand("", KNOWN), "I did not catch which command that was, sir.");
});

test("a command that is fine is not refused", () => {
  assert.equal(refuseCommand("/review high", KNOWN), null);
});

test("the spoken clause is the exact line that will run", () => {
  assert.equal(describeCommand(parseCommand("/review high", KNOWN)), "running /review high");
  assert.equal(describeCommand(null), "");
});

// ---------------------------------------------------------------------------
// commandsBlock
// ---------------------------------------------------------------------------

test("the persona block lists every known command, sorted, and teaches the command= key", () => {
  const block = commandsBlock(KNOWN);
  assert.match(block, /^COMMANDS: /);
  assert.match(block, /\/caveman:caveman-commit, \/cleanup-session-codebase, \/compact, \/review\./);
  assert.match(block, /command="\/<name> <arguments>"/);
  assert.match(block, /never send a command to a session unless he asked you to, in this turn/);
});

test("with nothing known there is no block at all, because a list of nothing is worse than no list", () => {
  assert.equal(commandsBlock(null), "");
  assert.equal(commandsBlock(new Map()), "");
  // A forbidden name that somehow got in is not advertised either.
  assert.equal(commandsBlock(["permissions"]), "");
});

// ---------------------------------------------------------------------------
// loadCommands
// ---------------------------------------------------------------------------

function fakeInstall(dir, { commands = [], skills = [] } = {}) {
  mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
  for (const name of commands) writeFileSync(join(dir, ".claude", "commands", `${name}.md`), `# ${name}\n`);
  for (const name of skills) {
    mkdirSync(join(dir, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
}

test("discovery finds custom commands and skills under the home directory and under each repository, plus the built-ins", () => {
  withTempDir("dante-commands-", (root) => {
    const home = join(root, "home");
    const repo = join(root, "repo");
    fakeInstall(home, { commands: ["deploy"], skills: ["grilling"] });
    fakeInstall(repo, { skills: ["blast-radius"] });

    const known = loadCommands({ home, repos: [repo] });
    for (const name of BUILTIN_COMMANDS) assert.equal(known.get(name)?.source, "builtin", name);
    assert.equal(known.get("deploy").source, home);
    assert.equal(known.get("grilling").source, home);
    assert.equal(known.get("blast-radius").source, repo);
  });
});

test("a repository's own skill wins the source for a name it shares with a global one", () => {
  withTempDir("dante-commands-", (root) => {
    const home = join(root, "home");
    const repo = join(root, "repo");
    fakeInstall(home, { skills: ["review"] });
    fakeInstall(repo, { skills: ["review"] });
    assert.equal(loadCommands({ home, repos: [repo] }).get("review").source, repo);
  });
});

test("discovery skips a skill directory with no SKILL.md, a non-markdown file, a forbidden name, and a directory that does not exist", () => {
  withTempDir("dante-commands-", (root) => {
    const home = join(root, "home");
    fakeInstall(home, { commands: ["permissions"], skills: ["mcp"] });
    mkdirSync(join(home, ".claude", "skills", "half-made"));
    writeFileSync(join(home, ".claude", "commands", "notes.txt"), "not a command");

    const known = loadCommands({ home, repos: [join(root, "missing")] });
    assert.equal(known.has("permissions"), false);
    assert.equal(known.has("mcp"), false);
    assert.equal(known.has("half-made"), false);
    assert.equal(known.has("notes"), false);
    assert.deepEqual([...known.keys()].sort(), [...BUILTIN_COMMANDS].sort());
  });
});

test("with no home at all and no repositories, the built-ins are still known", () => {
  const known = loadCommands({ home: "", repos: null });
  assert.deepEqual([...known.keys()].sort(), [...BUILTIN_COMMANDS].sort());
});
