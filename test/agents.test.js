import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFakeCli } from "./helpers.js";
import { DEDUPE_MS } from "../lib/hooks.js";
import {
  LIST_TIMEOUT_MS,
  MAX_LISTED,
  MAX_ROSTER_AGE_MS,
  POLL_MS,
  completedIn,
  countWord,
  createRosterPoller,
  endedAtOf,
  isBlocked,
  isDone,
  stampEnded,
  trackEnded,
  describeRoster,
  idleAmong,
  isWorking,
  matchSessions,
  mentionedSessions,
  matchStarted,
  diffRoster,
  listAgents,
  orderRoster,
  ownRunning,
  parseRoster,
  rosterForClient,
  visibleSessions,
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
  // and in Phase C is recorded in the recap log. It is not trusted text.
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

// describeRoster reads an already-ordered, already-numbered roster --
// orderRoster's own job, tested in the section above -- so these fixtures set
// `alias`/`number` by hand rather than going through orderRoster themselves.
// `session()` is used directly (not rosterOf/parseRoster): parseListing keeps
// only the fields a live CLI actually sends, and would silently drop `alias`
// and `number` off a fixture that tried to carry them through it.
const numbered = (overrides = {}) => session({ alias: "jarvis", number: 1, ...overrides });

test("an empty roster says so out loud rather than saying nothing", () => {
  assert.equal(describeRoster([], NOW), "Nothing is running.");
  assert.equal(describeRoster(null, NOW), "Nothing is running.");
  assert.equal(describeRoster("not a roster", NOW), "Nothing is running.");
});

test("a numbered line names the session, where it lives, and what it is doing", () => {
  const roster = [numbered({ startedAt: NOW - 4 * 60_000 })];
  assert.equal(describeRoster(roster, NOW), "1: jarvis-1-builder-test-fix in jarvis, working, 4 minutes in");
});

test("an idle session is not told how long it has been idle", () => {
  // Three hours of idleness is not an answer to "what's running" — it is noise
  // in a channel that costs a second per word.
  const roster = [numbered({ status: "idle", state: null, startedAt: NOW - 3 * 3_600_000 })];
  assert.equal(describeRoster(roster, NOW), "1: jarvis-1-builder-test-fix in jarvis, idle");
});

test("a session whose task still reads working but whose process is idle is said to be idle", () => {
  // The CLI leaves `state` at "working" across a turn that ended without
  // finishing anything, and reports the process itself as `status: "idle"`.
  // Reading `state` first told the person a session was four hours into work
  // it had stopped doing; the process is what they are asking about.
  const roster = [numbered({ state: "working", status: "idle", startedAt: NOW - 4 * 3_600_000 })];
  assert.equal(describeRoster(roster, NOW), "1: jarvis-1-builder-test-fix in jarvis, idle");
  // And a working state with no status at all is still working -- only an
  // idle status contradicts it, not a missing one.
  const unknown = [numbered({ state: "working", status: null, startedAt: NOW - 4 * 60_000 })];
  assert.equal(describeRoster(unknown, NOW), "1: jarvis-1-builder-test-fix in jarvis, working, 4 minutes in");
});

test("a blocked session gets the same elapsed suffix a working one does", () => {
  // "blocked" is waiting on a person, which is exactly the kind of thing worth
  // saying how long it has been waiting for.
  const roster = [numbered({ state: "blocked", status: "idle", startedAt: NOW - 4 * 60_000 })];
  assert.equal(describeRoster(roster, NOW), "1: jarvis-1-builder-test-fix in jarvis, blocked, 4 minutes in");
});

test("elapsed time is rounded to something a person would say", () => {
  const at = (ms) => describeRoster([numbered({ startedAt: NOW - ms })], NOW);
  assert.match(at(20_000), /just started/);
  assert.match(at(90_000), /a minute in/);
  assert.match(at(25 * 60_000), /25 minutes in/);
  assert.match(at(62 * 60_000), /an hour in/);
  assert.match(at(5 * 3_600_000), /5 hours in/);
});

test("a clock that ran backwards says nothing about elapsed time rather than counting down", () => {
  const roster = [numbered({ startedAt: NOW + 60_000 })];
  assert.equal(describeRoster(roster, NOW), "1: jarvis-1-builder-test-fix in jarvis, working");
});

test("an empty alias is left out of the line rather than shown as blank", () => {
  // A session Dante cannot place in any workspace (orderRoster's own leftover
  // bucket) still gets a line -- it just names no repository.
  const roster = [numbered({ alias: "", status: "idle", state: null })];
  assert.equal(describeRoster(roster, NOW), "1: jarvis-1-builder-test-fix, idle");
});

test("a session with no name at all falls back to an unnamed session", () => {
  const roster = [numbered({ name: null, status: "idle", state: null })];
  assert.equal(describeRoster(roster, NOW), "1: an unnamed session in jarvis, idle");
});

test("several sessions are several lines, one per session, in the order given", () => {
  const roster = [
    numbered({ sessionId: "a", number: 1, name: "bug-hunt", status: "idle", state: null }),
    numbered({ sessionId: "b", number: 2, alias: "fitness", name: "readme-summary", status: "idle", state: null }),
  ];
  assert.equal(
    describeRoster(roster, NOW),
    "1: bug-hunt in jarvis, idle\n2: readme-summary in fitness, idle",
  );
});

test("a spoken roster never contains a uuid, a pid or a path", () => {
  // The whole output channel is a voice. Any of these three read aloud is a
  // wasted turn and an irritated user.
  const line = describeRoster(parseRoster(LIVE_LISTING), NOW);
  assert.ok(!line.includes("3b139d5b-d998"), line);
  assert.ok(!line.includes("1308510"), line);
  assert.ok(!line.includes("/home/krane"), line);
});

test("a roster past the cap is listed up to it, with the rest counted rather than named", () => {
  const many = Array.from({ length: MAX_LISTED + 3 }, (_, i) =>
    numbered({ sessionId: `id-${i}`, number: i + 1, name: `jarvis-${i}`, status: "idle", state: null }),
  );
  const line = describeRoster(many, NOW);
  const lines = line.split("\n");
  assert.equal(lines.length, MAX_LISTED + 1);
  assert.equal(lines.at(-1), "(three more not shown)");
  assert.ok(!line.includes(`jarvis-${MAX_LISTED}`), line);
});

test("an unrecognised state is never read aloud verbatim", () => {
  // A CLI that grows a new state must not put its jargon in someone's ear.
  const roster = [numbered({ state: "reticulating", status: "unheard-of" })];
  const line = describeRoster(roster, NOW);
  assert.ok(!line.includes("reticulating"), line);
  assert.match(line, /jarvis-1-builder-test-fix in jarvis, running/);
});

test("counting words reach all the way to the cap, not just the old five", () => {
  // MAX_LISTED is fifteen; a hidden count or a refusal naming "how many are
  // running" has to be able to say any of them as a word, not fall back to a
  // bare digit the moment it passes ten.
  assert.equal(countWord(11), "eleven");
  assert.equal(countWord(12), "twelve");
  assert.equal(countWord(13), "thirteen");
  assert.equal(countWord(14), "fourteen");
  assert.equal(countWord(15), "fifteen");
});

test("a count past the word list is read as the digit rather than nothing", () => {
  assert.equal(countWord(16), "16");
});

// ---------------------------------------------------------------------------
// rosterForClient
// ---------------------------------------------------------------------------

// What server.js's broadcastRoster compares tick to tick, before it decorates
// the rows with anything of its own.
const wire = (roster) => JSON.stringify(rosterForClient(roster));

test("a row for the page carries what it paints and nothing that names a process or a path", () => {
  const roster = [numbered({ pid: 4242, cwd: "/home/krane/development/jarvis" })];
  assert.deepEqual(rosterForClient(roster), [{
    sessionId: "abcd1234-0000-0000-0000-000000000000",
    name: "jarvis-1-builder-test-fix",
    alias: "jarvis",
    number: 1,
    state: "working",
    status: "busy",
    startedAt: 1_000_000,
    endedAt: null,
  }]);
  assert.deepEqual(rosterForClient(null), []);
  assert.deepEqual(rosterForClient("not a roster"), []);
});

test("the page is sent the same cut of the list the model is told about", () => {
  const many = Array.from({ length: MAX_LISTED + 3 }, (_, i) =>
    numbered({ sessionId: `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`, number: i + 1 }));
  assert.equal(rosterForClient(many).length, MAX_LISTED);
});

test("a status that moved under an unchanged state changes the wire, so the panel is pushed", () => {
  // diffRoster would see nothing here: isWorking reads `state` first and it is
  // still "working" on both sides. The panel painted this session as working
  // until some unrelated session started or ended, because the only broadcast
  // hung off diffRoster's events. Comparing the projection is what fixes it.
  const busy = [numbered({ state: "working", status: "busy" })];
  const idle = [numbered({ state: "working", status: "idle" })];
  assert.deepEqual(diffRoster(busy, idle), []);
  assert.notEqual(wire(busy), wire(idle));
});

test("a done session's finish time rides the wire, and a finish stamped later changes it", () => {
  // The page stops a done row's clock at endedAt (rowFromRecord in
  // public/roster-panel.js). The poller stamps that on the tick it first sees
  // the session done, which can be a tick after the state itself changed.
  // diffRoster reports that refinement as a "finished" event, but the panel
  // no longer listens to events, so the wire is what has to carry it.
  const done = [numbered({ state: "done", status: "idle" })];
  const stamped = [numbered({ state: "done", status: "idle", endedAt: 2_000_000 })];
  assert.equal(rosterForClient(done)[0].endedAt, null);
  assert.equal(rosterForClient(stamped)[0].endedAt, 2_000_000);
  assert.notEqual(wire(done), wire(stamped));
  // A stamp on a live session is not a finish time, whoever put it there.
  assert.equal(rosterForClient([numbered({ endedAt: 2_000_000 })])[0].endedAt, null);
});

test("a tick that changed nothing the page paints leaves the wire unchanged", () => {
  // A fresh listing is a new array of new objects every five seconds; only the
  // content may decide whether the page hears about it.
  const a = [numbered({ pid: 1 }), numbered({ sessionId: "b", pid: 2, number: 2 })];
  const b = [numbered({ pid: 1 }), numbered({ sessionId: "b", pid: 2, number: 2 })];
  assert.equal(wire(a), wire(b));
  // Renumbering is a change the page paints, and one diffRoster never sees.
  const renumbered = [numbered({ pid: 1, number: 2 }), numbered({ sessionId: "b", pid: 2, number: 1 })];
  assert.notEqual(wire(a), wire(renumbered));
});

// ---------------------------------------------------------------------------
// orderRoster
// ---------------------------------------------------------------------------

test("repositories come first main, then alphabetical, and sessions are numbered globally", () => {
  const roster = rosterOf(
    session({ sessionId: "z", cwd: "/home/krane/development/zebra", name: "zebra-1" }),
    session({ sessionId: "a", cwd: "/home/krane/development/jarvis", name: "jarvis-1" }),
    session({ sessionId: "m", cwd: "/home/krane/development/KraneticFitness", name: "fitness-1" }),
  );
  const aliases = {
    jarvis: "/home/krane/development/jarvis",
    fitness: "/home/krane/development/KraneticFitness",
    zebra: "/home/krane/development/zebra",
  };
  // workspacesForClient's own shape: main first, then alphabetical.
  const order = ["fitness", "jarvis", "zebra"];
  const result = orderRoster(roster, { aliases, order });
  assert.deepEqual(result.map((r) => [r.alias, r.number]), [
    ["fitness", 1],
    ["jarvis", 2],
    ["zebra", 3],
  ]);
});

test("inside a repository, the oldest session is numbered first", () => {
  const JARVIS = "/home/krane/development/jarvis";
  const roster = rosterOf(
    session({ sessionId: "newer", cwd: JARVIS, startedAt: 5000 }),
    session({ sessionId: "older", cwd: JARVIS, startedAt: 1000 }),
  );
  const result = orderRoster(roster, { aliases: { jarvis: JARVIS }, order: ["jarvis"] });
  assert.deepEqual(result.map((r) => r.sessionId), ["older", "newer"]);
  assert.deepEqual(result.map((r) => r.number), [1, 2]);
});

test("numbers only move when something stops, so a fresh session is numbered last in its bucket", () => {
  // The whole point of oldest-first: starting a new session must not renumber
  // one somebody already said "session three" about a moment ago.
  const JARVIS = "/home/krane/development/jarvis";
  const before = orderRoster(rosterOf(session({ sessionId: "a", cwd: JARVIS, startedAt: 1000 })), {
    aliases: { jarvis: JARVIS },
    order: ["jarvis"],
  });
  assert.equal(before[0].number, 1);

  const after = orderRoster(
    rosterOf(
      session({ sessionId: "a", cwd: JARVIS, startedAt: 1000 }),
      session({ sessionId: "b", cwd: JARVIS, startedAt: 2000 }),
    ),
    { aliases: { jarvis: JARVIS }, order: ["jarvis"] },
  );
  assert.equal(after.find((r) => r.sessionId === "a").number, 1);
  assert.equal(after.find((r) => r.sessionId === "b").number, 2);
});

test("a session with no start time sorts last within its own repository", () => {
  const JARVIS = "/home/krane/development/jarvis";
  const roster = rosterOf(
    session({ sessionId: "unknown", cwd: JARVIS, startedAt: null }),
    session({ sessionId: "known", cwd: JARVIS, startedAt: 5000 }),
  );
  const result = orderRoster(roster, { aliases: { jarvis: JARVIS }, order: ["jarvis"] });
  assert.deepEqual(result.map((r) => r.sessionId), ["known", "unknown"]);
});

test("equal start times are ordered by session id, so the order never depends on CLI print order", () => {
  const JARVIS = "/home/krane/development/jarvis";
  const roster = rosterOf(
    session({ sessionId: "b", cwd: JARVIS, startedAt: 1000 }),
    session({ sessionId: "a", cwd: JARVIS, startedAt: 1000 }),
  );
  const result = orderRoster(roster, { aliases: { jarvis: JARVIS }, order: ["jarvis"] });
  assert.deepEqual(result.map((r) => r.sessionId), ["a", "b"]);
});

test("a session in a repository not named in order still gets a number, after every named one", () => {
  const JARVIS = "/home/krane/development/jarvis";
  const STRAY = "/home/krane/development/long-gone";
  const roster = rosterOf(
    session({ sessionId: "stray", cwd: STRAY, startedAt: 1000 }),
    session({ sessionId: "known", cwd: JARVIS, startedAt: 5000 }),
  );
  const result = orderRoster(roster, { aliases: { jarvis: JARVIS }, order: ["jarvis"] });
  assert.deepEqual(result.map((r) => r.sessionId), ["known", "stray"]);
  assert.deepEqual(result.map((r) => r.number), [1, 2]);
});

test("numbering runs over the whole roster, not just what a panel would show", () => {
  const JARVIS = "/home/krane/development/jarvis";
  const many = Array.from({ length: 20 }, (_, i) =>
    session({ sessionId: `id-${i}`, cwd: JARVIS, startedAt: 1000 + i }),
  );
  const result = orderRoster(rosterOf(...many), { aliases: { jarvis: JARVIS }, order: ["jarvis"] });
  assert.equal(result.length, 20);
  assert.equal(result[19].number, 20);
});

test("an alias is resolved through within, so a worktree cwd carries its parent workspace's alias", () => {
  // Dante's own start:verb sessions call EnterWorktree and move under
  // .claude/worktrees/<name>, still inside the repo -- see aliasFor's own note.
  const JARVIS = "/home/krane/development/jarvis";
  const roster = rosterOf(
    session({ sessionId: "a", cwd: `${JARVIS}/.claude/worktrees/repo-persistence` }),
  );
  const result = orderRoster(roster, { aliases: { jarvis: JARVIS }, order: ["jarvis"] });
  assert.equal(result[0].alias, "jarvis");
});

test("orderRoster tolerates a missing order and a missing roster", () => {
  assert.deepEqual(orderRoster(null, {}), []);
  assert.deepEqual(orderRoster(undefined), []);
  const [record] = orderRoster(rosterOf(session()));
  assert.equal(record.number, 1);
});

test("a duplicate alias in order cannot number the same repository's sessions twice", () => {
  const JARVIS = "/home/krane/development/jarvis";
  const roster = rosterOf(
    session({ sessionId: "a", cwd: JARVIS, startedAt: 1000 }),
    session({ sessionId: "b", cwd: JARVIS, startedAt: 2000 }),
  );
  const result = orderRoster(roster, { aliases: { jarvis: JARVIS }, order: ["jarvis", "jarvis"] });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((r) => r.number), [1, 2]);
});

