import test from "node:test";
import assert from "node:assert/strict";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { matchSessions } from "../lib/agents.js";
import { describeFinished, recallableSessions } from "../lib/recall.js";
import { slugForCwd } from "../lib/transcript.js";

const JARVIS = "/home/krane/development/jarvis";
const FITNESS = "/home/krane/development/KraneticFitness";
const ROOTS = [JARVIS, FITNESS];
const NOW = 1_700_000_000_000;

// Every test below is about which sessions are readable, not about the
// filesystem stat that decides readability -- that has its own tests further
// down. Routing through this keeps `exists: () => true` from having to be
// repeated at every call site that expects records back.
function recall(remembered, roster, opts = {}) {
  return recallableSessions(remembered, roster, { roots: ROOTS, now: NOW, exists: () => true, ...opts });
}

// The store's own record of what Dante started, as rememberSession writes it.
function remembered(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.sessionId, entry]));
}

function started(sessionId, patch = {}) {
  return { sessionId, name: "jarvis-1-fix-tests", cwd: JARVIS, task: "fix the tests", at: NOW - 60_000, ...patch };
}

// A roster record as parseRoster normalizes one.
function live(sessionId, patch = {}) {
  return { sessionId, name: "jarvis-1-fix-tests", cwd: JARVIS, startedAt: NOW - 60_000, state: "working", ...patch };
}

// ---------------------------------------------------------------------------
// recallableSessions
// ---------------------------------------------------------------------------

test("a session Dante started that is no longer running is readable, and known to be finished", () => {
  const list = recall(remembered([started("a-1")]), []);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "jarvis-1-fix-tests");
  assert.equal(list[0].cwd, JARVIS);
  assert.equal(list[0].task, "fix the tests");
  assert.equal(list[0].running, false);
});

test("a session that is still running is readable too, and known to be running", () => {
  // Half an hour into something is plenty of work to ask about, and the
  // transcript is on disk either way.
  const list = recall(remembered([started("a-1")]), [live("a-1")]);
  assert.equal(list.length, 1);
  assert.equal(list[0].running, true);
});

test("a listing that failed leaves the running state unknown rather than guessed", () => {
  // null is "I could not ask", and reading it as "nothing is running" would
  // report every session started today as finished.
  const list = recall(remembered([started("a-1")]), null);
  assert.equal(list[0].running, null);
});

test("a session in a repository nobody named is not readable", () => {
  // The whitelist is applied here and not only at start time: a repository
  // dropped from memory has to stop being readable, or "only the repositories
  // you named" is true of live sessions and quietly false of dead ones.
  const list = recall(remembered([started("a-1", { cwd: "/home/krane/secrets" })]), []);
  assert.deepEqual(list, []);
});

test("a repository whose name merely starts the same is not the same repository", () => {
  const list = recall(remembered([started("a-1", { cwd: "/home/krane/development/jarvis-notes" })]), []);
  assert.deepEqual(list, []);
});

test("a running session Dante did not start is readable when it is in a named repository", () => {
  // A terminal somebody opened themselves. It has a transcript and a name, and
  // "what has that one been doing" is the same question with the same answer.
  const list = recall({}, [live("b-2", { name: "roadmap-expansion" })]);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "roadmap-expansion");
  assert.equal(list[0].running, true);
  assert.equal(list[0].task, "");
});

test("the live record wins over the remembered one, because a session can be renamed", () => {
  const list = recall(
    remembered([started("a-1", { name: "old-name" })]),
    [live("a-1", { name: "new-name" })],
  );
  assert.equal(list.length, 1, "one session, not two");
  assert.equal(list[0].name, "new-name");
  // What only the store knows still comes from the store.
  assert.equal(list[0].task, "fix the tests");
});

test("a record with no timestamp is still readable, because the file is what decides", () => {
  const list = recall(remembered([started("a-1", { at: undefined })]), []);
  assert.equal(list.length, 1);
  assert.equal(list[0].at, null);
});

test("a session with no name cannot be asked for by name, so it is not offered", () => {
  const list = recall(remembered([started("a-1", { name: "" })]), []);
  assert.deepEqual(list, []);
});

