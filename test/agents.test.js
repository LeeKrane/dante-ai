import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LIST_TIMEOUT_MS,
  MAX_ROSTER_AGE_MS,
  MAX_SPOKEN,
  POLL_MS,
  createRosterPoller,
  describeRoster,
  isWorking,
  matchSessions,
  diffRoster,
  listAgents,
  ownRunning,
  parseRoster,
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