test("a non-object entry on the roster is skipped rather than crashing", () => {
  const JARVIS = "/home/krane/development/jarvis";
  const roster = [null, undefined, "not a session", 42, ...rosterOf(session({ cwd: JARVIS }))];
  const result = orderRoster(roster, { aliases: { jarvis: JARVIS }, order: ["jarvis"] });
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 1);
});

// ---------------------------------------------------------------------------
// listAgents — against a real fake CLI on disk
// ---------------------------------------------------------------------------

let workspace;
const fake = {};

// Same trick as test/builder.test.js: a real executable script, spawned for
// real, so the child-process plumbing is under test rather than mocked away.
const writeFake = (name, body) => writeFakeCli(workspace, name, body);

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dante-agents-"));

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

// ---------------------------------------------------------------------------
// diffRoster
// ---------------------------------------------------------------------------

test("nothing changed is no events", () => {
  const roster = rosterOf(session());
  assert.deepEqual(diffRoster(roster, roster), []);
  assert.deepEqual(diffRoster([], []), []);
});

test("a session that left the roster is the event someone is waiting for", () => {
  const before = rosterOf(session());
  const events = diffRoster(before, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "gone");
  assert.equal(events[0].session.name, "jarvis-1-builder-test-fix");
});

test("a session that stopped working is idle, however the CLI spelled it", () => {
  const working = rosterOf(session({ state: "working", status: "busy" }));
  assert.equal(diffRoster(working, rosterOf(session({ state: "done", status: "idle" })))[0].kind, "idle");
  // An interactive session carries no state at all, so status is the fallback.
  const busy = rosterOf(session({ state: null, status: "busy" }));
  assert.equal(diffRoster(busy, rosterOf(session({ state: null, status: "idle" })))[0].kind, "idle");
});