test("the newest is first, and an undated one sorts last rather than first", () => {
  const list = recall(
    remembered([
      started("old", { at: NOW - 300_000, name: "jarvis-1" }),
      started("undated", { at: undefined, name: "jarvis-2" }),
      started("new", { at: NOW - 1000, name: "jarvis-3" }),
    ]),
    [],
  );
  assert.deepEqual(list.map((r) => r.sessionId), ["new", "old", "undated"]);
});

test("a session whose transcript is not on disk is not recallable, because a deleted session leaves nothing to answer for it", () => {
  // This is the whole point of the feature: the file on disk is the only
  // source, so once it is gone there is nothing cached anywhere to stand in
  // for it.
  const list = recall(remembered([started("a-1")]), [], { exists: () => false });
  assert.deepEqual(list, []);
});

test("the filesystem is not checked for a session the whitelist or the name rule already rejected", () => {
  // A stat per session per turn is the expensive check here, and it must not
  // run for a session that was already going to be dropped -- so an `exists`
  // that blows up proves it was never asked about that one.
  const calls = [];
  const exists = (cwd, sessionId) => {
    calls.push(sessionId);
    return true;
  };
  const list = recallableSessions(
    remembered([
      started("outside-whitelist", { cwd: "/home/krane/secrets" }),
      started("unnamed", { name: "" }),
      started("kept"),
    ]),
    [],
    { roots: ROOTS, now: NOW, exists },
  );
  assert.deepEqual(list.map((r) => r.sessionId), ["kept"]);
  assert.deepEqual(calls, ["kept"]);
});

test("a store that is not one, or has no workspaces to check against, offers nothing", () => {
  assert.deepEqual(recallableSessions(null, [], { roots: ROOTS }), []);
  assert.deepEqual(recallableSessions("nonsense", [], { roots: ROOTS }), []);
  assert.deepEqual(recallableSessions(remembered([started("a-1")]), [], {}), []);
  assert.deepEqual(recallableSessions(remembered([started("a-1")]), [], { roots: "not a list" }), []);
});

test("a key inherited from Object.prototype is not a session", () => {
  // The store is JSON off disk, so it is walked by its own keys.
  const list = recall({ constructor: started("x") }, []);
  assert.equal(list.length, 1, "an own key called constructor is data, not the prototype");
  assert.deepEqual(recall({ a: "not an object" }, []), []);
});

test("a spoken name finds a finished session through the roster's own matcher", () => {
  // The one cross-module assumption dispatchRead rests on: matchSessions was
  // written against roster records, and these are not roster records. It matches
  // on `name` alone, so they resolve identically -- and if that ever stops being
  // true, "read jarvis three" silently finds nothing.
  const list = recall(
    remembered([
      started("a-1", { name: "jarvis-3-fix-failing-builder-test" }),
      started("a-2", { name: "jarvis-4-review", at: NOW - 120_000 }),
    ]),
    [],
  );
  // A prefix, an exact name whatever its punctuation, and the repo-prefixed form
  // describeFinished reads out for a hand-started session.
  assert.deepEqual(matchSessions(list, "jarvis-3").map((r) => r.sessionId), ["a-1"]);
  assert.deepEqual(matchSessions(list, "JARVIS 4 Review").map((r) => r.sessionId), ["a-2"]);
  assert.deepEqual(matchSessions(list, "nothing-like-it"), []);
});

