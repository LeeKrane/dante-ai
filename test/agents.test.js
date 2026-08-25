import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LIST_TIMEOUT_MS,
  MAX_SPOKEN,
  describeRoster,
  listAgents,
  parseRoster,
} from "../lib/agents.js";

// A real listing, copied verbatim off this machine. Six sessions, and the point
// of keeping it whole is everything it omits: the interactive ones carry no
// `id`, one carries no `state`, one carries neither `state` nor `status`, and
// one reports a `state` of "blocked" that the working/done pair does not cover.
const LIVE_LISTING = JSON.stringify([
  {
    pid: 3347048,
    id: "eb00f586",
    cwd: "/home/krane/development/jarvis",
    kind: "background",
    startedAt: 1787623026543,
    sessionId: "eb00f586-15be-4807-a3a9-9f52d752eb65",
    name: "Empty Session",
    status: "idle",
    state: "blocked",
  },
  {
    pid: 1306254,
    cwd: "/home/krane/development/jarvis",
    kind: "interactive",
    startedAt: 1787659068241,
    sessionId: "67717804-b673-4c59-a431-d15f421c6156",
    name: "jarvis-60",
    status: "idle",
  },
  {
    pid: 1308510,
    id: "3b139d5b",
    cwd: "/home/krane/development/jarvis",
    kind: "background",
    startedAt: 1787659118525,
    sessionId: "3b139d5b-d998-4168-9a8c-6afae89909b8",
    name: "roadmap-expansion",
    status: "busy",
    state: "working",
  },
  {
    pid: 1883810,
    cwd: "/home/krane/development/jarvis",
    kind: "interactive",
    startedAt: 1787663301756,
    sessionId: "372d26be-e880-4fd8-90b3-24a0885c4e6d",
    name: "jarvis-55",
    status: "idle",
  },
  {
    pid: 1898121,
    cwd: "/home/krane/development/jarvis/lib",
    kind: "interactive",
    startedAt: 1787663414887,
    sessionId: "3df1ac25-4f88-4b29-89e3-bf32add9b730",
    name: "lib-a5",
  },
  {
    pid: 1929227,
    cwd: "/home/krane/.claude-mem/observer-sessions",
    kind: "interactive",
    startedAt: 1787663661389,
    sessionId: "e13d3d40-8c07-4155-92ca-e670df3bb630",
    name: "observer-sessions-83",
  },
]);

// One session, built from a template so a negative case is one changed field
// rather than a whole new fixture.
function session(overrides = {}) {
  return {
    pid: 4242,
    id: "abcd1234",
    cwd: "/home/krane/development/jarvis",
    kind: "background",
    startedAt: 1_000_000,
    sessionId: "abcd1234-0000-0000-0000-000000000000",
    name: "jarvis-1-builder-test-fix",
    status: "busy",
    state: "working",
    ...overrides,
  };
}

function rosterOf(...entries) {
  return parseRoster(JSON.stringify(entries));
}

// ---------------------------------------------------------------------------
// parseRoster
// ---------------------------------------------------------------------------

test("a live listing becomes one normalised record per session", () => {
  const roster = parseRoster(LIVE_LISTING);
  assert.equal(roster.length, 6);
  assert.deepEqual(roster[2], {
    sessionId: "3b139d5b-d998-4168-9a8c-6afae89909b8",
    id: "3b139d5b",
    name: "roadmap-expansion",
    cwd: "/home/krane/development/jarvis",
    kind: "background",
    status: "busy",
    state: "working",
    pid: 1308510,
    startedAt: 1787659118525,
  });
});

test("the fields an interactive session leaves out come back as null rather than dropping the session", () => {
  // The session with neither an id nor a state nor a status is still a real
  // process someone may want to stop, so it has to survive the parse.
  const roster = parseRoster(LIVE_LISTING);
  const bare = roster.find((r) => r.name === "lib-a5");
  assert.ok(bare, "the session with the sparsest record should still be listed");
  assert.equal(bare.id, null);
  assert.equal(bare.state, null);
  assert.equal(bare.status, null);
  assert.equal(bare.pid, 1898121);
});