test("a session waiting on a permission prompt is not idle", () => {
  // "blocked" came off a live listing. Treating it as idle is exactly how a
  // follow-up would fork a session instead of joining it.
  const working = rosterOf(session({ state: "working" }));
  assert.deepEqual(diffRoster(working, rosterOf(session({ state: "blocked" }))), []);
});

test("a session that picked something up is busy", () => {
  const idle = rosterOf(session({ state: "done", status: "idle" }));
  const events = diffRoster(idle, rosterOf(session({ state: "working", status: "busy" })));
  assert.equal(events[0].kind, "busy");
});

test("a session that appeared is reported, whoever started it", () => {
  const events = diffRoster([], rosterOf(session()));
  assert.equal(events[0].kind, "started");
});

test("endings come before everything else in a tick", () => {
  const before = rosterOf(session({ sessionId: "a", name: "gone-one" }), session({ sessionId: "b", state: "working" }));
  const after = rosterOf(session({ sessionId: "b", state: "done", status: "idle" }), session({ sessionId: "c", name: "new-one" }));
  assert.deepEqual(
    diffRoster(before, after).map((e) => e.kind),
    ["gone", "idle", "started"],
  );
});

test("no baseline reports nothing, so a restart does not announce what was already running", () => {
  // And a failed listing arriving as null must never read as "everything ended
  // at once", which is the same guard.
  assert.deepEqual(diffRoster(null, rosterOf(session())), []);
  assert.deepEqual(diffRoster(undefined, rosterOf(session())), []);
  assert.deepEqual(diffRoster(rosterOf(session()), null), []);
});

// ---------------------------------------------------------------------------
// idleAmong
// ---------------------------------------------------------------------------

test("idleAmong returns idle records whose session id is queued", () => {
  const roster = rosterOf(session({ sessionId: "a", state: "done", status: "idle" }));
  assert.deepEqual(idleAmong(roster, new Set(["a"])), roster);
});

test("idleAmong excludes a working session even if it is queued", () => {
  const roster = rosterOf(session({ sessionId: "a", state: "working", status: "busy" }));
  assert.deepEqual(idleAmong(roster, new Set(["a"])), []);
});

test("idleAmong excludes a queued session id that is not on the roster", () => {
  const roster = rosterOf(session({ sessionId: "a", state: "done", status: "idle" }));
  assert.deepEqual(idleAmong(roster, new Set(["b"])), []);
});

test("idleAmong excludes an idle session with no queue", () => {
  const roster = rosterOf(session({ sessionId: "a", state: "done", status: "idle" }));
  assert.deepEqual(idleAmong(roster, new Set()), []);
});

test("idleAmong treats a blocked session as working even when its status says idle", () => {
  // isWorking's own comment: "blocked" counts as working on purpose, and
  // state wins over status where both are present.
  const roster = rosterOf(session({ sessionId: "a", state: "blocked", status: "idle" }));
  assert.deepEqual(idleAmong(roster, new Set(["a"])), []);
});

test("idleAmong treats a finished session as idle even when its status says busy", () => {
  const roster = rosterOf(session({ sessionId: "a", state: "done", status: "busy" }));
  assert.deepEqual(idleAmong(roster, new Set(["a"])), roster);
});

test("idleAmong treats a missing or malformed id set as nothing queued", () => {
  const roster = rosterOf(session({ sessionId: "a", state: "done", status: "idle" }));
  assert.deepEqual(idleAmong(roster, undefined), []);
  assert.deepEqual(idleAmong(roster, 42), []);
});

// ---------------------------------------------------------------------------
// createRosterPoller
// ---------------------------------------------------------------------------

// A listing function that hands back a scripted sequence, so a whole run of
// ticks is a plain array rather than a wait.
function scripted(...answers) {
  let i = 0;
  const calls = [];
  const list = async () => {
    calls.push(Date.now());
    return answers[Math.min(i++, answers.length - 1)];
  };
  list.calls = calls;
  return list;
}

test("the first tick is a baseline, not an announcement", async () => {
  const seen = [];
  const poller = createRosterPoller({
    list: scripted(rosterOf(session())),
    onEvents: (events) => seen.push(...events),
  });
  await poller.read();
  poller.stop();
  assert.deepEqual(seen, []);
  assert.equal(poller.current().length, 1);
});

test("a session finishing between ticks is reported once", async () => {
  const seen = [];
  const poller = createRosterPoller({
    list: scripted(rosterOf(session({ state: "working" })), rosterOf(session({ state: "done", status: "idle" }))),
    maxAgeMs: 0,
    onEvents: (events) => seen.push(...events),
  });
  await poller.read();
  await poller.read();
  await poller.read();
  poller.stop();
  assert.deepEqual(seen.map((e) => e.kind), ["idle"]);
});

