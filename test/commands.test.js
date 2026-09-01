import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_ARGS_CHARS,
  NATIVE_COMMANDS,
  commandsBlock,
  loadCommands,
  parseCommand,
  refuseCommand,
} from "../lib/commands.js";
import { withTempDir } from "./helpers.js";

const KNOWN = new Map([["grilling", {}], ["cleanup-session-codebase", {}], ["caveman:caveman-commit", {}]]);

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

test("a known skill parses to its name, its arguments, and the one line that will run", () => {
  assert.deepEqual(parseCommand("/grilling the rollout plan", KNOWN), {
    name: "grilling", args: "the rollout plan", line: "/grilling the rollout plan",
  });
  assert.deepEqual(parseCommand("/cleanup-session-codebase", KNOWN), {
    name: "cleanup-session-codebase", args: "", line: "/cleanup-session-codebase",
  });
  assert.deepEqual(parseCommand("/caveman:caveman-commit", KNOWN), {
    name: "caveman:caveman-commit", args: "", line: "/caveman:caveman-commit",
  });
});

test("the name is read case-insensitively and the arguments are collapsed to one line", () => {
  assert.deepEqual(parseCommand("/Grilling  the\nauth   module ", KNOWN), {
    name: "grilling", args: "the auth module", line: "/grilling the auth module",
  });
});

test("a skill that is not known is refused, not guessed at", () => {
  assert.equal(parseCommand("/cleanup", KNOWN), null);
  assert.equal(parseCommand("/grilling", null), null);
  assert.equal(parseCommand("/grilling", new Map()), null);
});

test("one of Claude's own commands is refused even when a skill of that name is on the allow-list", () => {
  for (const name of NATIVE_COMMANDS) {
    assert.equal(parseCommand(`/${name}`, new Map([[name, {}]])), null, name);
  }
  assert.ok(NATIVE_COMMANDS.has("compact") && NATIVE_COMMANDS.has("clear") && NATIVE_COMMANDS.has("permissions"));
});

test("anything that is not a slash command is refused: no slash, a bad name, nothing at all", () => {
  for (const text of ["grilling", "run /grilling", "/", "/gril ling", "/gril!ing", "", null, undefined, 42]) {
    assert.equal(parseCommand(text, KNOWN), null, String(text));
  }
});

test("the allow-list may be a Map, a Set, an array of names, or an array of records", () => {
  assert.ok(parseCommand("/grilling", new Set(["grilling"])));
  assert.ok(parseCommand("/grilling", ["grilling"]));
  assert.ok(parseCommand("/grilling", [{ name: "grilling" }]));
});

test("arguments are capped and stripped of unprintables, because a model wrote them from speech", () => {
  const rlo = String.fromCharCode(0x202e);
  const parsed = parseCommand(`/grilling ${rlo}${"x".repeat(MAX_ARGS_CHARS * 2)}`, KNOWN);
  assert.equal(parsed.args.includes(rlo), false);
  assert.equal(parsed.args.length, MAX_ARGS_CHARS);
  assert.equal(parsed.line, `/grilling ${parsed.args}`);
});

// ---------------------------------------------------------------------------
// refuseCommand
// ---------------------------------------------------------------------------

test("the refusal says which kind it is: unknown invites a correction, native does not", () => {
  assert.equal(refuseCommand("/cleanup", KNOWN), "I do not know a /cleanup skill, sir.");
  assert.equal(refuseCommand("/compact", KNOWN), "I will not send /compact by voice, sir. That is a Claude command, not a skill.");
  assert.equal(refuseCommand("/PERMISSIONS now", KNOWN), "I will not send /permissions by voice, sir. That is a Claude command, not a skill.");
  assert.equal(refuseCommand("grilling", KNOWN), "I did not catch which skill that was, sir.");
  assert.equal(refuseCommand("", KNOWN), "I did not catch which skill that was, sir.");
});

test("a skill that is fine is not refused", () => {
  assert.equal(refuseCommand("/grilling the plan", KNOWN), null);
});

// ---------------------------------------------------------------------------
// commandsBlock
// ---------------------------------------------------------------------------

test("the persona block lists every known skill, sorted, and teaches the command= key", () => {
  const block = commandsBlock(KNOWN);
  assert.match(block, /^SKILLS: /);
  assert.match(block, /\/caveman:caveman-commit, \/cleanup-session-codebase, \/grilling\./);
  assert.match(block, /command="\/<name> <arguments>"/);
  assert.match(block, /never one of Claude's own commands/);
  assert.match(block, /never send a skill to a session unless he asked you to, in this turn/);
});

test("with nothing known there is no block at all, because a list of nothing is worse than no list", () => {
  assert.equal(commandsBlock(null), "");
  assert.equal(commandsBlock(new Map()), "");
  // A native name that somehow got in is not advertised either.
  assert.equal(commandsBlock(["compact"]), "");
});

// ---------------------------------------------------------------------------
// loadCommands
// ---------------------------------------------------------------------------

function fakeInstall(dir, { skills = [], commands = [] } = {}) {
  mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
  for (const name of commands) writeFileSync(join(dir, ".claude", "commands", `${name}.md`), `# ${name}\n`);
  for (const name of skills) {
    mkdirSync(join(dir, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
}

test("discovery finds skills under the home directory and under each repository, and nothing else", () => {
  withTempDir("dante-commands-", (root) => {
    const home = join(root, "home");
    const repo = join(root, "repo");
    fakeInstall(home, { skills: ["grilling"], commands: ["deploy"] });
    fakeInstall(repo, { skills: ["blast-radius"] });

    const known = loadCommands({ home, repos: [repo] });
    assert.equal(known.get("grilling").source, home);
    assert.equal(known.get("blast-radius").source, repo);
    // The older single-file command form is not a skill and is not sent.
    assert.equal(known.has("deploy"), false);
    assert.deepEqual([...known.keys()].sort(), ["blast-radius", "grilling"]);
  });
});

test("a repository's own skill wins the source for a name it shares with a global one", () => {
  withTempDir("dante-commands-", (root) => {
    const home = join(root, "home");
    const repo = join(root, "repo");
    fakeInstall(home, { skills: ["grilling"] });
    fakeInstall(repo, { skills: ["grilling"] });
    assert.equal(loadCommands({ home, repos: [repo] }).get("grilling").source, repo);
  });
});

test("discovery skips a skill directory with no SKILL.md, a skill named like a native command, and a directory that does not exist", () => {
  withTempDir("dante-commands-", (root) => {
    const home = join(root, "home");
    fakeInstall(home, { skills: ["compact", "review"] });
    mkdirSync(join(home, ".claude", "skills", "half-made"));

    const known = loadCommands({ home, repos: [join(root, "missing")] });
    assert.equal(known.has("compact"), false);
    assert.equal(known.has("review"), false);
    assert.equal(known.has("half-made"), false);
    assert.equal(known.size, 0);
  });
});

test("with no home at all and no repositories, nothing is known and nothing is sendable", () => {
  const known = loadCommands({ home: "", repos: null });
  assert.equal(known.size, 0);
  assert.equal(parseCommand("/grilling", known), null);
});