test("a state outside the working/done pair is carried through untouched", () => {
  // "blocked" came off a live listing. Treating the vocabulary as closed here
  // would mean a session waiting on a permission prompt reported as idle.
  const [record] = rosterOf(session({ state: "blocked" }));
  assert.equal(record.state, "blocked");
});

test("a record with no session id is not a session anything can act on", () => {
  const roster = rosterOf(session(), { pid: 99, name: "no id here" }, session({ sessionId: "  " }));
  assert.equal(roster.length, 1);
  assert.equal(roster[0].name, "jarvis-1-builder-test-fix");
});

test("the same session id twice is kept once", () => {
  // One process per session id is what Stage 27's busy check depends on; a
  // duplicate would defeat it before it ran.
  const roster = rosterOf(session(), session({ name: "an impostor" }));
  assert.equal(roster.length, 1);
  assert.equal(roster[0].name, "jarvis-1-builder-test-fix");
});

test("malformed output costs the roster, never the turn", () => {
  for (const bad of ["", "   ", "not json at all", "{}", '"a string"', "null", "42", "[", undefined, null, 42, {}]) {
    assert.deepEqual(parseRoster(bad), [], JSON.stringify(bad));
  }
});

test("entries that are not objects are skipped rather than parsed", () => {
  assert.deepEqual(parseRoster(JSON.stringify([1, "two", null, ["three"]])), []);
});

test("control characters and bidi overrides never survive into a session name", () => {
  // A session name is chosen by whoever started the session, is spoken aloud,
  // and in Phase C is posted to Slack. It is not trusted text.
  const [record] = rosterOf(
    session({ name: "safe\u0000\u001bname\u202e reversed", cwd: "/home/krane/dev\u0007/x" }),
  );
  assert.equal(record.name, "safename reversed");
  assert.equal(record.cwd, "/home/krane/dev/x");
});

test("a very long session name is clipped rather than recited whole", () => {
  const [record] = rosterOf(session({ name: "x".repeat(500) }));
  assert.ok(record.name.length <= 60, `name was ${record.name.length} chars`);
});

test("a pid that could signal a whole process group is refused", () => {
  // kill(2) reads 0 as "my own process group" and a negative pid as "that whole
  // group". Stage 28 signs a SIGTERM with this number.
  for (const bad of [0, -1, -4242, 1.5, "4242", null, undefined, NaN, Infinity]) {
    const [record] = rosterOf(session({ pid: bad }));
    assert.equal(record.pid, null, String(bad));
  }
  const [good] = rosterOf(session({ pid: 4242 }));
  assert.equal(good.pid, 4242);
});

test("startedAt is read as epoch milliseconds, which is what the CLI actually sends", () => {
  const [record] = rosterOf(session({ startedAt: 1787659118525 }));
  assert.equal(record.startedAt, 1787659118525);
});

test("a date string is tolerated in case the CLI ever switches to one", () => {
  const [record] = rosterOf(session({ startedAt: "2026-08-25T10:00:00.000Z" }));
  assert.equal(record.startedAt, Date.parse("2026-08-25T10:00:00.000Z"));

  const [unknown] = rosterOf(session({ startedAt: "some day soon" }));
  assert.equal(unknown.startedAt, null);
});

// ---------------------------------------------------------------------------
// describeRoster
// ---------------------------------------------------------------------------

// A plausible epoch rather than a small round number: startedAt is epoch
// milliseconds, and "now minus five hours" has to still land in this century
// or the parser rightly refuses it.
const NOW = 1_800_000_000_000;

test("an empty roster says so out loud rather than saying nothing", () => {
  assert.equal(describeRoster([], {}, NOW), "Nothing is running.");
  assert.equal(describeRoster(null, {}, NOW), "Nothing is running.");
  assert.equal(describeRoster("not a roster", {}, NOW), "Nothing is running.");
});