test("a listing that failed keeps the last roster rather than reporting it gone", async () => {
  // The whole reason listAgents separates null from []: a CLI hiccup must not
  // announce that every session ended.
  const seen = [];
  const poller = createRosterPoller({
    list: scripted(rosterOf(session()), null),
    maxAgeMs: 0,
    onEvents: (events) => seen.push(...events),
  });
  await poller.read();
  await poller.read();
  poller.stop();
  assert.deepEqual(seen, []);
  assert.equal(poller.current().length, 1);
});

test("a fresh read hands back the roster only when the listing actually succeeded", async () => {
  const poller = createRosterPoller({ list: scripted(rosterOf(session()), null, rosterOf()), maxAgeMs: 0 });
  await poller.read();
  // The second listing fails: read() would keep the first roster, fresh()
  // must not pass it off as taken now.
  assert.equal(await poller.fresh(), null);
  assert.equal(poller.current().length, 1);
  // The third succeeds and is empty, and empty is a real answer.
  assert.deepEqual(await poller.fresh(), []);
  poller.stop();
});

test("a fresh read waits out a listing already in flight rather than reusing its answer", async () => {
  // The in-flight tick started before the caller acted, so its roster says
  // nothing about what the caller just did.
  let resolveFirst;
  const answers = [new Promise((r) => { resolveFirst = r; }), rosterOf()];
  let i = 0;
  const list = () => answers[Math.min(i++, answers.length - 1)];
  const poller = createRosterPoller({ list, maxAgeMs: 0 });
  const first = poller.read();
  const fresh = poller.fresh();
  resolveFirst(rosterOf(session()));
  assert.equal((await first).length, 1);
  assert.deepEqual(await fresh, []);
  assert.equal(i, 2);
  poller.stop();
});

test("a fresh enough roster is reused rather than re-read", async () => {
  const list = scripted(rosterOf(session()));
  const poller = createRosterPoller({ list, maxAgeMs: 60_000 });
  await poller.read();
  await poller.read();
  await poller.read();
  poller.stop();
  assert.equal(list.calls.length, 1);
});

test("the staleness bound sits above the poll interval, so a healthy poller almost never triggers a spawn", () => {
  assert.ok(MAX_ROSTER_AGE_MS > POLL_MS);
});

test("a roster just under the staleness bound is reused rather than re-read", async () => {
  const list = scripted(rosterOf(session()));
  let time = 0;
  const poller = createRosterPoller({ list, now: () => time });
  await poller.read();
  time = MAX_ROSTER_AGE_MS - 1;
  await poller.read();
  poller.stop();
  assert.equal(list.calls.length, 1);
});

test("a roster at the staleness bound is stale enough to re-list", async () => {
  const list = scripted(rosterOf(session()));
  let time = 0;
  const poller = createRosterPoller({ list, now: () => time });
  await poller.read();
  time = MAX_ROSTER_AGE_MS;
  await poller.read();
  poller.stop();
  assert.equal(list.calls.length, 2);
});

test("a read that asks for a fresh roster re-lists even when the cache is young", async () => {
  const list = scripted(rosterOf(session()));
  let time = 0;
  const poller = createRosterPoller({ list, now: () => time });
  await poller.read();
  time = 1;
  await poller.read({ maxAgeMs: 0 });
  poller.stop();
  assert.equal(list.calls.length, 2);
});

test("two reads at once share one listing rather than racing", async () => {
  // A slow CLI and a fixed interval is how a poller ends up with three child
  // processes racing to set the same baseline.
  const list = scripted(rosterOf(session()));
  const poller = createRosterPoller({ list, maxAgeMs: 0 });
  await Promise.all([poller.read(), poller.read(), poller.read()]);
  poller.stop();
  assert.equal(list.calls.length, 1);
});

test("a listener that throws does not stop the poller", async () => {
  // The queue and the reporting both hang off this timer.
  const poller = createRosterPoller({
    list: scripted(rosterOf(session({ state: "working" })), rosterOf(session({ state: "done" })), []),
    maxAgeMs: 0,
    onEvents: () => {
      throw new Error("a bad listener");
    },
  });
  await poller.read();
  await poller.read();
  assert.deepEqual(await poller.read(), []);
  poller.stop();
});

test("onRoster sees the baseline roster on the very first tick", async () => {
  // onEvents does not fire on the baseline tick (diffRoster against a null
  // previous is deliberately empty); onRoster has no such exception, because
  // "what is currently true" is exactly as true on the first tick as any other.
  const seen = [];
  let eventsFired = false;
  const poller = createRosterPoller({
    list: scripted(rosterOf(session())),
    onRoster: (roster) => seen.push(roster),
    onEvents: () => {
      eventsFired = true;
    },
  });
  await poller.read();
  poller.stop();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 1);
  assert.equal(eventsFired, false);
});

test("onRoster fires on every successful tick, not only the ones with events", async () => {
  const seen = [];
  const poller = createRosterPoller({
    // The same session on every tick: diffRoster produces no events, but
    // onRoster still has to fire, because a queue can gain an entry between
    // ticks with the roster never moving at all.
    list: scripted(rosterOf(session()), rosterOf(session()), rosterOf(session())),
    maxAgeMs: 0,
    onRoster: (roster) => seen.push(roster),
  });
  await poller.read();
  await poller.read();
  await poller.read();
  poller.stop();
  assert.equal(seen.length, 3);
});

test("onRoster does not fire on a failed listing", async () => {
  const seen = [];
  const poller = createRosterPoller({
    list: scripted(rosterOf(session()), null),
    maxAgeMs: 0,
    onRoster: (roster) => seen.push(roster),
  });
  await poller.read();
  await poller.read();
  poller.stop();
  assert.equal(seen.length, 1);
});

test("a throwing onRoster does not stop the poller", async () => {
  // Mirrors "a listener that throws does not stop the poller" above: the
  // queue and the reporting both hang off this timer. Also checks the error
  // isolation the doc comment promises -- a bad onRoster must not cost the
  // tick its onEvents call either.
  const seenEvents = [];
  const poller = createRosterPoller({
    list: scripted(rosterOf(session({ state: "working" })), rosterOf(session({ state: "done" })), []),
    maxAgeMs: 0,
    onRoster: () => {
      throw new Error("a bad listener");
    },
    onEvents: (events) => seenEvents.push(...events),
  });
  await poller.read();
  await poller.read();
  assert.deepEqual(await poller.read(), []);
  poller.stop();
  // Three ticks: the baseline (no event), working -> done (idle), done -> []
  // (gone). Both post-baseline ticks fired onEvents despite onRoster
  // throwing on every one of the three.
  assert.deepEqual(seenEvents.map((e) => e.kind), ["idle", "gone"]);
});

test("a listing that rejects is a missed tick, not a dead poller", async () => {
  let first = true;
  const poller = createRosterPoller({
    maxAgeMs: 0,
    list: async () => {
      if (first) {
        first = false;
        throw new Error("boom");
      }
      return rosterOf(session());
    },
  });
  assert.equal(await poller.read(), null);
  assert.equal((await poller.read()).length, 1);
  poller.stop();
});

test("stopping twice, and starting twice, are both harmless", async () => {
  const poller = createRosterPoller({ list: scripted([]), intervalMs: 10_000 });
  poller.start();
  poller.start();
  poller.stop();
  poller.stop();
  assert.deepEqual(await poller.read(), []);
  poller.stop();
});

// ---------------------------------------------------------------------------
// matchSessions
// ---------------------------------------------------------------------------

const THREE = rosterOf(
  session({ sessionId: "a", name: "jarvis-1-review" }),
  session({ sessionId: "b", name: "jarvis-2-fix-tests" }),
  session({ sessionId: "c", name: "fitness-1-review" }),
);