test("deleting a session's transcript stops it being readable, against a real directory", () => {
  // Every other test here injects `exists`, which proves the filter runs but
  // not that it is wired to the filesystem the session actually writes to. This
  // one goes through slugForCwd, transcriptPath and a real statSync, so the
  // promise the whole feature rests on -- delete a session and it is gone, with
  // nothing left anywhere to answer for it -- is checked rather than assumed.
  const home = mkdtempSync(join(tmpdir(), "jarvis-recall-home-"));
  try {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const store = remembered([started(id, { cwd: JARVIS })]);
    const dir = join(home, ".claude", "projects", slugForCwd(JARVIS));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);

    // A session that started but has not spoken yet: the file exists and is
    // empty, and there is nothing to read back.
    writeFileSync(path, "");
    assert.deepEqual(recallableSessions(store, [], { roots: ROOTS, now: NOW, home }), []);

    writeFileSync(path, JSON.stringify({ type: "assistant" }) + "\n");
    assert.deepEqual(
      recallableSessions(store, [], { roots: ROOTS, now: NOW, home }).map((r) => r.sessionId),
      [id],
    );

    rmSync(path);
    assert.deepEqual(recallableSessions(store, [], { roots: ROOTS, now: NOW, home }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// describeFinished
// ---------------------------------------------------------------------------

test("only the finished sessions get the line, because the running ones already have one", () => {
  const records = recall(
    remembered([started("a-1", { name: "jarvis-1-fix-tests" }), started("a-2", { name: "jarvis-2-review" })]),
    [live("a-2", { name: "jarvis-2-review" })],
  );
  const line = describeFinished(records, { jarvis: JARVIS }, NOW);
  assert.match(line, /jarvis-1-fix-tests/);
  assert.doesNotMatch(line, /jarvis-2-review/);
});

test("nothing finished is no line at all, rather than a line saying nothing finished", () => {
  assert.equal(describeFinished([], {}, NOW), "");
  assert.equal(describeFinished(null, {}, NOW), "");
  assert.equal(describeFinished([{ name: "x", running: true }], {}, NOW), "");
});

test("how long ago it finished is said in words a person would use", () => {
  const at = (ms) => [{ name: "jarvis-1", cwd: JARVIS, running: false, at: NOW - ms }];
  assert.match(describeFinished(at(30_000), {}, NOW), /just now/);
  assert.match(describeFinished(at(60_000), {}, NOW), /a minute ago/);
  assert.match(describeFinished(at(20 * 60_000), {}, NOW), /20 minutes ago/);
  assert.match(describeFinished(at(62 * 60_000), {}, NOW), /an hour ago/);
  assert.match(describeFinished(at(5 * 60 * 60_000), {}, NOW), /5 hours ago/);
  // A clock that went backwards says nothing rather than "in -3 minutes": the
  // name still reaches the model, which is what the line is for.
  assert.equal(describeFinished(at(-60_000), {}, NOW), "Finished, still readable: jarvis-1");
});

test("a session named after its own repository is not named twice", () => {
  const records = [{ name: "jarvis-1-fix-tests", cwd: JARVIS, running: false, at: NOW - 1000 }];
  assert.doesNotMatch(describeFinished(records, { jarvis: JARVIS }, NOW), /jarvis: jarvis-1/);
});

test("a session named by hand carries the repository in front of it", () => {
  const records = [{ name: "roadmap-expansion", cwd: FITNESS, running: false, at: NOW - 1000 }];
  assert.match(describeFinished(records, { fitness: FITNESS }, NOW), /fitness: roadmap-expansion/);
});

test("a finished session run from a worktree is named by the workspace's alias, not the worktree's own basename", () => {
  // Dante's own sessions call EnterWorktree and move under
  // .claude/worktrees/<name>; a finished one read back with the directory's
  // own basename instead of the workspace alias is the same bug label() in
  // lib/agents.js had for the live roster.
  const records = [{
    name: "jarvis-10-add-persistent-whitelist-main",
    cwd: `${JARVIS}/.claude/worktrees/repo-persistence`,
    running: false,
    at: NOW - 1000,
  }];
  const line = describeFinished(records, { jarvis: JARVIS }, NOW);
  assert.match(line, /jarvis-10-add-persistent-whitelist-main/);
  assert.doesNotMatch(line, /repo-persistence:/);
});

test("a long list is cut, and says how many it left out", () => {
  const records = Array.from({ length: 8 }, (_, i) => ({
    name: `jarvis-${i}`, cwd: JARVIS, running: false, at: NOW - 1000,
  }));
  const line = describeFinished(records, {}, NOW);
  assert.match(line, /and 3 more/);
  assert.doesNotMatch(line, /jarvis-5/);
});