test("a working session is reported with how long it has been at it", () => {
  const roster = rosterOf(session({ startedAt: NOW - 4 * 60_000 }));
  assert.equal(describeRoster(roster, {}, NOW), "one session: jarvis-1-builder-test-fix working, 4 minutes in");
});

test("an idle session is not told how long it has been idle", () => {
  // Three hours of idleness is not an answer to "what's running" — it is noise
  // in a channel that costs a second per word.
  const roster = rosterOf(session({ status: "idle", state: null, startedAt: NOW - 3 * 3_600_000 }));
  assert.equal(describeRoster(roster, {}, NOW), "one session: jarvis-1-builder-test-fix idle");
});

test("elapsed time is rounded to something a person would say", () => {
  const at = (ms) => describeRoster(rosterOf(session({ startedAt: NOW - ms })), {}, NOW);
  assert.match(at(20_000), /just started/);
  assert.match(at(90_000), /a minute in/);
  assert.match(at(25 * 60_000), /25 minutes in/);
  assert.match(at(62 * 60_000), /an hour in/);
  assert.match(at(5 * 3_600_000), /5 hours in/);
});

test("a clock that ran backwards says nothing about elapsed time rather than counting down", () => {
  const roster = rosterOf(session({ startedAt: NOW + 60_000 }));
  assert.equal(describeRoster(roster, {}, NOW), "one session: jarvis-1-builder-test-fix working");
});

test("a session named after its own repo is not named twice", () => {
  const roster = rosterOf(session({ name: "jarvis-1-fix", startedAt: NOW }));
  assert.equal(describeRoster(roster, {}, NOW), "one session: jarvis-1-fix working, just started");
});

test("a session started by hand is prefixed with the repo it lives in", () => {
  const roster = rosterOf(session({ name: "Empty Session", status: "idle", state: null }));
  assert.equal(describeRoster(roster, {}, NOW), "one session: jarvis: Empty Session idle");
});

test("an alias someone chose beats the directory basename", () => {
  const roster = rosterOf(
    session({ cwd: "/home/krane/development/KraneticFitness", name: "Empty Session", state: "done" }),
  );
  assert.match(describeRoster(roster, {}, NOW), /KraneticFitness: Empty Session done/);
  assert.match(
    describeRoster(roster, { fitness: "/home/krane/development/KraneticFitness" }, NOW),
    /fitness: Empty Session done/,
  );
});

test("a session with no name at all is still described", () => {
  const roster = rosterOf(session({ name: null, status: "idle", state: null }));
  assert.equal(describeRoster(roster, {}, NOW), "one session: jarvis idle");
});

test("a spoken roster never contains a uuid, a pid or a path", () => {
  // The whole output channel is a voice. Any of these three read aloud is a
  // wasted turn and an irritated user.
  const line = describeRoster(parseRoster(LIVE_LISTING), {}, NOW);
  assert.ok(!line.includes("3b139d5b-d998"), line);
  assert.ok(!line.includes("1308510"), line);
  assert.ok(!line.includes("/home/krane"), line);
});

test("a long roster is summarised rather than recited", () => {
  const many = Array.from({ length: MAX_SPOKEN + 3 }, (_, i) =>
    session({ sessionId: `id-${i}`, name: `jarvis-${i}`, status: "idle", state: null }),
  );
  const line = describeRoster(parseRoster(JSON.stringify(many)), {}, NOW);
  assert.match(line, /^eight sessions:/);
  assert.match(line, /and three more$/);
  assert.ok(!line.includes(`jarvis-${MAX_SPOKEN}`), line);
});

test("an unrecognised state is never read aloud verbatim", () => {
  // A CLI that grows a new state must not put its jargon in someone's ear.
  const roster = rosterOf(session({ state: "reticulating", status: "unheard-of" }));
  const line = describeRoster(roster, {}, NOW);
  assert.ok(!line.includes("reticulating"), line);
  assert.match(line, /jarvis-1-builder-test-fix running/);
});

// ---------------------------------------------------------------------------
// listAgents — against a real fake CLI on disk
// ---------------------------------------------------------------------------