test("a session is found by the name it was given", () => {
  assert.deepEqual(matchSessions(THREE, "jarvis-2-fix-tests").map((r) => r.sessionId), ["b"]);
});

test("punctuation and case are not worth refusing a spoken name over", () => {
  for (const spoken of ["JARVIS 2 fix tests", "jarvis_2_fix_tests", "  jarvis-2-fix-tests  "]) {
    assert.deepEqual(matchSessions(THREE, spoken).map((r) => r.sessionId), ["b"], spoken);
  }
});

test("a prefix finds the session it names", () => {
  assert.deepEqual(matchSessions(THREE, "jarvis-1").map((r) => r.sessionId), ["a"]);
});

test("an exact name is never made ambiguous by a longer one", () => {
  const roster = rosterOf(
    session({ sessionId: "a", name: "jarvis-1" }),
    session({ sessionId: "b", name: "jarvis-1-review" }),
  );
  assert.deepEqual(matchSessions(roster, "jarvis-1").map((r) => r.sessionId), ["a"]);
});

test("several matches come back as several, never as a best guess", () => {
  // Silently picking the first is how "stop jarvis one" stops the wrong process.
  const roster = rosterOf(
    session({ sessionId: "a", name: "jarvis-1-review" }),
    session({ sessionId: "b", name: "jarvis-1-review-2" }),
  );
  assert.equal(matchSessions(roster, "jarvis-1").length, 2);
});

test("a name nothing answers to matches nothing", () => {
  assert.deepEqual(matchSessions(THREE, "nonsense"), []);
  assert.deepEqual(matchSessions(THREE, ""), []);
  assert.deepEqual(matchSessions(THREE, null), []);
  assert.deepEqual(matchSessions(null, "jarvis-1"), []);
});

test("a session with no name is never matched by an empty one", () => {
  const roster = rosterOf(session({ sessionId: "a", name: null }));
  assert.deepEqual(matchSessions(roster, "jarvis"), []);
});

test("whether a session can take a follow-up is one question with one answer", () => {
  assert.equal(isWorking({ state: "working" }), true);
  assert.equal(isWorking({ state: "blocked" }), true);
  assert.equal(isWorking({ state: "done", status: "busy" }), false);
  assert.equal(isWorking({ state: null, status: "busy" }), true);
  assert.equal(isWorking({ state: null, status: "idle" }), false);
  assert.equal(isWorking({ state: null, status: null }), false);
});

test("isBlocked is true only for a record sitting on a permission prompt right now", () => {
  assert.equal(isBlocked({ state: "blocked" }), true);
  assert.equal(isBlocked({ state: "working" }), false);
  assert.equal(isBlocked({ state: "done" }), false);
  assert.equal(isBlocked(null), false);
  assert.equal(isBlocked("blocked"), false);
});

test("a session named with its repository in front is still found", () => {
  // describeRoster reads a hand-started session out loud as "jarvis: Empty
  // Session", so that is what comes back in the tag.
  const roster = rosterOf(session({ sessionId: "a", name: "Empty Session" }));
  assert.deepEqual(matchSessions(roster, "jarvis: Empty Session").map((r) => r.sessionId), ["a"]);
  assert.deepEqual(matchSessions(roster, "jarvis empty session").map((r) => r.sessionId), ["a"]);
});

test("a name that merely shares a word is not a match", () => {
  // The whole name has to be the tail, or "the review one" would match every
  // session with review anywhere in its name.
  const roster = rosterOf(session({ sessionId: "a", name: "review" }));
  assert.deepEqual(matchSessions(roster, "review-the-changes"), []);
  assert.deepEqual(matchSessions(roster, "code review please"), []);
});

// ---------------------------------------------------------------------------
// mentionedSessions
// ---------------------------------------------------------------------------

test("mentionedSessions finds a candidate named exactly in the text", () => {
  const roster = rosterOf(session({ sessionId: "a", name: "jarvis-3" }));
  assert.deepEqual(mentionedSessions("what is jarvis-3 doing", roster), ["jarvis-3"]);
});

test("mentionedSessions is punctuation-insensitive, the same as matchSessions", () => {
  const roster = rosterOf(session({ sessionId: "a", name: "jarvis-3" }));
  assert.deepEqual(mentionedSessions("what is Jarvis 3 doing", roster), ["jarvis-3"]);
});

test("mentionedSessions finds a collided session by the shorthand matchSessions' prefix tier accepts", () => {
  const roster = rosterOf(session({ sessionId: "a", name: "review-2" }));
  assert.deepEqual(mentionedSessions("what did review decide", roster), ["review-2"]);
});

test("mentionedSessions still does not match jarvis-30 by prefix when jarvis-3 is what was actually said and both exist", () => {
  // The full run "jarvis-3" is always tried before the shorter, vaguer
  // "jarvis" prefix of it -- matchSessions' own exact tier resolves it to
  // jarvis-3 alone, and that stops mentionedSessions from ever falling back
  // to a shorter run that would have pulled in jarvis-30 too via prefix.
  const roster = rosterOf(
    session({ sessionId: "a", name: "jarvis-3" }),
    session({ sessionId: "b", name: "jarvis-30" }),
  );
  assert.deepEqual(mentionedSessions("jarvis-3", roster), ["jarvis-3"]);
});

test("mentionedSessions returns nothing for an empty candidate list", () => {
  assert.deepEqual(mentionedSessions("what is jarvis-3 doing", []), []);
  assert.deepEqual(mentionedSessions("what is jarvis-3 doing", null), []);
});

test("mentionedSessions finds a name spoken well past the 100-char clip normalizeName applies to a single name", () => {
  const roster = rosterOf(session({ sessionId: "a", name: "jarvis-3" }));
  const rambling =
    "Right, before anything else this morning, and I appreciate this is a slightly rambling " +
    "question, what on earth is jarvis-3 actually up to";
  assert.ok(rambling.indexOf("jarvis-3") > 100, "the fixture must actually exercise the clip");
  assert.deepEqual(mentionedSessions(rambling, roster), ["jarvis-3"]);
});

// ---------------------------------------------------------------------------
// visibleSessions
// ---------------------------------------------------------------------------

const JARVIS = "/home/krane/development/jarvis";
const FITNESS = "/home/krane/development/KraneticFitness";

test("a session in a repository you never named does not exist", () => {
  // The one that started this: a claude-mem skill keeps a session running in
  // its own directory, and Dante was reading it out loud.
  const roster = rosterOf(
    session({ sessionId: "a-0000000-0000-0000-0000-000000000000", cwd: JARVIS }),
    session({ sessionId: "b-0000000-0000-0000-0000-000000000000", cwd: "/home/krane/.claude-mem/observer-sessions" }),
  );
  const visible = visibleSessions(roster, { roots: [JARVIS] });
  assert.deepEqual(visible.map((r) => r.cwd), [JARVIS]);
});

test("a repository named out loud widens what is visible, with no restart", () => {
  const roster = rosterOf(
    session({ sessionId: "a-0000000-0000-0000-0000-000000000000", cwd: JARVIS }),
    session({ sessionId: "b-0000000-0000-0000-0000-000000000000", cwd: FITNESS }),
  );
  assert.equal(visibleSessions(roster, { roots: [JARVIS] }).length, 1);
  assert.equal(visibleSessions(roster, { roots: [JARVIS, FITNESS] }).length, 2);
});

test("a subdirectory of a named repository is inside it", () => {
  const roster = rosterOf(session({ cwd: `${JARVIS}/lib` }));
  assert.equal(visibleSessions(roster, { roots: [JARVIS] }).length, 1);
  assert.equal(visibleSessions(roster, { roots: [`${JARVIS}/`] }).length, 1, "a trailing slash is the same root");
});

test("a sibling that merely starts with the same name is outside", () => {
  // The failure a plain startsWith would produce, and the reason within() is
  // the same rule resolveWorkspacePath uses.
  const roster = rosterOf(session({ cwd: `${JARVIS}-notes` }));
  assert.deepEqual(visibleSessions(roster, { roots: [JARVIS] }), []);
});

test("a session that cannot be placed anywhere is nobody's business", () => {
  const roster = rosterOf(session({ cwd: null }), session({ cwd: "" }));
  assert.deepEqual(visibleSessions(roster, { roots: [JARVIS] }), []);
});

test("with nothing named, nothing is visible", () => {
  // A whitelist that is empty means empty. Defaulting to "everything" here
  // would put the bug back the first time the store failed to load.
  const roster = rosterOf(session({ cwd: JARVIS }));
  assert.deepEqual(visibleSessions(roster, {}), []);
  assert.deepEqual(visibleSessions(roster, { roots: [] }), []);
  assert.deepEqual(visibleSessions(roster, { roots: [null, 42, ""] }), []);
});

test("Dante's own brain is hidden by id, not by name", () => {
  // Exact, because "never offer to stop my own brain" must be impossible
  // rather than unlikely -- and the brain runs in the jarvis repo, which is a
  // named workspace, so the whitelist alone would show it.
  const brain = "1111aaaa-0000-0000-0000-000000000000";
  const roster = rosterOf(
    session({ sessionId: brain, cwd: JARVIS, name: "jarvis" }),
    session({ sessionId: "2222bbbb-0000-0000-0000-000000000000", cwd: JARVIS, name: "jarvis-1-fix" }),
  );
  const visible = visibleSessions(roster, { roots: [JARVIS], hideIds: [brain] });
  assert.deepEqual(visible.map((r) => r.name), ["jarvis-1-fix"]);
  assert.deepEqual(
    visibleSessions(roster, { roots: [JARVIS], hideIds: new Set([brain]) }).map((r) => r.name),
    ["jarvis-1-fix"],
    "a Set works as well as an array",
  );
});

test("a build is hidden by where it runs, because it has no id Dante knows", () => {
  const builds = `${JARVIS}/builds`;
  const roster = rosterOf(
    session({ sessionId: "a-0000000-0000-0000-0000-000000000000", cwd: `${builds}/2026-08-26T10-00-00`, name: "landing-page" }),
    session({ sessionId: "b-0000000-0000-0000-0000-000000000000", cwd: JARVIS, name: "jarvis-1-fix" }),
  );
  const visible = visibleSessions(roster, { roots: [JARVIS], hideRoots: [builds] });
  assert.deepEqual(visible.map((r) => r.name), ["jarvis-1-fix"]);
});

test("a roster Dante could not read is not an empty one", () => {
  assert.deepEqual(visibleSessions(null, { roots: [JARVIS] }), []);
  assert.deepEqual(visibleSessions(undefined, { roots: [JARVIS] }), []);
  assert.deepEqual(visibleSessions("not a roster", { roots: [JARVIS] }), []);
});

test("the poller filters before it diffs, so a hidden session never becomes an event", () => {
  // The whole point of putting the filter in the poller: if it ran later, a
  // hidden session appearing would still fire a "started" event, and something
  // downstream would report on a session nobody may see.
  const hidden = "/home/krane/.claude-mem/observer-sessions";
  const seen = [];
  const poller = createRosterPoller({
    list: scripted(
      rosterOf(session({ sessionId: "a-0000000-0000-0000-0000-000000000000", cwd: JARVIS })),
      rosterOf(
        session({ sessionId: "a-0000000-0000-0000-0000-000000000000", cwd: JARVIS }),
        session({ sessionId: "b-0000000-0000-0000-0000-000000000000", cwd: hidden }),
      ),
    ),
    filter: (roster) => visibleSessions(roster, { roots: [JARVIS] }),
    maxAgeMs: 0,
    onEvents: (events) => seen.push(...events),
  });
  return (async () => {
    await poller.read();
    await poller.read();
    poller.stop();
    assert.deepEqual(seen, []);
    assert.equal(poller.current().length, 1);
  })();
});

test("a filter that throws reads as a failed listing, never as an empty machine", () => {
  // Empty would mean every live session just ended, which is a pile of false
  // completion reports and a dropped queue.
  const seen = [];
  const poller = createRosterPoller({
    list: scripted(rosterOf(session({ cwd: JARVIS }))),
    filter: () => { throw new Error("store unreadable"); },
    maxAgeMs: 0,
    onEvents: (events) => seen.push(...events),
  });
  return (async () => {
    await poller.read();
    await poller.read();
    poller.stop();
    assert.deepEqual(seen, []);
    assert.equal(poller.current(), null);
  })();
});

// ---------------------------------------------------------------------------
// ownRunning
// ---------------------------------------------------------------------------

const MINE = "1111aaaa-0000-0000-0000-000000000000";
const YOURS = "2222bbbb-0000-0000-0000-000000000000";

test("a background job Dante did not start does not fill the ceiling", () => {
  // The bug this function exists for. Four background sessions were live, none
  // of them Dante's, and every start was refused at four of five.
  const roster = rosterOf(
    session({ sessionId: YOURS, kind: "background", name: "roadmap-expansion" }),
    session({ sessionId: "3333cccc-0000-0000-0000-000000000000", kind: "background", name: "Empty Environment" }),
  );
  assert.deepEqual(ownRunning(roster, {}), { running: 0, oldestIdle: null });
});

test("only the sessions the store recorded starting are counted", () => {
  const roster = rosterOf(
    session({ sessionId: MINE, name: "jarvis-1-fix" }),
    session({ sessionId: YOURS, name: "some terminal" }),
  );
  assert.equal(ownRunning(roster, { [MINE]: { name: "jarvis-1-fix" } }).running, 1);
});

test("a session Dante started that has since died does not count either", () => {
  // The store keeps the last twenty, live or not; the roster is what says which
  // of them still exist.
  const roster = rosterOf(session({ sessionId: MINE, name: "jarvis-1-fix" }));
  const remembered = { [MINE]: {}, [YOURS]: {}, "4444dddd-0000-0000-0000-000000000000": {} };
  assert.equal(ownRunning(roster, remembered).running, 1);
});

test("the oldest idle one of Dante's own is the one worth naming", () => {
  const roster = rosterOf(
    session({ sessionId: MINE, name: "jarvis-1-old", startedAt: 1000, state: "done", status: "idle" }),
    session({ sessionId: YOURS, name: "jarvis-2-newer", startedAt: 9000, state: "done", status: "idle" }),
  );
  const remembered = { [MINE]: {}, [YOURS]: {} };
  assert.equal(ownRunning(roster, remembered).oldestIdle, "jarvis-1-old");
});

test("a working session is never offered as the one to stop", () => {
  // Including a blocked one: it is waiting on a person, not finished.
  const roster = rosterOf(
    session({ sessionId: MINE, name: "jarvis-1-busy", state: "working" }),
    session({ sessionId: YOURS, name: "jarvis-2-blocked", state: "blocked" }),
  );
  const remembered = { [MINE]: {}, [YOURS]: {} };
  assert.deepEqual(ownRunning(roster, remembered), { running: 2, oldestIdle: null });
});

test("a session with no start time sorts last rather than first", () => {
  // An unknown age is not evidence of being the stalest one.
  const roster = rosterOf(
    session({ sessionId: MINE, name: "jarvis-1-unknown", startedAt: null, state: "done", status: "idle" }),
    session({ sessionId: YOURS, name: "jarvis-2-known", startedAt: 5000, state: "done", status: "idle" }),
  );
  assert.equal(ownRunning(roster, { [MINE]: {}, [YOURS]: {} }).oldestIdle, "jarvis-2-known");
});