let workspace;
const fake = {};

// Same trick as test/builder.test.js: a real executable script, spawned for
// real, so the child-process plumbing is under test rather than mocked away.
async function writeFake(name, body) {
  const path = join(workspace, name);
  await writeFile(path, ["#!/usr/bin/env node", body].join("\n"), { mode: 0o755 });
  return path;
}

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "jarvis-agents-"));

  fake.listing = await writeFake("claude-listing.cjs", `console.log(${JSON.stringify(LIVE_LISTING)});`);

  // Reports its own arguments as a session name, which is how the flag-passing
  // tests see what the spawn actually asked for.
  fake.echoArgs = await writeFake(
    "claude-echo-args.cjs",
    [
      "const args = process.argv.slice(2).join(' ');",
      "console.log(JSON.stringify([{ sessionId: 'args', name: args }]));",
    ].join("\n"),
  );

  // Exit non-zero having printed a perfectly good roster: proves the exit code
  // is checked and not just the output.
  fake.exitTwo = await writeFake(
    "claude-exit-two.cjs",
    [`console.log(${JSON.stringify(LIVE_LISTING)});`, 'console.error("unknown command");', "process.exitCode = 2;"].join("\n"),
  );

  fake.garbage = await writeFake("claude-garbage.cjs", 'console.log("Usage: claude [options]");');

  // Never answers and ignores the polite ask, so the timeout is the only thing
  // that can end this call.
  fake.hang = await writeFake(
    "claude-hang.cjs",
    ['process.on("SIGTERM", () => {});', "setInterval(() => {}, 1000);"].join("\n"),
  );
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

test("a listing from the CLI comes back parsed", async () => {
  const roster = await listAgents({ bin: fake.listing });
  assert.equal(roster.length, 6);
  assert.equal(roster[0].sessionId, "eb00f586-15be-4807-a3a9-9f52d752eb65");
});

test("the listing subcommand is asked for in JSON", async () => {
  const [record] = await listAgents({ bin: fake.echoArgs });
  assert.equal(record.name, "agents --json");
});

test("naming a repo narrows the listing to it", async () => {
  const [record] = await listAgents({ bin: fake.echoArgs, cwd: "/tmp/x" });
  assert.equal(record.name, "agents --json --cwd /tmp/x");
});

test("an empty cwd is not passed as a flag with nothing after it", async () => {
  // --cwd is variadic-adjacent: a flag left dangling would swallow whatever
  // came next, and there is no reason to send one for "everywhere".
  const [record] = await listAgents({ bin: fake.echoArgs, cwd: "" });
  assert.equal(record.name, "agents --json");
});

test("a CLI that is not installed answers null rather than throwing", async () => {
  // Not [] — an empty array is the claim that nothing is running, and saying
  // that out loud while six sessions work away is worse than saying nothing.
  const roster = await listAgents({ bin: join(workspace, "no-such-binary") });
  assert.equal(roster, null);
});

test("a non-zero exit is not a roster, even with a perfectly good listing on stdout", async () => {
  const roster = await listAgents({ bin: fake.exitTwo });
  assert.equal(roster, null);
});

test("output that is not JSON is not a roster", async () => {
  const roster = await listAgents({ bin: fake.garbage });
  assert.equal(roster, null);
});

test("a CLI that hangs is abandoned rather than waited on", async () => {
  const started = Date.now();
  const roster = await listAgents({ bin: fake.hang, timeoutMs: 150 });
  assert.equal(roster, null);
  // Well under the default leash, which is what proves the override was used
  // and not simply that the process eventually died.
  assert.ok(Date.now() - started < LIST_TIMEOUT_MS, "should have given up at its own deadline");
});

test("a CLI that answers with an empty listing is saying nothing is running", async () => {
  // The one case that must NOT be null: the CLI was asked, it answered, and
  // the answer was "none". That is a fact worth speaking.
  const empty = await writeFake("claude-empty.cjs", 'console.log("[]");');
  assert.deepEqual(await listAgents({ bin: empty }), []);
});