test("a store key that is not a session id cannot inflate the count", () => {
  // The store is JSON off disk. `in` would report every session as Dante's own
  // for a store carrying a key called "constructor".
  const roster = rosterOf(session({ sessionId: MINE, name: "jarvis-1-fix" }));
  assert.equal(ownRunning(roster, { constructor: {}, __proto__: {} }).running, 0);
});

test("nothing to count is not an error", () => {
  assert.deepEqual(ownRunning(null, {}), { running: 0, oldestIdle: null });
  assert.deepEqual(ownRunning([], null), { running: 0, oldestIdle: null });
  assert.deepEqual(ownRunning(rosterOf(session()), "not a store"), { running: 0, oldestIdle: null });
});

// Remembering a session under the roster's own sessionId -- not the
// provisional uuid --bg ignores -- is the whole point of resolveStartedSession
// in lib/spawn-session.js; this is what makes that worth doing.
test("a session remembered under the roster's real id is counted, not the discarded provisional one", () => {
  const roster = rosterOf(session({ sessionId: MINE, name: "jarvis-1-fix" }));
  const discarded = "9999ffff-0000-0000-0000-000000000000";
  assert.equal(ownRunning(roster, { [discarded]: { name: "jarvis-1-fix" } }).running, 0);
  assert.equal(ownRunning(roster, { [MINE]: { name: "jarvis-1-fix" } }).running, 1);
});

// ---------------------------------------------------------------------------
// matchStarted
// ---------------------------------------------------------------------------

test("a matching id wins outright, name and all", () => {
  const roster = rosterOf(
    session({ sessionId: MINE, id: "abcd1234", name: "dante-probe-1" }),
    session({ sessionId: YOURS, id: "eeee5555", name: "some-other-session" }),
  );
  const found = matchStarted(roster, { shortId: "eeee5555", name: "dante-probe-1" });
  assert.equal(found.sessionId, YOURS);
});

test("an id that matches nothing falls back to the name", () => {
  const roster = rosterOf(session({ sessionId: MINE, id: "abcd1234", name: "dante-probe-1" }));
  const found = matchStarted(roster, { shortId: "zzzzzzzz", name: "dante-probe-1" });
  assert.equal(found.sessionId, MINE);
});

test("no id at all still resolves by name", () => {
  const roster = rosterOf(session({ sessionId: MINE, id: "abcd1234", name: "dante-probe-1" }));
  const found = matchStarted(roster, { shortId: null, name: "dante-probe-1" });
  assert.equal(found.sessionId, MINE);
});

test("a name collision is settled by which record is newest", () => {
  // A name is only unique among sessions alive right now -- buildName in
  // server.js reuses the name of one that has since ended -- so an older
  // record can share a label with the one just started.
  const roster = rosterOf(
    session({ sessionId: MINE, id: "abcd1234", name: "dante-probe-1", startedAt: 1000 }),
    session({ sessionId: YOURS, id: "eeee5555", name: "dante-probe-1", startedAt: 9000 }),
  );
  const found = matchStarted(roster, { shortId: null, name: "dante-probe-1" });
  assert.equal(found.sessionId, YOURS);
});

test("an interactive session never wins the name fallback", () => {
  // Only `claude --bg` sessions are ever what this is resolving for; an
  // interactive terminal happening to share the label is not a match.
  const roster = rosterOf(session({ sessionId: MINE, id: null, name: "dante-probe-1", kind: "interactive" }));
  assert.equal(matchStarted(roster, { shortId: null, name: "dante-probe-1" }), null);
});

test("nothing to go on at all is not a match", () => {
  const roster = rosterOf(session({ sessionId: MINE, name: "dante-probe-1" }));
  assert.equal(matchStarted(roster, {}), null);
  assert.equal(matchStarted(roster, { shortId: "", name: "" }), null);
  assert.equal(matchStarted(null, { shortId: "abcd1234", name: "dante-probe-1" }), null);
  assert.equal(matchStarted([], { shortId: "abcd1234", name: "dante-probe-1" }), null);
});

test("an older same-name record in another cwd is not the name-fallback match", () => {
  // A background session Dante cannot see — started somewhere else entirely
  // — must not become the remembered session just because it shares a slug.
  const roster = rosterOf(
    session({ sessionId: MINE, id: "abcd1234", name: "dante-probe-1", cwd: "/home/krane/development/other" }),
  );
  const found = matchStarted(roster, {
    shortId: null,
    name: "dante-probe-1",
    cwd: "/home/krane/development/jarvis",
    since: 500_000,
  });
  assert.equal(found, null);
});

test("a same-name record started before since is not the name-fallback match", () => {
  const roster = rosterOf(
    session({ sessionId: MINE, id: "abcd1234", name: "dante-probe-1", startedAt: 1000 }),
  );
  const found = matchStarted(roster, {
    shortId: null,
    name: "dante-probe-1",
    cwd: "/home/krane/development/jarvis",
    since: 500_000,
  });
  assert.equal(found, null);
});

test("the right record still matches by name inside both bounds", () => {
  const roster = rosterOf(
    session({
      sessionId: MINE,
      id: "abcd1234",
      name: "dante-probe-1",
      cwd: "/home/krane/development/jarvis",
      startedAt: 500_500,
    }),
  );
  const found = matchStarted(roster, {
    shortId: null,
    name: "dante-probe-1",
    cwd: "/home/krane/development/jarvis",
    since: 500_000,
  });
  assert.equal(found.sessionId, MINE);
});

test("the since tolerance covers the small gap between this clock and the daemon's own", () => {
  // startedAt comes back on the daemon's own clock; two seconds earlier than
  // `since` is still close enough to be the very session waited on.
  const roster = rosterOf(
    session({
      sessionId: MINE,
      id: "abcd1234",
      name: "dante-probe-1",
      cwd: "/home/krane/development/jarvis",
      startedAt: 499_000,
    }),
  );
  const found = matchStarted(roster, {
    shortId: null,
    name: "dante-probe-1",
    cwd: "/home/krane/development/jarvis",
    since: 500_000,
  });
  assert.equal(found.sessionId, MINE);
});

// ---------------------------------------------------------------------------
// When a session finished: trackEnded, stampEnded, endedAtOf, and the poller
// ---------------------------------------------------------------------------

const DONE = { state: "done", status: "idle" };

test("done is the one terminal state, and an idle terminal is not it", () => {
  assert.equal(isDone(session(DONE)), true);
  assert.equal(isDone(session({ state: null, status: "idle" })), false);
  assert.equal(isDone(session({ state: "blocked" })), false);
  assert.equal(isDone(null), false);
  assert.equal(isDone("done"), false);
});

test("a session first seen done takes that tick's clock, and a live one is not tracked", () => {
  const ended = trackEnded(null, rosterOf(session(DONE), session({ sessionId: "live" })), 5_000);
  assert.deepEqual([...ended], [[session().sessionId, 5_000]]);
});

test("the time is carried forward unchanged on every later tick, so a done clock never moves", () => {
  const first = trackEnded(new Map(), rosterOf(session(DONE)), 5_000);
  const second = trackEnded(first, rosterOf(session(DONE)), 65_000);
  const third = trackEnded(second, rosterOf(session(DONE)), 125_000);
  assert.equal(third.get(session().sessionId), 5_000);
});

test("a done session that is picked up again is dropped, and finishing again takes a fresh time", () => {
  const done = trackEnded(null, rosterOf(session(DONE)), 5_000);
  const resumed = trackEnded(done, rosterOf(session({ state: "working" })), 10_000);
  assert.equal(resumed.size, 0);
  const again = trackEnded(resumed, rosterOf(session(DONE)), 20_000);
  assert.equal(again.get(session().sessionId), 20_000);
});

test("a session that leaves the listing is forgotten, so a reused id cannot inherit its finish time", () => {
  const done = trackEnded(null, rosterOf(session(DONE)), 5_000);
  assert.equal(trackEnded(done, rosterOf(), 10_000).size, 0);
  assert.equal(trackEnded(done, null, 10_000).size, 0);
});

test("a time handed in ahead of the listing is kept iff the listing agrees the session is done", () => {
  // A Stop hook lands before the tick; a seed from the memory store lands
  // before the first tick. Either is confirmed or discarded by the listing.
  const early = new Map([[session().sessionId, 4_000], ["gone", 1]]);
  const confirmed = trackEnded(early, rosterOf(session(DONE)), 9_000);
  assert.deepEqual([...confirmed], [[session().sessionId, 4_000]]);
  const refused = trackEnded(early, rosterOf(session({ state: "working" })), 9_000);
  assert.equal(refused.size, 0);
});

test("the stamp lands on done records only, and a record without a time is handed back untouched", () => {
  const ended = new Map([[session().sessionId, 5_000]]);
  const [done, live, unknown] = stampEnded(
    rosterOf(session(DONE), session({ sessionId: "live" }), session({ ...DONE, sessionId: "unknown" })),
    ended,
  );
  assert.equal(done.endedAt, 5_000);
  assert.equal("endedAt" in live, false);
  assert.equal("endedAt" in unknown, false);
  assert.equal(stampEnded(null, ended), null);
  assert.deepEqual(stampEnded([null, "x"], ended), [null, "x"]);
});

test("a finish time is read off a record only when it is done, whichever caller asks", () => {
  assert.equal(endedAtOf({ ...session(DONE), endedAt: 5_000 }), 5_000);
  assert.equal(endedAtOf(session(DONE)), null);
  assert.equal(endedAtOf({ ...session({ state: "working" }), endedAt: 5_000 }), null);
  assert.equal(endedAtOf(null), null);
});

test("a hook-driven report reads the time straight off the poller, even on a tick the filter dropped the session", async () => {
  // A SessionEnd an hour after done must not report the hour, and must not
  // depend on the session being in current() at that instant.
  let time = 0;
  let hide = false;
  const list = scripted(rosterOf(session(DONE)));
  const poller = createRosterPoller({
    list,
    maxAgeMs: 0,
    now: () => time,
    filter: (roster) => (hide ? [] : roster),
  });
  const id = session().sessionId;
  assert.equal(poller.endedAt(id), null);
  time = 5_000;
  await poller.read();
  assert.equal(poller.endedAt(id), 5_000);
  hide = true;
  time = 10_000;
  await poller.read();
  assert.deepEqual(poller.current(), []);
  assert.equal(poller.endedAt(id), 5_000);
  assert.equal(poller.endedAt("not-on-the-roster"), null);
  assert.equal(poller.endedAt(null), null);
  poller.stop();
});

test("a finish time that moved on a session that stayed done is an event, so the panel is told", () => {
  const before = stampEnded(rosterOf(session(DONE)), new Map([[session().sessionId, 5_000]]));
  const moved = stampEnded(rosterOf(session(DONE)), new Map([[session().sessionId, 50_000]]));
  assert.deepEqual(diffRoster(before, moved).map((e) => e.kind), ["finished"]);
  // The same time again is not news, and neither is the first stamp on its
  // own: that tick already carries the idle (or started) event.
  assert.deepEqual(diffRoster(before, before), []);
  assert.deepEqual(diffRoster(rosterOf(session(DONE)), before), []);
});

test("how long a session took ends at the stamp when there is one and at now when there is not", () => {
  assert.equal(completedIn(1_000, 5_000, 999_000), 4_000);
  assert.equal(completedIn(1_000, null, 999_000), 998_000);
  assert.equal(completedIn(1_000, undefined, 999_000), 998_000);
  assert.equal(completedIn(null, 5_000, 999_000), undefined);
  assert.equal(completedIn(NaN, 5_000, 999_000), undefined);
});

test("the poller stamps a session the tick it is first seen done and keeps that stamp on every tick after", async () => {
  let time = 0;
  const list = scripted(rosterOf(session({ state: "working" })), rosterOf(session(DONE)));
  const poller = createRosterPoller({ list, maxAgeMs: 0, now: () => time });
  time = 1_000;
  await poller.read();
  assert.equal("endedAt" in poller.current()[0], false);
  time = 6_000;
  await poller.read();
  assert.equal(poller.current()[0].endedAt, 6_000);
  time = 66_000;
  await poller.read();
  assert.equal(poller.current()[0].endedAt, 6_000);
  poller.stop();
});

test("a session the filter hides for one tick comes back with the stamp it had", async () => {
  // The times are kept off the raw listing, not the filtered roster: a
  // listing that omitted a cwd for one tick drops the session from
  // visibleSessions and nothing else, and its clock must not move for it.
  let time = 0;
  let hide = false;
  const list = scripted(rosterOf(session(DONE)));
  const poller = createRosterPoller({
    list,
    maxAgeMs: 0,
    now: () => time,
    filter: (roster) => (hide ? [] : roster.map((record) => ({ ...record, number: 1 }))),
  });
  time = 3_000;
  await poller.read();
  assert.equal(poller.current()[0].endedAt, 3_000);
  hide = true;
  time = 8_000;
  await poller.read();
  assert.deepEqual(poller.current(), []);
  hide = false;
  time = 13_000;
  await poller.read();
  assert.equal(poller.current()[0].endedAt, 3_000);
  poller.stop();
});

test("a failed listing leaves the finish times where they were", async () => {
  let time = 0;
  const list = scripted(rosterOf(session(DONE)), null, rosterOf(session(DONE)));
  const poller = createRosterPoller({ list, maxAgeMs: 0, now: () => time });
  time = 3_000;
  await poller.read();
  time = 8_000;
  await poller.read();
  time = 13_000;
  await poller.read();
  assert.equal(poller.current()[0].endedAt, 3_000);
  poller.stop();
});

test("a time noted from outside wins over the tick's own, and the listing still has the last word", async () => {
  // A Stop hook beats the tick that would stamp the session, and a Stop for a
  // session that was done, resumed and finished again is the only thing that
  // can move a stamp the listing keeps reporting done.
  let time = 0;
  const list = scripted(rosterOf(session(DONE)), rosterOf(session(DONE)), rosterOf(session({ state: "working" })));
  const poller = createRosterPoller({ list, maxAgeMs: 0, now: () => time });
  const id = session().sessionId;
  assert.equal(poller.noteEnded(id, 2_000), 2_000);
  time = 5_000;
  await poller.read();
  assert.equal(poller.current()[0].endedAt, 2_000);
  const later = 2_000 + DEDUPE_MS;
  assert.equal(poller.noteEnded(id, later), later);
  time = later + 3_000;
  await poller.read();
  assert.equal(poller.current()[0].endedAt, later);
  time += 5_000;
  await poller.read();
  assert.equal("endedAt" in poller.current()[0], false);
  // Nothing to note is not an error.
  assert.equal(poller.noteEnded(null, 1), null);
  assert.equal(poller.noteEnded(id, NaN), null);
  poller.stop();
});

test("a Stop that arrives again inside the dedupe window is a retry, and does not move the time", async () => {
  // A hook can fire twice for one exit; the second is byte-for-byte the first,
  // and the only thing that tells it from a genuine second finish is the gap.
  const poller = createRosterPoller({ list: scripted(rosterOf(session(DONE))), maxAgeMs: 0 });
  const id = session().sessionId;
  assert.equal(poller.noteEnded(id, 2_000), 2_000);
  assert.equal(poller.noteEnded(id, 2_500), 2_000);
  assert.equal(poller.noteEnded(id, 2_000 + DEDUPE_MS - 1), 2_000);
  assert.equal(poller.endedAt(id), 2_000);
  poller.stop();
});

