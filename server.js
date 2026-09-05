import dotenv from "dotenv";
// dotenv never overrides a variable already present in the real environment,
// so systemd `Environment=` lines and shell exports keep priority over `.env`
// -- this only fills in what the process wasn't already given. Called before
// any loader below reads process.env. The path is anchored to this file, not
// the working directory: the server can be started from anywhere, and the
// `.env` dotenv loads must be the same one lib/builder.js's deny rules keep
// builds away from. (fileURLToPath is usable here because ESM evaluates every
// import before this statement runs, wherever it sits in the file.)
dotenv.config({
  path: fileURLToPath(new URL(".env", import.meta.url)),
  quiet: true, // suppresses dotenv v17's startup banner
});
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { allowedHosts, allowedOrigins, bracketHost, loadFishConfig, loadSupabaseConfig, serverIdentity } from "./lib/config.js";
import { formatEvent, formatRecap, formatSpoken } from "./lib/notify.js";
import { createDeduper, isLoopback, parseHookEvent } from "./lib/hooks.js";
import { buildDecision, inApprovalScope, parseYesNo } from "./lib/approval.js";
import {
  clarify, describeIntent, findTarget, isAnswerable, needsConfirmation, readAnswer, readConfirmingAnswer, readTarget,
} from "./lib/confirm.js";
// `matches` is imported under a longer name because dispatchRead already has a
// local `matches` (a list of roster records), and a shadowed import is a bug
// waiting for the first person to use the wrong one.
import {
  FACETS, composeBrief, holdForReadBack, interviewBlock, isLive, markProceed, matches as matchesInterview, noteInterview, readBack,
  wantsToProceed, withdrawConfirming,
} from "./lib/interview.js";
import { readSession, summarizeSession } from "./lib/transcript.js";
import {
  GHOST_MS, WATCH_QUESTION, cancelTarget, createWatchers, describeFired, ghostRecords, pruneFired, refuseWatch,
  resumedAmong, unwatchVerdict, watchCoverage, watchEvent, watchSkip, watchVerdict,
} from "./lib/watch.js";
import { createPending, neverStale, normalizeKind } from "./lib/announcements.js";
import { recallableSessions } from "./lib/recall.js";
import {
  DEFAULT_DIR as NOTES_DIR, createNoteTracker, describeContradictions, foldNotes, listNotes,
  pruneNotes, recordDiscussion, sessionNoteSpec, topicIsLive, writeSection,
} from "./lib/notes.js";
import { COOKIE, clearCookie, createAuth, parseCookie } from "./lib/auth.js";
import { ask, askResilient, buildPersona, createBrainSession } from "./lib/brain.js";
import { createTurnGate, dropAnswered, mergeTurns } from "./lib/turns.js";
import {
  MAX_LISTED, completedIn, createRosterPoller, endedAtOf, idleAmong, isWorking, mentionedSessions, orderRoster,
  ownRunning, visibleSessions,
} from "./lib/agents.js";
import { speakStream } from "./lib/tts.js";
import { parseAction } from "./lib/action.js";
import { loadRegistry } from "./lib/registry.js";
import { loadSessionKinds, buildName } from "./lib/sessions.js";
import {
  MAX_SESSIONS, newSessionId, refuseStart, startSession, resolveStartedSession, stopSession, tellSession,
  createInFlight, daemonId,
} from "./lib/spawn-session.js";
import { planDelivery, sendToSession } from "./lib/peer.js";
import { loadCommands, vetCommand } from "./lib/commands.js";
import { describeFailure } from "./lib/outcome.js";
import { isListed, startVerdict, stopVerdict, tellVerdict } from "./lib/verdict.js";
import { run as runBuild } from "./lib/builder.js";
import {
  loadStore, saveStore, getProject, touchProject, recordArtifact, applyMemoryTag,
  addWorkspace, applyWorkspaceTag, workspacePaths, getWorkspace,
  setMainRepo, getMainRepo, resolveRepoAlias, resolveRepoRef, workspacesForClient,
  queueForSession, takeQueued, dropQueuesExcept, queuedSessionIds, rememberSession, getSessionRecord, getSessions,
  rememberEnded, endedSeeds,
  chainAfter, takeChain, dropChainsExcept, recordEvent, getEvents, clearEvents,
  applyNoteLimitsTag, getNoteLimits,
} from "./lib/memory.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const BUILDS = join(HERE, "builds"); // one folder per build, created by lib/builder.js
const BUILDS_URL = "/builds/";
const PORT = Number(process.env.PORT) || 3210;

// The bind address and the WireGuard IP are both env-driven (DANTE_HOST,
// DANTE_WG_IP -- see serverIdentity in lib/config.js), so the same code runs
// unmodified on a laptop, a machine meant to be reachable from the LAN, or a
// WireGuard node. HOST defaults to loopback; WG_IP defaults to "" (no
// WireGuard entries at all).
const { host: HOST, wgIp: WG_IP } = serverIdentity();

// Only these spellings of "this machine" are served, and only these are
// allowed to open the socket -- derived from HOST, WG_IP and PORT so moving
// the server, or turning WireGuard access on or off, does not quietly
// disable the checks below. See allowedHosts/allowedOrigins in
// lib/config.js for exactly what is and is not included and why.
const ALLOWED_HOSTS = allowedHosts({ host: HOST, wgIp: WG_IP, port: PORT });
const ALLOWED_ORIGINS = allowedOrigins({ host: HOST, wgIp: WG_IP, port: PORT });

const cfg = loadFishConfig(); // throws early if Fish key missing

// Same reasoning: a Supabase project that is not configured should stop the
// server here, naming what is missing, rather than turn into a login screen
// that cannot let anyone in. The SDK lives on this side only -- the browser is
// never given the anon key, and never sees the token, because the session is an
// HttpOnly cookie this server sets.
const supabaseCfg = loadSupabaseConfig();
const auth = createAuth({ url: supabaseCfg.url, anonKey: supabaseCfg.anonKey, secure: supabaseCfg.secure });

// Read once, at startup. A primitive is a file on disk, so re-reading the folder
// per request would let a half-saved edit break a live conversation. Loading it
// here also turns a typo in someone's brand-new primitive into a startup error
// naming the file, rather than a silence in the middle of a conversation.
const registry = await loadRegistry();

// Read once at startup for the same reason the registry is: a half-saved edit
// must not break a live conversation. An empty map is a working install --
// free-form (a task and no kind) is the ordinary path.
const sessionKinds = await loadSessionKinds();

// The slash commands the persona may send, discovered once here like the
// session kinds are, and again whenever the persona is rebuilt below -- a repo
// named mid-conversation brings its own .claude/skills with it.
let knownCommands = loadCommands({ repos: [] });

// Every "watch jarvis-1 and tell me when it's done" outstanding right now.
// Module scope, not per-conversation: a watcher has to outlive the tab that
// created it, the same reason the queue and the chain table in lib/memory.js
// do. Never persisted to disk -- watchers exist only in memory, and a
// restart having forgotten them is the correct behaviour, not a bug, since a
// process that just restarted has plainly stopped watching anything.
const watchers = createWatchers();

// One place that knows what Claude Code sessions are running. A turn reads it
// (usually from cache, so an ordinary turn costs no child process at all), and
// the ticks are what notice a session finishing while nobody is looking --
// which is what will make reporting work with the browser closed.
//
// Started below, after the store is loaded, because the events name sessions
// using the workspace aliases the store holds.
const rosterPoller = createRosterPoller({
  // Dante's business, and nothing else. `claude agents --json` lists every
  // session on this machine, including other tools' internals and Dante's own
  // children, and reading those out loud was the least of it -- being able to
  // stop one is a bug with a process on the end of it.
  //
  // Evaluated per tick rather than captured once, so naming a repository
  // mid-conversation widens it on the next tick with no restart.
  //
  // orderRoster is applied here, in the one place every consumer of the roster
  // shares -- onRoster, onEvents/broadcastRoster, current(), read() (the
  // say-handler's own snapshot, and proposeSession's maxAgeMs: 0 re-read),
  // fresh() (the roster a stop or a start is checked against afterwards) and
  // dispatchRead's recallable(roster) all see the same numbered records this
  // produces. A workspace or main-repo change is picked up on the next poll
  // tick, same as everything else that reads workspacePaths/workspacesForClient
  // here -- except a main change made through the panel or a [MEMORY:SET
  // main=...] tag, which renumbers right away (see renumberNow, below), since
  // that reorders orderRoster's own buckets and is exactly the kind of change
  // someone is looking at the panel to see happen.
  filter: (roster) => orderRoster(
    visibleSessions(roster, {
      roots: Object.values(workspacePaths(memoryStore)),
      hideIds: ownSessionIds(),
      hideRoots: [BUILDS],
    }),
    { aliases: workspacePaths(memoryStore), order: workspacesForClient(memoryStore).map((w) => w.alias) },
  ),

  // Drained on every tick a session is seen idle, not only the tick it
  // becomes idle, because a queue can gain an entry after that moment or
  // exist from before the process restarted, and both must be delivered with
  // no browser connected. This is the whole reason the poller runs whether or
  // not one is.
  onRoster: (roster) => {
    // Computed once and reused below: the same sessions a queued tell is
    // about to be delivered to are the ones a watch must leave its idle
    // branch untouched for this tick (see the comment on tick's `skip` in
    // lib/watch.js) -- a session about to go straight back to work is not
    // "stopped working" in the sense a watcher exists to report.
    const queuedIds = queuedSessionIds(memoryStore);
    const queuedIdle = idleAmong(roster, queuedIds);
    // watchSkip (lib/watch.js) owns the union this used to build by hand
    // here: idle sessions with a queued tell, plus `delivering`'s own
    // in-flight ids (createInFlight, lib/spawn-session.js) -- queued ids
    // alone only cover the tick the drain STARTS on, since deliverQueued's
    // call to takeQueued (lib/memory.js) deletes the queue entry
    // synchronously, so a session is no longer "queued" from the very next
    // tick even though tellSession can still be running against it for up to
    // TELL_TIMEOUT_MS.
    const skip = watchSkip(roster, queuedIds, delivering.ids());
    for (const record of queuedIdle) deliverQueued(record);
    // The finish times the poller stamped, written down so they survive a
    // restart (endedSeeds, below). Saved only when one is new or moved.
    if (rememberEnded(memoryStore, roster) > 0) saveStore(memoryStore);
    // Not awaited, same reason reportComplete below is not: a poller tick
    // must not be held open by a read-back call and the announcement behind
    // it. watchReported is marked synchronously, right here, before
    // reportWatch is even called -- running onRoster before onEvents within
    // one tick (see createRosterPoller above) is not enough on its own to
    // keep reportComplete from duplicating this, because the SessionEnd hook
    // calls reportComplete directly the instant a session exits, with no
    // roster tick involved at all; only a synchronous mark here can win that
    // race, and it must cover every change (idle and blocked too, not only
    // gone) since any of them can be followed, later, by the "gone" event
    // that eventually reaches reportComplete.
    //
    // A report is old news once the session is back at work: the next block
    // or finish is a fresh event and the generic line for it must be spoken
    // again, so the mark comes off here. Swept before the tick below, though
    // the order does not matter -- a watch fires only on a session that is
    // not working, which is exactly the one this sweep leaves alone.
    // recentlyFired is swept in the same breath, on the same ids, and for the
    // same reason: the session went back to work, so whatever dot or ghost
    // row that entry was drawing (rosterForClient/ghostRecords) is exactly as
    // stale as the generic report it stood beside.
    for (const sessionId of resumedAmong(watchReported, roster)) {
      watchReported.delete(sessionId);
      recentlyFired.delete(sessionId);
    }
    //
    // Still gated on a page being open: firing costs a real read-back
    // (readSession, then up to ~25 s of Haiku summarizing it via reportWatch
    // below) and nobody is waiting for the answer with no page connected.
    // reportWatch now writes its own recap entry before it ever reaches
    // announce(), so that read-back is never lost once it does happen --
    // this gate only decides WHEN it happens, not whether it survives. So
    // the watch stays live instead of firing into silence, and fires on the
    // first tick after a page connects, reading the session back then, as
    // fresh as it can be.
    // Pruned every tick, whether or not a page is open -- cheap, pure, and the
    // only thing that ever keeps this map from growing for the life of the
    // process (see pruneFired's own comment, lib/watch.js). `roster` is
    // passed through so a sessionId still listed is kept regardless of age --
    // only a fire whose session has actually left the roster ages out on the
    // ghostMs clock.
    recentlyFired = pruneFired(recentlyFired, roster, Date.now(), GHOST_MS);
    if (!voice) return;
    const fires = watchers.tick(roster, Date.now(), { skip });
    // fireWatch (below) owns the four things a firing does -- mark
    // watchReported, mark recentlyFired, kick off reportWatch, and broadcast
    // the roster -- so this loop and reportComplete's own pending-watch
    // branch can never drift on what "firing" means. A BLOCKED fire changes
    // nothing diffRoster (lib/agents.js) treats as worth an event on its own
    // -- isWorking() counts blocked as still working, so the session's state
    // looks unchanged to it, and onEvents never runs this tick -- which is
    // why fireWatch's own broadcast is what gives a page the "reported" dot
    // for a fire that just went out, not onEvents' unconditional one.
    for (const fired of fires) fireWatch(fired.watch, fired.change, fired.record, roster);
  },

  onEvents: (events, roster) => {
    for (const { kind, session } of events) {
      log(`session ${kind}: ${session.name ?? session.sessionId}`);
      // The report someone walked away for. Not awaited: a poller tick must
      // not be held open by a summarize call and the announcement behind it.
      if (kind === "gone") {
        reportComplete(session.sessionId, {
          cwd: session.cwd, name: session.name, startedAt: session.startedAt, endedAt: endedAtOf(session), roster,
        }).catch((e) => log("report failed:", e.message || e));
      }
    }
    // Whatever changed, the panel is now describing a machine that has moved on.
    broadcastRoster(roster);
    // A queue or a chain for a session that ended is a promise that can never
    // be kept, and leaving either behind means a reused id would inherit a
    // stranger's follow-up or successor.
    if (events.some((event) => event.kind === "gone")) {
      const live = roster.map((record) => record.sessionId);
      const dropped = dropQueuesExcept(memoryStore, live) + dropChainsExcept(memoryStore, live);
      if (dropped > 0) {
        saveStore(memoryStore);
        log(`dropped ${dropped} queue/chain entr${dropped === 1 ? "y" : "ies"} for sessions that ended`);
      }
    }
  },
});

// Guards deliverQueued against the race lib/spawn-session.js's createInFlight
// documents: `onRoster` re-checks every tick, and a drain can take up to
// TELL_TIMEOUT_MS, so a session must not be resumed twice at once.
const delivering = createInFlight();

// Hand a session everything that was said to it while it was busy, in the order
// it was said. Nothing here speaks: by the time a session goes idle the person
// who queued it may be gone, and Phase C is what will tell them. This is the
// delivery, not the report.
async function deliverQueued(record) {
  await delivering.run(record.sessionId, async () => {
    const waiting = takeQueued(memoryStore, record.sessionId);
    if (waiting.length === 0) return;
    saveStore(memoryStore);

    for (const text of waiting) {
      const result = await tellSession({ sessionId: record.sessionId, cwd: record.cwd, text });
      log(
        result.ok
          ? `delivered to ${record.name}: ${JSON.stringify(text)}`
          : `delivery to ${record.name} failed: ${result.error}`,
      );
      // One failure ends the run rather than pressing on: the rest were said in
      // an order that assumed this one landed.
      if (!result.ok) break;
    }
  });
}

// One exit, reported once, whichever mechanism noticed it.
//
// Both do. The roster poller is the floor -- it works for sessions started
// before Dante existed and needs nothing installed -- and the Stop and
// SessionEnd hooks are the fast path, firing the moment it happens. They are
// not alternatives, so the deduper is what keeps one exit from becoming two
// lines in the thread.
const reported = createDeduper();

// Sessions a watcher has fired for, and the change it fired on -- keyed by
// sessionId, not merely a set, so watchCoverage (lib/watch.js) can tell an
// idle or gone report (which it must not narrate again) apart from a blocked
// one (completion is still fresh news after that). reportComplete/
// reportAttention must not repeat the generic line about any entry here.
// Marked synchronously in onRoster the instant a watch fires -- for every
// change, not only "gone" -- because ordering within one roster tick
// (onRoster before onEvents, see the comment on createRosterPoller in
// lib/agents.js) is not enough by itself: the SessionEnd hook calls
// reportComplete directly, the moment a session exits, with no roster tick
// involved at all, so only a synchronous mark can be certain of winning that
// race. reportComplete marks it too, synchronously at its own top, for the
// one case onRoster cannot reach first: a watch still PENDING (never fired)
// when the session's process exits -- cancelled and fired as "gone" right
// there rather than left for a poller tick that may never come. reportComplete
// deletes its own entry, on every exit path, the instant it runs -- so a
// watch that fired "idle" keeps its entry here until the session actually
// leaves the roster and reportComplete's delete finally claims it, which is
// exactly the case (working -> done while still listed, then closed minutes
// later) this exists to cover. reportAttention only reads the map and never
// deletes from it -- the session has not ended, and reportComplete is what
// will consume the entry when it does.
const watchReported = new Map();

// Sessions a watcher has fired for, recently -- keyed by sessionId, each entry
// the little the sessions panel needs to draw a row (rowFromRecord's own
// fields: name, alias, startedAt) plus the moment it fired, so ghostRecords
// (lib/watch.js) can synthesise a "finished" row for a fixed window after a
// gone fire removes the session from the roster outright. Unlike
// watchReported this is not merely a fact to consult and forget: it is pruned
// on a schedule (pruneFired, in onRoster above) rather than deleted the
// instant its news is stale, because the row it feeds is meant to still be
// there, on the panel, for GHOST_MS after the fire -- not gone the moment
// reportComplete or the next tick notices the session is gone. Reassigned,
// not mutated in place, on every prune: pruneFired is a pure function, like
// everything else in lib/watch.js, and returns a new Map rather than editing
// the one it was handed.
let recentlyFired = new Map();

// fireWatch(watch, change, record, roster) -> the four things that happen the
// instant a watcher fires, wherever it fires from: onRoster's own tick loop,
// above, and reportComplete's pending-watch branch, below, for a watch still
// PENDING when the session's process exited. One function so the two callers
// can never drift on what "firing" means. watchReported is marked
// synchronously so reportComplete/reportAttention never repeat the generic
// line about this ending; recentlyFired is marked synchronously too, keyed
// beside it, and now carries the `change` it fired with -- rosterForClient
// reads that to decide whether the "reported" dot belongs on a still-listed
// record (blocked only; see rosterForClient's own comment) -- so ghostRecords
// (lib/watch.js) can still synthesise a "finished" row for GHOST_MS once a
// gone fire removes the session from the roster outright. reportWatch is not
// awaited, for the same reason a poller tick or the SessionEnd hook that
// called reportComplete must not be held open by a read-back call and the
// announcement behind it. broadcastRoster is skipped when `roster` is not an
// array -- the hook path can call this before any poller tick has ever run,
// and rosterForClient(null) would render an empty panel, worse than sending
// nothing.
function fireWatch(watch, change, record, roster) {
  watchReported.set(watch.sessionId, change);
  recentlyFired.set(watch.sessionId, {
    name: watch.name, alias: watch.alias, startedAt: watch.startedAt, firedAt: Date.now(), change,
  });
  reportWatch({ watch, change, record }).catch((e) => log("watch report failed:", e.message || e));
  if (Array.isArray(roster)) broadcastRoster(roster);
}

// A watcher fires at most once, and this is what "firing" means: read the
// session back the same way verb=read does -- that answer is the actual
// point of a watch, not merely noticing the session stopped -- record it in
// the recap log, and speak it. Not awaited by either caller (fireWatch,
// above, called from onRoster or from reportComplete below for a watch that
// was still pending when the session's process exited), for the same reason
// a poller tick must not be held open by a read-back call and the
// announcement behind it. watchReported is already marked for this sessionId
// by fireWatch before this function is even invoked -- not here, and not
// only for "gone" -- so that a reportComplete racing in from the SessionEnd
// hook, which can resolve before this function's own await does, still finds
// the mark in place.
async function reportWatch({ watch, change, record }) {
  let text, reason;
  try {
    ({ text, reason } = await readSession({
      cwd: watch.cwd, sessionId: watch.sessionId, task: watch.task, question: WATCH_QUESTION,
    }));
  } catch (err) {
    // readSession does not throw in practice -- it catches its own ask()
    // failure and returns { text: "", reason: "failed" } instead -- but the
    // two lookups it makes before that try (transcriptPath, tailMessages) are
    // not inside it, and a filesystem error there would otherwise propagate
    // straight out of this function. Caught here, not left to the .catch on
    // fireWatch's own call: that .catch only logs, and a watch has no OTHER
    // durable record of itself, so a read that throws would drop the ending
    // from the recap entirely -- the exact bug this branch exists to close.
    // Folded into the same reason/text shape readSession's own failures use,
    // so everything below this needs no branch of its own for it.
    log(`watch read-back failed (${change}) for ${watch.name ?? watch.sessionId}: ${err.message || err}`);
    text = "";
    reason = "failed";
  }
  const spoken = describeFired({
    name: watch.name, change, state: record?.state ?? record?.status, text, reason,
  });
  log(`watch fired (${change}): ${spoken}`);
  // Written to the recap log before announce() below, not after: a watch has
  // no OTHER durable record of itself, unlike the generic complete and
  // needs-attention lines, whose own recordEvent calls happen regardless of
  // whether anything is ever spoken. So this must land even when announce()
  // has nowhere to go at all -- not only when a page is merely offline for
  // the moment, which announce() itself now covers by storing a watch kind
  // regardless (see announce, below). Landing here too, on the failure path
  // above, is the whole point of that try/catch: a restart mid-await still
  // loses this the same way main's own reportComplete can lose its call to
  // summarizeSession, but a read that merely throws instead of hanging no
  // longer has to lose it as well.
  recordEvent(memoryStore, watchEvent({ name: watch.name, change, text, reason }));
  saveStore(memoryStore);
  if (!announce(spoken, { kind: `watch-${change}`, sessionId: watch.sessionId })) {
    log("watch report not spoken yet (page closed mid-read) -- it is in the recap and will be re-offered on reconnect");
  }
}

// Only sessions Dante started are reported. The roster sees every terminal on
// this machine, and recording every time somebody closes one would make the
// recap worthless within a day.
async function reportComplete(sessionId, context = {}) {
  // context.roster on the hook path (the /hook call above) is
  // rosterPoller.current() -- the previous tick's roster, taken before this
  // session actually left it. Filtered here, once, rather than separately at
  // each of the two places below that read it: fireWatch's own
  // broadcastRoster (in the pending-watch branch immediately below) needs the
  // roster to look like what is actually true right now -- this session is
  // gone -- or ghostRecords (lib/watch.js) would skip drawing a ghost row on
  // the strength of a stale entry that still lists it; dispatchChain's own
  // ownRunning count needs the same thing, or it counts the exited session
  // against MAX_SESSIONS and refuses a chain one slot early. A non-array
  // context.roster (current() can be null this early, no tick has ever run)
  // passes through unfiltered -- fireWatch already skips its broadcast for a
  // non-array roster, and dispatchChain's own `Array.isArray(roster) ? roster
  // : []` already treats one the same way.
  const roster = Array.isArray(context.roster)
    ? context.roster.filter((record) => record.sessionId !== sessionId)
    : context.roster;

  // A watch still PENDING for this session (registered, never fired) can
  // only ever end one way from here: the session just exited, so reading it
  // back now and firing "gone" is not a guess, it is the only thing tick()
  // would ever have found on its next pass. Cancelled and fired
  // synchronously, right here, rather than left to that next poller tick --
  // a tick only runs with a page open and dies outright on a restart, so
  // waiting for one can lose the ending altogether. fireWatch (above) is what
  // actually marks watchReported/recentlyFired, kicks off the not-awaited
  // read-back, and broadcasts -- this path runs with no accompanying roster
  // tick at all (the SessionEnd hook calls this function directly, see /hook
  // above), so nothing else is about to broadcast a roster that would carry
  // this ghost the way onEvents' own unconditional broadcastRoster does for
  // onRoster's fires.
  const pending = watchers.cancel(sessionId);
  if (pending) fireWatch(pending, "gone", null, roster);

  // Read after the cancel above, not before it: a watch that was pending a
  // moment ago is "gone" now, and watchCoverage (lib/watch.js) must see the
  // report that was just filed for it, not the pending state it replaced.
  const watchedChange = watchReported.get(sessionId) ?? null;
  // The delete runs unconditionally -- before the two early returns just
  // below it, and on every other exit path this function has -- so the map
  // can never grow for the life of the process.
  watchReported.delete(sessionId);
  const coverage = watchCoverage(watchedChange);

  const remembered = getSessionRecord(memoryStore, sessionId);
  if (!remembered) return;
  if (!reported.accept(`${sessionId}:complete`)) return;

  // Taken here, synchronously and before anything below awaits: the roster
  // poller calls dropChainsExcept for this same "gone" event right after
  // invoking this function (without awaiting it), and a chain still sitting in
  // the table when that runs would be deleted out from under the dispatch at
  // the end of this function.
  const chain = takeChain(memoryStore, sessionId);
  if (chain) saveStore(memoryStore);

  const startedAt = Number.isFinite(context.startedAt) ? context.startedAt : remembered.at;
  // The moment the session was seen done (trackEnded in lib/agents.js), when
  // there was one: a session can sit done for an hour before its process goes,
  // and "took an hour and four minutes" would be counting that hour. Without
  // one -- a Stop hook, or a session that went straight from working to gone --
  // now is as close as anything gets.
  const durationMs = completedIn(startedAt, context.endedAt);
  // Up to ~25 s of Haiku, and worth it: "done" without it is not news. Read
  // once and used twice -- the posted line and the spoken one say the same
  // thing about the same session, at different lengths.
  const summary = await summarizeSession({
    cwd: context.cwd || remembered.cwd,
    sessionId,
    task: remembered.task,
  });
  const line = formatEvent({
    kind: "complete",
    name: remembered.name ?? context.name,
    durationMs,
    summary,
    detail: remembered.stoppedAt ? "stopped from here" : "",
  });

  // Recorded with the same words the log line above got -- whichever of summary
  // or the "stopped from here" note formatEvent actually chose to say -- so the
  // console line and the recap can never disagree about what happened here.
  //
  // Skipped entirely when watchCoverage says a watcher's own entry already
  // covers idle or gone: reportWatch already wrote its OWN recap entry for
  // this exact ending (watchEvent, in lib/watch.js) -- including a watch that
  // was still pending a moment ago, cancelled and fired as "gone" at the top
  // of this function -- and a second "finished" entry here would have the
  // recap read the same ending back twice. A blocked change is different --
  // the watcher's entry says the session is STILL blocked, and this one
  // finishing afterwards is fresh news the recap has not carried yet, so it
  // is written regardless; the same is true when nothing fired at all.
  if (coverage.record) {
    recordEvent(memoryStore, {
      kind: "complete",
      name: remembered.name ?? context.name,
      detail: summary || (remembered.stoppedAt ? "stopped from here" : ""),
    });
    saveStore(memoryStore);
  }

  log(`session complete: ${line}`);
  // The spoken form is shorter and only reaches anyone if a page is open and
  // the floor comes free before it goes stale; the recap above already has the
  // full detail regardless.
  //
  // Skipped when watchCoverage says a watcher already spoke about this
  // session, or just did, at the top of this function -- decided
  // synchronously before anything above ever awaited. Two announcements
  // about one ending, seconds apart, is a machine reading a list.
  if (!coverage.spoken) {
    log(`watch already covers ${remembered.name ?? context.name} - skipping the generic line`);
  } else {
    announce(formatSpoken({
      kind: "complete",
      name: remembered.name ?? context.name,
      durationMs,
      summary,
    }), { kind: "other", sessionId });
  }

  await dispatchChain(sessionId, remembered, chain, roster);
}

// A session named a successor and this one just ended -- start it now, if it
// still should run at all.
//
// "On completion", deliberately, not "on success": a Claude Code session
// exposes no pass/fail verdict for this to condition on (see the comment on
// chainAfter in lib/memory.js). The one thing that does cancel a chain is
// Dante having stopped this session itself -- ending something on purpose is
// not the same as it finishing the work it was asked to do -- which is why
// `remembered.stoppedAt` is checked here rather than folded into "did it
// finish" upstream.
async function dispatchChain(sessionId, remembered, chain, roster) {
  if (!chain) return;
  if (remembered.stoppedAt) {
    log(`chain dropped: ${sessionId} was stopped from here`);
    return;
  }

  // The workspace is looked up fresh rather than assumed still there -- the
  // alias was real when the chain was recorded, but a person can remove a
  // workspace in the meantime, and guessing at a repository to run in is
  // exactly the mistake lib/confirm.js exists to prevent for a spoken start.
  const workspace = getWorkspace(memoryStore, chain.alias);
  if (!workspace) {
    log(`chain dropped: workspace ${JSON.stringify(chain.alias)} is no longer known`);
    // takeChain already consumed the record, so this branch is the chain's last
    // trace: without a recap entry the drop would be entirely silent, and the
    // "complete" announcement for the session that just ended would leave the
    // impression the successor started.
    recordEvent(memoryStore, {
      kind: "failed",
      name: chain.alias,
      detail: "could not start the next session: the workspace is no longer known",
    });
    saveStore(memoryStore);
    return;
  }

  // Same ceiling, same counting as a spoken start: only sessions Dante itself
  // started count against it, and a chained one is no exception.
  const live = Array.isArray(roster) ? roster : [];
  const own = ownRunning(live, getSessions(memoryStore));
  const refusal = refuseStart(
    { task: chain.task, repo: chain.alias },
    {
      workspace,
      workspaces: workspacePaths(memoryStore),
      running: own.running,
      max: MAX_SESSIONS,
      oldestIdle: own.oldestIdle ?? undefined,
    },
  );
  if (refusal) {
    log(`chain refused: ${refusal}`);
    // Same reasoning as the missing-workspace branch above: the chain record
    // is already gone, so the recap entry is the only place the refusal can
    // still reach the person who asked for the chain.
    recordEvent(memoryStore, {
      kind: "failed",
      name: chain.alias,
      detail: `could not start the next session: ${refusal}`,
    });
    saveStore(memoryStore);
    return;
  }

  const started = await beginSession({
    workspace, task: chain.task, kind: null, taken: live, then: null, depth: chain.depth + 1,
  });
  if (!started.ok) {
    // beginSession has already recorded its own "failed" event to the recap
    // log -- nothing further to report here.
    log(`chained session start failed name=${started.name} ${started.error}`);
    return;
  }

  log(`chain started: ${sessionId} -> ${started.name}`);
  // beginSession already recorded the session's own "started" event; this is
  // the voice half of the same announcement, for whoever still has a page open.
  announce(formatSpoken({ kind: "started", name: started.name }), { kind: "other", sessionId: started.sessionId });
}

// A session that is blocked on a person. The one thing polling can never see,
// which is most of why the hook bridge exists at all.
async function reportAttention(event) {
  const remembered = getSessionRecord(memoryStore, event.sessionId);
  if (!remembered) return;
  if (!reported.accept(`${event.sessionId}:needs-attention:${event.detail}`)) return;

  const line = formatEvent({ kind: "needs-attention", name: remembered.name, detail: event.detail });
  recordEvent(memoryStore, { kind: "needs-attention", name: remembered.name, detail: event.detail });
  saveStore(memoryStore);
  log(`session needs attention: ${line}`);
  // Skipped when a watcher is pending for this exact session -- it will
  // report the blocked state itself, with the actual read-back, the moment
  // the next roster tick sees it -- or has already reported it moments ago
  // (onRoster forgets that report the moment the session is seen working
  // again, so this never silences a later, unrelated block).
  // A needs-attention line and a watcher's "is blocked, sir" line about the
  // same session seconds apart is a machine reading a list. Not deleted from
  // watchReported here either way: the session has not ended, and
  // reportComplete is what will consume that entry when it does. The recap
  // recordEvent above still happens regardless -- a session stopped on a
  // person belongs in the log even when nothing is spoken about it.
  if (watchers.has(event.sessionId) || watchReported.has(event.sessionId)) {
    log(`watch covers ${remembered.name} - skipping the generic attention line`);
  } else {
    announce(
      formatSpoken({ kind: "needs-attention", name: remembered.name, detail: event.detail }),
      { kind: "other", sessionId: event.sessionId },
    );
  }
}

// The session ids of Dante's own Claude processes: the warm brain, and
// whatever a live tab is resumed against. Exact ids rather than names, because
// "never offer to stop my own brain" has to be impossible, not unlikely.
//
// Builds are not here -- they carry no id Dante assigned -- but they do run in
// BUILDS, which the filter excludes by path instead.
function ownSessionIds() {
  const ids = new Set(sessions.values());
  const remembered = getProject(memoryStore, PROJECT_KEY)?.sessionId;
  if (remembered) ids.add(remembered);
  return ids;
}

// ---------------------------------------------------------------------------
// Voice approval
// ---------------------------------------------------------------------------

// A generous window. The session is blocked while this runs, but it is blocked
// on a question that was asked out loud, and sixty seconds is what it takes to
// walk back into the room. When it expires nothing is decided: the session
// falls through to what it would have done anyway.
const APPROVAL_WINDOW_MS = 60_000;

// The newest connected page. One question at a time and it goes to whoever is
// actually there -- two tabs are not two people, and asking both would mean the
// first answer wins a race with the second.
let voice = null;
let pendingApproval = null;

// requestApproval(payload) -> the hook's decision, or {} for no decision.
//
// {} is the answer to almost everything, and it is never a denial. Denying for
// want of a listener would silently break every session started while you are
// away, which is precisely when you need them working.
async function requestApproval(payload = {}) {
  // Only sessions Dante started. The hook is installed globally, so it fires
  // for the terminal you are sitting at too -- and that terminal can ask you
  // itself, better, on the screen you are already looking at.
  const remembered = getSessionRecord(memoryStore, payload.session_id);
  if (!remembered) return {};

  const scope = inApprovalScope(payload.tool_name, payload.tool_input, payload.cwd || remembered.cwd);
  if (!scope) return {};

  const name = remembered.name ?? "A session";

  // Nobody to ask, or somebody already being asked. The recap log still hears
  // about it, because a session waiting on a person is the thing you most want
  // to know.
  if (!voice || pendingApproval) {
    log(`approval unanswerable: ${name} ${scope.spoken}`);
    reportAttention({ sessionId: payload.session_id, detail: scope.spoken })
      .catch((e) => log("attention report failed:", e.message || e));
    return {};
  }

  const send = voice;
  return new Promise((resolve) => {
    let timer = null;
    const finish = (decision) => {
      clearTimeout(timer);
      if (pendingApproval?.finish === finish) pendingApproval = null;
      resolve(decision);
    };
    timer = setTimeout(() => {
      log(`approval timed out: ${name}`);
      // Reported rather than dropped: it went unanswered, which is exactly the
      // sort of thing to find in the recap afterwards.
      reportAttention({ sessionId: payload.session_id, detail: scope.spoken })
        .catch((e) => log("attention report failed:", e.message || e));
      finish({});
    }, APPROVAL_WINDOW_MS);

    pendingApproval = { name, spoken: scope.spoken, finish, reasked: false };
    log(`approval asked: ${name} ${scope.spoken}`);
    say(send, `${name} ${scope.spoken}, sir. Allow?`).catch((e) => log("approval ask failed:", e.message || e));
  });
}

// The answer, straight off the transcript. It NEVER goes through the model:
// routing it through one would make a prompt-injected tool description able to
// argue for its own approval, and no system prompt reliably survives that.
//
// Returns true when the words were an answer to a pending question, which is
// what stops them from also being a new turn.
async function answerApproval(send, text) {
  if (!pendingApproval) return false;
  const answer = parseYesNo(text);

  // One re-ask, then it stops badgering. A sentence this cannot read costs a
  // question rather than a wrong `git push`.
  if (answer === "unclear" && !pendingApproval.reasked) {
    pendingApproval.reasked = true;
    log(`approval unclear: ${JSON.stringify(text)}`);
    await say(send, `Yes or no, sir. ${pendingApproval.name} ${pendingApproval.spoken}.`);
    return true;
  }

  const question = pendingApproval;
  pendingApproval = null;

  if (answer === "unclear") {
    question.finish({});
    await say(send, "I could not tell, sir. I have left it to the session.");
    return true;
  }

  log(`approval ${answer}: ${question.name}`);
  question.finish(buildDecision(answer, `${answer === "yes" ? "approved" : "denied"} by voice`));
  await say(send, answer === "yes" ? `Allowed, sir.` : `Denied, sir.`);
  return true;
}

// ---------------------------------------------------------------------------
// What is running, on screen
// ---------------------------------------------------------------------------

// The same roster the turn carries, sent to the page so the panel beside the
// orb can paint it. Only what a row needs -- no pid, no path, no session id
// beyond the one that keys the row -- because everything sent here is written
// by whoever started the session and lands in a browser.
//
// Sent when it changes rather than on a timer: a session's age changes every
// second and the page can count that itself.
// More than this is a wall of text beside an orb, and the panel caps itself
// again anyway. Cut here as well so the message stays small whatever a machine
// running twenty sessions does. MAX_LISTED, not a number of its own: the
// numbering below is only meaningful if the panel and the model are looking at
// the same cut of the same list.
function rosterForClient(roster) {
  if (!Array.isArray(roster)) return [];
  // The roster arrives already numbered (see the poller's own filter, above) --
  // over the FULL list, not the slice below, so a hidden sixteenth session
  // still has a number and "stop session sixteen" still resolves even though
  // the panel never draws that row.
  const mapped = roster.slice(0, MAX_LISTED).map((record) => {
    const fire = recentlyFired.get(record.sessionId);
    return {
      sessionId: record.sessionId,
      name: record.name,
      // The alias rather than the path: a repository is called "jarvis" out loud,
      // and a page has no business being told where it lives on disk.
      alias: typeof record.alias === "string" ? record.alias : "",
      number: record.number,
      state: record.state,
      status: record.status,
      startedAt: record.startedAt,
      // When it finished, for a done session, so the page can stop the clock at
      // that moment rather than counting on from startedAt (see trackEnded in
      // lib/agents.js). null for a live one: its age is counted on the page.
      endedAt: endedAtOf(record),
      // Whether a watch is still live for this session, and the last time a
      // watch fired for it -- read straight off this module's own registries
      // rather than anything the poller's diffing produces, because neither is
      // a fact about the roster itself. Only a BLOCKED fire lights this: it is
      // the one change that leaves the session on the roster while still
      // needing attention, so it is the one change worth an amber "reported"
      // dot on a still-listed record here. An idle or gone fire also leaves an
      // entry in recentlyFired (fireWatch sets one for every change), but idle
      // needs no further attention and gone has already left the roster
      // outright (its row comes from the ghost row below instead) -- lighting
      // the dot for either would tell someone a session is still waiting on
      // them when it is not.
      watched: watchers.has(record.sessionId),
      firedAt: fire?.change === "blocked" ? fire.firedAt : null,
    };
  });
  // Appended after the MAX_LISTED slice above, never folded into it: this
  // function feeds only sendRoster/the sessions panel, never the model's own
  // view of the roster (recallable, dispatchRead's matching, mentionedSessions
  // and the rest all read the raw roster this function is handed, not its
  // return value) -- so a ghost row can never be recalled, numbered, or
  // matched by name the way a real session can.
  return mapped.concat(ghostRecords(recentlyFired, roster, Date.now(), GHOST_MS));
}

function sendRoster(send, roster) {
  send({ type: "roster", sessions: rosterForClient(roster) });
}

function broadcastRoster(roster) {
  for (const ws of sessions.keys()) {
    if (ws.readyState === 1) sendRoster((o) => ws.send(JSON.stringify(o)), roster);
  }
}

// The repositories a session can be started in, and which one is the default.
// Its own message rather than folded into "roster": the roster changes on
// every poll tick, this changes only when someone names a repository or picks
// a new main, and the panel groups by this list even when it has zero
// sessions running in it.
function sendWorkspaces(send) {
  send({ type: "workspaces", list: workspacesForClient(memoryStore) });
}

function broadcastWorkspaces() {
  for (const ws of sessions.keys()) {
    if (ws.readyState === 1) sendWorkspaces((o) => ws.send(JSON.stringify(o)));
  }
}

// A new main repository (or a newly named workspace) can move where a
// session's bucket sits in orderRoster's own canonical order -- main is
// always first -- and that is a change worth showing right away, not on
// whichever poll tick happens to land next. It is not, on its own, a change
// diffRoster would ever notice: no session started, stopped, or changed
// state, so the ordinary broadcastRoster call inside onEvents never fires for
// it. A fresh, unforced read (maxAgeMs: 0) recomputes the numbering against
// the memory store's new order and pushes that -- same re-read
// proposeSession's own "yes" path already relies on for the same reason.
function renumberNow() {
  rosterPoller.read({ maxAgeMs: 0 }).then(broadcastRoster).catch(() => {});
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

// Lines nobody asked for. The recap log always gets them and is the durable
// record; speaking one is the convenience, and a convenience does not get to
// interrupt.
//
// The timing decision is the browser's, because the floor is a client fact --
// only the page knows whether the mic is open or a clip is audible. So this
// offers the announcement, the page says when, and the text stays here until
// then rather than crossing the wire twice.
//
// Built on lib/announcements.js's createPending rather than a bare Map, for
// one reason: `retain` keeps a watcher's blocked report alive here no matter
// how long a page is busy, the same never-stale rule the client half of this
// (public/attention-policy.js's retainAnnouncement) applies to what is
// already in a page's own queue. Not one predicate shared by both -- public/
// cannot import from lib/, so this is two copies of the same rule, one per
// side, kept in step by hand and by the tests pinning each. neverStale here
// is that rule's server-side copy.
const pending = createPending({
  max: 10,
  ttlMs: 5 * 60 * 1000,
  retain: neverStale,
});

// announce(text, { kind, sessionId }) -> whether it was spoken right now.
//
// `kind` defaults to "other": every generic line this server spoke before
// watchers existed. For that kind, no page open is not a failure -- it
// already landed in the recap log, which is why nothing here needs to retry,
// and the entry is never even stored. A watch kind is different: it has no
// OTHER durable record of itself the way "other" does (reportWatch writes
// its own recap entry, but that is a *separate* write, not this one), so it
// is stored regardless of whether a page is open right now -- the connect
// handler re-offers everything still live the moment one reconnects (see
// `voice = send`, below). Returning early before ever storing it, the way
// this function used to for every kind, would make that re-offer dead code:
// there would never be anything left to re-offer.
function announce(text, { kind = "other", sessionId } = {}) {
  const line = typeof text === "string" ? text.trim() : "";
  if (!line) return false;
  // Run through normalizeKind (lib/announcements.js) so ANNOUNCE_KINDS is
  // actually enforced on the wire, not just documented and tested against a
  // set nothing here consulted: an unrecognized kind falls back to "other"
  // before it is checked or stored, rather than reaching the page as-is.
  const normalized = normalizeKind(kind);
  if (!voice && normalized === "other") return false;

  const offered = pending.offer(line, { kind: normalized, sessionId });
  if (!offered) return false;
  if (voice) voice({ type: "announce", id: offered.id, text: line, kind: normalized, sessionId });
  return Boolean(voice);
}

// The page has the floor free and is asking for one it was offered. Unknown or
// expired ids are ignored in silence: the page is entitled to ask late, and a
// dropped announcement is not worth a spoken apology.
async function speakAnnouncement(send, id) {
  const held = pending.take(id, Date.now());
  if (!held) return;
  log(`announced: ${held.text}`);
  await say(send, held.text);
}

// A recap ("what happened while I was out") just spoke every one of these out
// loud in one paragraph, so leaving any of them queued means saying it again
// the next time the floor is free -- worse than saying nothing. Both halves
// are cleared: this server's own pending store, and every connected page's own
// queue, which it holds client-side and does not otherwise hear about.
function clearPendingAnnouncements() {
  const cleared = pending.clear();
  for (const ws of sessions.keys()) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "clear_announcements" }));
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// Propose, then act
// ---------------------------------------------------------------------------

// Everything Dante can do to a live process used to run the moment a model
// wrote a tag. It showed: a request to start a session once ended with a
// different, working session stopped. So a tag becomes a proposal, and the next
// thing said decides it.
//
// propose(send, conv, intent, run) -> true when it was held for an answer.
//
// The spoken sentence comes from lib/confirm.js, built from the parsed tag --
// the model's own reply is dropped for any turn that carried one, so what is
// heard is always what will run. A tag nothing can describe is not held back:
// the dispatcher explains itself better than a confirmation nobody understands.
// That fall-through is what makes this the BUILD path only: a session tag goes
// through proposeSession below, which has no such fall-through, because the
// four verbs it covers reach a live process and must never run unconfirmed.
async function propose(send, conv, intent, run) {
  const spoken = describeIntent(intent);
  if (!spoken) return false;

  conv.proposal = { run, spoken, at: Date.now() };
  log(`proposed: ${spoken}`);
  await say(send, spoken);
  return true;
}

// findTarget's alias cross-check (lib/confirm.js) is only meaningful when
// repo= actually names a known workspace. It often does not: toSession copies
// every key onto every verb, so a tag as ordinary as
// `verb=stop number="3" repo="jarvis-1-fix-tests"` puts a session NAME in the
// repo field, not a repository -- and passing that through as `alias` would
// have findTarget refuse a perfectly good number with "Session three is in
// jarvis, not jarvis-1-fix-tests, sir." An unmatched letter is the same
// mistake from the other direction: "Z", which resolveRepoRef could not turn
// into an alias, must never be spoken back as "not Z, sir" as though Z named
// something. So the cross-check is only ever handed a value already proven to
// name a real workspace -- getWorkspace's own alias, not whatever session.repo
// happened to hold -- and undefined otherwise, which findTarget already
// treats as "nothing to check".
function repoCrossCheckAlias(repo) {
  const workspace = getWorkspace(memoryStore, repo);
  return workspace ? workspace.alias : undefined;
}

// The session equivalent of propose(), for the four verbs that always need a
// yes (see lib/confirm.js's CONFIRMED_VERBS). Unlike propose(), this never
// falls through to an unconfirmed dispatch: a tell, interrupt or stop that
// cannot be described is a missing detail, not a green light, so the missing
// detail is asked for instead.
async function proposeSession(send, conv, session, roster) {
  const verb = typeof session.verb === "string" ? session.verb.toLowerCase() : "";
  let target = null;
  if (verb === "tell" || verb === "interrupt" || verb === "stop" || verb === "watch") {
    // Resolved before it is ever proposed: a yes to a session that does not
    // exist is a false confirmation, and asking "shall I stop jarvis-1, sir?"
    // only to say "I cannot find jarvis-1 running" after the yes is worse than
    // saying so up front. The raw tag value is passed through rather than
    // pre-parsed: findTarget itself now tells a garbled number apart from no
    // number at all, and pre-parsing here would collapse that distinction
    // before it ever got there.
    const { record, refusal } = findTarget(roster, session.name ?? session.repo, {
      number: session.number, alias: repoCrossCheckAlias(session.repo),
    });
    // Every hop the name takes, on one line: what the tag actually carried,
    // what query that became, and what it resolved to or why it did not -- so
    // a truncated or mismatched name shows up here rather than only as a
    // refusal nobody can trace back to the tag that caused it. This is the
    // only place a refusal at this point is logged -- folded in here rather
    // than repeated below, which used to log the same refusal a second time
    // with none of the name or repo it was refused for.
    log(
      `${verb} target: tag name=${JSON.stringify(session.name ?? null)} repo=${JSON.stringify(session.repo ?? null)} number=${JSON.stringify(session.number ?? null)} -> ${
        record ? `resolved ${JSON.stringify(record.name)} (${record.sessionId})` : `refused: ${refusal}`
      }`,
    );
    if (refusal) {
      await say(send, refusal);
      // Nothing else resets the label after a proposal that never happened --
      // without this the page would keep reading "interviewing" or
      // "confirming" over a refusal about a session that does not exist.
      activity(send, null);
      return;
    }
    target = record;

    // A watch proposal gets a second check findTarget cannot make: a session
    // that is not working would never cross the working-to-anything-else
    // line a watcher fires on, and one already watched would just make the
    // same promise twice. Resolving before proposing is the same reasoning
    // as the block above; this is only the half of it that is specific to
    // watch.
    if (verb === "watch") {
      const watchRefusal = refuseWatch(target, watchers);
      if (watchRefusal) {
        await say(send, watchRefusal);
        return;
      }
    }
  }

  const spoken = describeIntent({ session, workspace: getWorkspace(memoryStore, session.repo), target });
  if (!spoken) {
    // These four never run unconfirmed. An undescribable tag here is a missing
    // detail (a tell with no task, a stop with nothing to name), and the fix is
    // to ask for the detail, never to dispatch and let the dispatcher explain.
    const question = clarify({ session, target });
    log(`session clarified rather than proposed: ${question}`);
    await say(send, question);
    // Same reasoning as the refusal above: a clarifying question about the
    // missing detail is not a proposal, and the page should not keep saying
    // "confirming" over it.
    activity(send, null);
    return;
  }

  conv.proposal = {
    // The resolved roster name is what the dispatcher looks up after the yes,
    // so it resolves exactly and, if the session has since gone, says so by
    // that same name rather than the one the model happened to write.
    run: async () =>
      dispatchSession(
        send,
        // The number is cleared here, deliberately: the roster re-read below
        // can have reshuffled between the proposal and this "yes" (something
        // else finished, freeing up a number), and resolving by number a
        // second time would then target whatever session that number belongs
        // to NOW, not the one just confirmed. sessionId is carried instead --
        // it identifies the exact process this was proposed for, findTarget
        // checks it before either a number or a name, and it stays correct
        // even across a rename or a reshuffle, unlike the name field this
        // used to rely on alone (a record with no name at all, `name: null`,
        // is a real roster shape and made that plan silently unresolvable).
        { ...session, ...(target ? { name: target.name, sessionId: target.sessionId } : {}), number: undefined },
        "",
        // Read again on the way in: the roster that produced the proposal is
        // however many seconds old the answer took to arrive, and a stop
        // resolves a name against a real process.
        await rosterPoller.read({ maxAgeMs: 0 }),
        conv,
      ),
    spoken,
    at: Date.now(),
  };
  activity(send, "proposing", { subject: target?.name ?? session.name ?? session.repo, brief: session.brief || undefined });
  log(`proposed: ${spoken}`);
  await say(send, spoken);
}

// The answer, if that is what this was. Returns true when the words were spent
// on the proposal, which is what stops them from also being a new turn.
async function answerProposal(send, conv, text) {
  const proposal = conv.proposal;
  if (!proposal) return false;

  // Expired proposals are not answerable at all -- not even by "no". Agreeing
  // ten minutes later is agreeing to something the person stopped thinking
  // about, and there is a real process on the end of it.
  if (!isAnswerable(proposal.at)) {
    conv.proposal = null;
    activity(send, null);
    log("proposal expired");
    return false;
  }

  const answer = readAnswer(text);
  // A correction is not an answer. The proposal is dropped and the sentence
  // goes on to be an ordinary turn -- the warm CLI still holds its own proposal
  // in context, so "no, the whole repo" re-proposes correctly by itself.
  if (answer === "amend") {
    conv.proposal = null;
    activity(send, null);
    log(`proposal amended: ${JSON.stringify(text)}`);
    return false;
  }

  conv.proposal = null;
  if (answer === "no") {
    // A declined proposal ends the interview that produced it: the picture it
    // was drawn from was just rejected, and resuming that interview later
    // would fold a fresh conversation's answers into a plan already declined.
    conv.interview = null;
    activity(send, null);
    log("proposal declined");
    await say(send, "Very good, sir. Leaving it.");
    return true;
  }

  log(`proposal accepted: ${proposal.spoken}`);
  try {
    await proposal.run();
  } catch (e) {
    // A yes that fails silently sounds, from the chair, exactly like a yes
    // that worked -- and the failure has already been swallowed once here, so
    // it has to be spoken before it is rethrown for whatever else reports it.
    if (!e.aborted) {
      log(`proposal run failed: ${e.message}`);
      await say(send, "That did not go through, sir.");
    }
    throw e;
  }
  return true;
}

// The answer to the read-back the machine spoke (the hold in the say
// handler, above), if that is what this was. Returns true when the words
// were spent on it.
//
// The proposal path has answerProposal and readAnswer so that a yes is read
// by code rather than by the model, and the machine's own read-back gets the
// same treatment for the same reason: a yes to "have I got that right?" has
// to lift the hold on exactly the tag that was read back, not on whatever
// the model recomposes from memory a turn later -- which, after a cold
// restart of the warm CLI, is all it would have. It reads readConfirmingAnswer
// rather than readAnswer, though: this is a longer question than "Shall I,
// sir?" and it is common to answer it at length ("yes, that's exactly
// right"), so the vocabulary here favours reading a long yes as a yes -- see
// readConfirmingAnswer's own comment for why misreading it the other way is
// the expensive direction. A yes runs nothing here: it consumes the
// interview into the held tag's brief and hands the tag to proposeSession,
// whose "Shall I, sir?" follows as it would have without the hold -- Krane
// can still decline that. A no is not a refusal to act, it is "you got it
// wrong", so confirming is withdrawn (back to interviewing, on the page) and
// the model is asked what it got wrong. A longer answer is the correction
// itself: the hold is dropped the same way, activity goes back to
// interviewing, and the sentence goes on to be an ordinary turn, so the
// model folds it in and either asks about what it left open or proposes
// again -- read back once more, the same way.
async function answerHeld(send, conv, text) {
  const held = conv.held;
  if (!held) return false;
  // The hold lives exactly as long as the interview it was folded into.
  if (!isLive(conv.interview)) {
    conv.held = null;
    log("held read-back expired");
    return false;
  }

  // The escape phrase said as the answer to the read-back is Krane overriding
  // it out loud, not answering it -- "stop asking" here means the same thing
  // it means anywhere else in the interview, and reading it as a no or a
  // correction would be the opposite of what he said.
  const escaped = wantsToProceed(text);
  const answer = escaped ? "yes" : readConfirmingAnswer(text);
  conv.held = null;
  if (answer !== "yes") {
    conv.interview = withdrawConfirming(conv.interview);
    activity(send, "interviewing", { subject: conv.interview.repo || undefined });
    log(`read-back ${answer === "no" ? "denied" : "corrected"}: ${JSON.stringify(text)}`);
    if (answer !== "no") return false;
    await say(send, "What did I get wrong, sir?");
    return true;
  }

  log(escaped ? "read-back confirmed by escape phrase" : `read-back confirmed: ${held.spoken}`);
  const session = {
    ...held.session,
    brief: composeBrief({
      task: held.session.task, brief: held.session.brief,
      notes: conv.interview.notes, said: conv.interview.said, repo: conv.interview.repo,
    }),
  };
  conv.interview = null;
  await proposeSession(send, conv, session, await rosterPoller.read({ maxAgeMs: 0 }));
  return true;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// The one place "notes pruned: a, b" gets built, so all four call sites --
// startup, a note-limit change, a session read, and a discussion appended to
// one -- say it identically instead of repeating the same guarded log line.
function logPruned(list, label = "notes pruned") {
  if (Array.isArray(list) && list.length > 0) log(`${label}: ${list.join(", ")}`);
}

// What earlier runs left behind. One server serves one project, so the whole
// store is keyed by the directory it was started in. Read once here; every
// write below goes through saveStore, which is atomic.
const memoryStore = loadStore();
const PROJECT_KEY = process.cwd();

// Notes prune themselves on every write during a normal run (see writeSection
// in lib/notes.js), but a limit lowered by hand in memory.json while the
// server was down has to take effect without waiting for the next note to be
// written, so cleanup also runs once here, against whatever limits the store
// holds right now.
{
  const bootPruned = pruneNotes(NOTES_DIR, getNoteLimits(memoryStore));
  const entries = listNotes(NOTES_DIR);
  const totalBytes = entries.reduce((sum, e) => sum + (Number.isFinite(e.bytes) ? e.bytes : 0), 0);
  log(`notes: ${entries.length} file(s), ${(totalBytes / 1024).toFixed(1)} KB in ${NOTES_DIR}`);
  logPruned(bootPruned, "notes pruned at startup");
}

// The directory the server was started in is a workspace by definition -- it is
// the repository the person is standing in -- so it is registered here rather
// than waiting to be named out loud. Idempotent: re-registering a path already
// known returns the existing alias unchanged, which is what stops a week of
// restarts producing jarvis, jarvis-2, jarvis-3.
const boot = addWorkspace(memoryStore, PROJECT_KEY);
let memoryChanged = Boolean(boot);

// A first run has no main yet, and a session has to be able to start without
// anyone having named a repository out loud first -- so the directory the
// server itself was started in becomes the default until a person picks a
// different one (a [MEMORY:SET main=...] tag, or the panel's set_main
// message, both further down), at which point that choice sticks across
// restarts instead of reverting to the cwd every time.
if (boot && getMainRepo(memoryStore) === null) {
  setMainRepo(memoryStore, boot.alias);
  memoryChanged = true;
}
if (memoryChanged) saveStore(memoryStore);

// The assistant can only ask for a build it has been told exists, so the persona
// is derived from the registry that was just loaded rather than written by hand.
// Without this the chat model runs on the no-builds default and politely refuses
// every build request, which looks like a broken model rather than a miswiring.
// It also carries what is remembered about this project, which is why it is a
// `let`: the prompt is rebuilt whenever memory changes. Without refreshPersona
// the whole memory feature would appear to work and only take effect after a
// restart, with nothing anywhere reporting why. Caveat: a --resume'd CLI session
// keeps the system prompt it started with, so a refreshed persona is guaranteed
// to reach the model on the next cold start rather than on the next turn.
knownCommands = loadCommands({ repos: Object.values(workspacePaths(memoryStore)) });
let persona = buildPersona(registry, getProject(memoryStore, PROJECT_KEY), sessionKinds, knownCommands);

function refreshPersona() {
  knownCommands = loadCommands({ repos: Object.values(workspacePaths(memoryStore)) });
  persona = buildPersona(registry, getProject(memoryStore, PROJECT_KEY), sessionKinds, knownCommands);
}

// One CLI for the whole server rather than a fresh one per sentence. Two thirds
// of what a turn used to cost was the process rather than the question: about
// 1080 ms to get a request out and about 550 ms to shut down with the answer
// already in hand. Measured through this server, three turns in a row: 1908 ms,
// then 739 ms, then 777 ms.
//
// Built lazily and let go whenever the last tab closes, which is both how the
// summary below gets the session to itself and how a refreshed persona ever
// reaches the model -- a running CLI keeps the system prompt it was spawned with,
// exactly as a --resume'd one does, so the caveat above is unchanged rather than
// made worse.
let brain = null;
function brainSession() {
  if (!brain) {
    brain = createBrainSession({
      persona,
      resume: getProject(memoryStore, PROJECT_KEY)?.sessionId || null,
    });
    log("brain session spawned");
  }
  return brain;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

// Serving files by path is where a static server gets broken into: "/../lib/x"
// and its percent-encoded twin both mean "read something above the folder I am
// allowed to read from". join() walks out of the root quite happily, so the
// resolved path is checked against the root before anything is opened. Returns
// null for anything that escapes, which the caller answers with 403.
function fileWithin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent escape
  }
  if (decoded.includes("\0")) return null; // fs throws on these rather than reporting them
  const full = resolve(join(root, decoded));
  return full === root || full.startsWith(root + sep) ? full : null;
}

// Listening on 127.0.0.1 keeps other machines out; it does not keep other NAMES
// out. Anyone can point a hostname they own at 127.0.0.1, and a page served from
// that name would then be talking to this server from inside the reader's own
// browser — reading public/ and builds/ across what the browser believes is a
// same-origin boundary. The Host header carries the name that was asked for, so
// checking it is what closes that door.
function hostAllowed(host) {
  return typeof host === "string" && ALLOWED_HOSTS.has(host.toLowerCase());
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

// The login screen has to be reachable by someone who is, by definition, not
// signed in, and it is the only thing that is. Everything else under public/ is
// the application, and everything under builds/ is what the application wrote —
// gating the orb but not its artifacts would leave every page the model
// produced readable by anyone who can reach the port.
const PUBLIC_PATHS = new Set(["/login.html"]);

function sessionToken(req) {
  return parseCookie(req.headers.cookie)[COOKIE] ?? "";
}

// A login body is one small JSON object. The cap is not a tuning knob: it is
// what stops a caller who has proved nothing from making this process hold an
// arbitrary amount of memory.
const MAX_BODY = 4096;

function readJsonBody(req) {
  return new Promise((done) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { chunks.length = 0; req.destroy(); done(null); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { done(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { done(null); } // not JSON, which signIn answers the same way as wrong credentials
    });
    req.on("error", () => done(null));
  });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host)) {
    log(`http refused host=${JSON.stringify(req.headers.host ?? null)}`);
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  const urlPath = (req.url ?? "/").split("?")[0];

  // The hook bridge. Loopback only, and that is its ENTIRE security model --
  // it does not change because the rest of this server is reachable over the
  // VPN. It sits above the cookie gate on purpose: the caller is a hook script
  // spawned by Claude Code, which has no browser session to present.
  //
  // Any local process can reach it, so nothing it carries may become an
  // instruction. A payload reaches lib/notify.js and the recap log, and never
  // a model prompt. Anything unexpected is dropped in silence rather than
  // answered with a complaint, because a complaint is a channel too.
  if (urlPath === "/hook") {
    if (!isLoopback(req.socket?.remoteAddress)) {
      log(`hook refused from ${req.socket?.remoteAddress ?? "unknown"}`);
      res.writeHead(403); res.end("forbidden"); return;
    }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end("method not allowed"); return; }
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      res.writeHead(415); res.end("unsupported media type"); return;
    }
    const declared = Number(req.headers["content-length"]);
    if (!Number.isFinite(declared) || declared > MAX_BODY) {
      res.writeHead(413); res.end("payload too large"); return;
    }

    const body = await readJsonBody(req);
    // Answered before anything is done with it. A hook blocks the session that
    // spawned it, and a summary can take twenty-five seconds; making a session
    // wait on Dante reporting about it would be exactly backwards.
    sendJson(res, 200, { ok: true });

    const event = parseHookEvent(body);
    if (!event) return;
    // No roster from a poller tick here -- this is the fast-path hook, firing
    // straight off the CLI's own Stop/SessionEnd event. rosterPoller.current()
    // is the best available answer to "what else is running" without paying
    // for a fresh listing on a path that already raced to answer the hook.
    // Stop fires at the moment the work ended, so that moment is the finish
    // time, and the poller is told (noteEnded says what it does with it).
    // SessionEnd fires when the process goes, which can be an hour later, so
    // it asks the poller for the time it already has; completedIn falls back
    // to now only when there is none.
    const endedAt = event.event === "Stop"
      ? rosterPoller.noteEnded(event.sessionId, Date.now())
      : rosterPoller.endedAt(event.sessionId);
    const work = event.kind === "complete"
      ? reportComplete(event.sessionId, { cwd: event.cwd, roster: rosterPoller.current(), endedAt })
      : reportAttention(event);
    work.catch((e) => log("hook report failed:", e.message || e));
    return;
  }

  // Voice approval. Loopback only, for the same reason and with the same rules
  // as /hook -- and unlike /hook this one HOLDS the response, because a
  // decision that arrives after the tool ran is not a decision.
  if (urlPath === "/approve") {
    if (!isLoopback(req.socket?.remoteAddress)) {
      log(`approve refused from ${req.socket?.remoteAddress ?? "unknown"}`);
      res.writeHead(403); res.end("forbidden"); return;
    }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end("method not allowed"); return; }
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      res.writeHead(415); res.end("unsupported media type"); return;
    }
    const declared = Number(req.headers["content-length"]);
    if (!Number.isFinite(declared) || declared > MAX_BODY) {
      res.writeHead(413); res.end("payload too large"); return;
    }

    const body = await readJsonBody(req);
    let decision = {};
    try { decision = await requestApproval(body ?? {}); }
    catch (e) { log("approval failed:", e.message || e); }
    // {} is a complete answer: no decision, session falls through.
    sendJson(res, 200, decision);
    return;
  }

  if (urlPath === "/auth/login") {
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end("method not allowed"); return; }
    const body = await readJsonBody(req);
    const result = await auth.signIn(body?.email, body?.password);
    if (!result.ok) {
      // The email is deliberately not logged. This line is written on a failed
      // attempt, which means it is written for whatever anyone types into the
      // form, and a log of guessed addresses is not worth keeping. The reason is
      // logged, because "getaddrinfo ENOTFOUND" and "Invalid login credentials"
      // are the same sentence in the browser and very different problems here.
      log(`login refused: ${result.reason}`);
      sendJson(res, 401, { error: result.error });
      return;
    }
    log("login accepted");
    sendJson(res, 200, { ok: true }, { "Set-Cookie": result.cookie });
    return;
  }

  if (urlPath === "/auth/logout") {
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end("method not allowed"); return; }
    auth.forget(sessionToken(req));
    sendJson(res, 200, { ok: true }, { "Set-Cookie": clearCookie(supabaseCfg.secure) });
    return;
  }

  if (!PUBLIC_PATHS.has(urlPath) && !(await auth.verify(sessionToken(req)))) {
    // A person who typed an address gets the login screen. Anything else — a
    // module the page imports, a build artifact — gets a status code, because
    // answering a script's request with an HTML page turns a plain
    // authentication failure into a confusing parse error instead.
    if (urlPath === "/" || urlPath === "/index.html") {
      res.writeHead(302, { Location: "/login.html", "Cache-Control": "no-store" });
      res.end();
    } else {
      res.writeHead(401, { "Cache-Control": "no-store" });
      res.end("unauthorized");
    }
    return;
  }

  // Two roots, one containment rule: the app's own files, and the read-only
  // artifacts a build wrote, so a finished page can be opened in the browser.
  const isBuild = urlPath.startsWith(BUILDS_URL);
  const root = isBuild ? BUILDS : PUBLIC;
  const rel = isBuild
    ? urlPath.slice(BUILDS_URL.length - 1) // keep the leading slash
    : urlPath === "/" ? "/index.html" : urlPath;

  const file = fileWithin(root, rel);
  if (!file) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const buf = await readFile(file);
    // Nothing here carries a version in its name and nothing sent a validator,
    // so a phone was free to heuristically cache app.js and go on running a
    // build of it from days ago — which is a miserable way to test a fix on a
    // device. The files are read off local disk per request; there is no
    // bandwidth here worth trading for that.
    const headers = {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    };
    if (isBuild) {
      // A built page is model-written HTML with model-written inline script,
      // served from the same origin as this app. `sandbox allow-scripts` drops
      // it into an opaque origin: the page still renders and its script still
      // runs, but it can no longer reach back into this origin to open the
      // control socket or read what another build wrote.
      headers["Content-Security-Policy"] = "sandbox allow-scripts";
    }
    res.writeHead(200, headers);
    res.end(buf);
  } catch { res.writeHead(404); res.end("not found"); }
});

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

// Every voice the assistant has goes through here, so a build question and a
// build result sound like the same character as a chat reply: caption first,
// then the audio the browser plays.
// `nextState` is where the orb should land once this clip finishes playing.
// Without it the client falls back to idle. It exists because a spoken line can
// hand off to a state rather than end a turn: the build confirmation is followed
// by the HUD, and sending `working` alongside the audio would race playback --
// the clip's own end would then fire idle and tear the HUD down mid-build.
// `stillCurrent` is how a chat reply survives being overtaken mid-breath. Fish
// starts sending after about 450 ms and a reply that exists is not a reply that
// has been heard: someone watching an amber orb cannot tell the difference
// between the model still thinking and the voice still being synthesized, so the
// same gesture -- pressing record -- lands on either side of a race they cannot
// see. Checked once, at the first byte, and the request is aborted rather than
// merely ignored, so an overtaken clip stops being synthesized. Returns whether
// it spoke. Omitted by every build line: those are deliberately not gated by the
// conversation, because a dispatched build has been paid for.
//
// After that first byte the clip is committed and streams to the end, because by
// then it is audible. Interrupting something you can hear is barge-in, and the
// browser already handles it: the next clip cuts this one off, and the id below
// is what keeps this one's remaining chunks out of it.
let clipSeq = 0;

async function say(send, text, nextState, stillCurrent) {
  send({ type: "reply_text", text });
  const t = Date.now();
  const id = ++clipSeq;
  const abort = new AbortController();
  let started = false;
  let dropped = false;
  let ms = 0;

  // Called at the first byte, and again after the stream ends in case there was
  // no first byte -- Fish does answer 200 with an empty body, and a clip that is
  // never announced is a `nextState` never honoured and an orb left in amber.
  const begin = () => {
    if (started || dropped) return started;
    ms = Date.now() - t;
    // The caption sent above is left standing on purpose. It is overwritten a
    // moment later by the person's own words as they are transcribed, and
    // blanking it here would clear whatever they had already said.
    if (stillCurrent && !stillCurrent()) {
      dropped = true;
      abort.abort();
      return false;
    }
    started = true;
    send({ type: "debug", stage: "tts", ms, msg: "fish first byte" });
    send({ type: "state", value: "speaking" });
    send({ type: "audio_start", id, format: cfg.format, pitch: cfg.pitch, nextState });
    return true;
  };

  let bytes = 0;
  try {
    bytes = await speakStream(text, cfg, (chunk) => {
      if (!begin()) return;
      send({ type: "audio_chunk", id, data: chunk.toString("base64") });
    }, { signal: abort.signal });
  } catch (e) {
    // The abort above surfaces here; everything else is a real Fish failure and
    // is reported as one. A clip already part-sent still has to be closed, or the
    // browser waits for bytes that are never coming with the orb stuck speaking.
    if (!dropped) {
      if (started) send({ type: "audio_end", id });
      throw e;
    }
  }

  begin();
  if (dropped) {
    log(`clip dropped after ${ms}ms: superseded while it was being synthesized`);
    send({ type: "debug", stage: "tts", ms, msg: "clip dropped, superseded" });
    return false;
  }
  log(`tts ok ${Date.now() - t}ms ${bytes}b first=${ms}ms`);
  send({ type: "debug", stage: "tts", ms, msg: `fish ${bytes} bytes` });
  send({ type: "audio_end", id });
  return true;
}

// What the page shows under the state label: a short gerund naming what Dante
// is doing right now, plus whatever names the thing it is doing it to. `value`
// is one of interviewing | confirming | proposing | starting | telling |
// interrupting | stopping | reading | building | null (null clears the
// label). interviewing is the model asking about an open facet; confirming
// is the machine reading the whole brief back for a yes -- a different phase
// with its own label, not a kind of interviewing. `subject` names the
// session, repo, or primitive involved. `brief` rides only alongside
// "proposing", because the spoken sentence only summarises the brief and the
// person is being asked to approve the full text, which the page can then show.
function activity(send, value, extra = {}) {
  send({ type: "activity", value, ...extra });
}

// Two things the assistant has to say in one breath sound like conversation;
// two separate clips with a synthesis gap between them sound like a machine
// reading a list. Used to fuse an acknowledgement onto the question that
// follows it.
function joinSpoken(...parts) {
  return parts.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean).join(" ");
}

// A primitive name arrives from the chat model, and an unknown one gets read
// aloud and written to the log. Keep it short and printable so a garbled tag
// cannot forge a log line or hand the voice a page of noise to pronounce.
const MAX_NAME = 40;
function readableName(text) {
  const clean = String(text).replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  return clean.slice(0, MAX_NAME);
}

// ---------------------------------------------------------------------------
// Build dispatch
// ---------------------------------------------------------------------------

// A build is a model with file-writing tools on, so the ceiling has to count
// every build on this machine rather than every build in one tab. Held at module
// scope for that reason: two open tabs are two sockets, and a per-socket guard
// would let each of them start one.
const MAX_BUILDS = 1;
let running = 0;

const slotFree = () => running < MAX_BUILDS;

// Check and claim in the same tick. Anything awaited between the two would let a
// second socket see the slot that a first one is already on its way to taking.
function claimSlot() {
  if (!slotFree()) return false;
  running++;
  return true;
}

function releaseSlot() {
  running = Math.max(0, running - 1);
}

const BUSY_LINE = "One build at a time, sir. Ask me again once this one lands.";

// "Unanswered" is generous on purpose. A tag can arrive as `subject=` with an
// empty value, and building a landing page about nothing is a worse outcome
// than one more spoken question.
function firstUnanswered(primitive, params) {
  return primitive.questions.find(
    (q) => typeof params[q.key] !== "string" || params[q.key].trim() === "",
  );
}

// Entry point from a chat turn that carried an action tag. `preamble` is what
// the model already said out loud about the request; it is fused onto whatever
// comes next so the turn is one utterance instead of two. The corrective paths
// below drop it deliberately -- an acknowledgement contradicts the correction.
// One session in the roster, or a sentence saying why not. Shared by tell and
// stop, because "which one did you mean" is the same question either way -- and
// because resolving a name to the wrong session is the same mistake either way,
// except that stop signals a real process.
//
// The matching and the wording of each refusal live in lib/confirm.js's
// findTarget, so they can be tested without a live roster; this is only the
// wiring that speaks the refusal when there is one. Takes the session itself,
// not a pre-built query, because addressing by number or by sessionId needs
// the tag's own `number`/`sessionId` keys alongside the name/repo query -- a
// caller building that query by hand would otherwise have to remember to pass
// those along too, and a forgotten one silently falls back to name matching.
// Both are passed raw, unparsed: findTarget itself now tells "no number was
// given" apart from "a number was given and it was garbled," and parsing here
// first would collapse that distinction before it ever got there.
async function resolveSession(send, roster, session, preamble) {
  const { record, refusal } = findTarget(roster, session.name ?? session.repo, {
    number: session.number,
    sessionId: session.sessionId,
    // Inert on this call whenever it matters least: resolveSession runs
    // after a "yes" with number left undefined and a sessionId already in
    // hand, and findTarget's own alias cross-check only fires on the number
    // path. Passed anyway so all three findTarget call sites stay uniform
    // rather than two of them remembering to pass it and one not.
    alias: repoCrossCheckAlias(session.repo),
  });
  if (refusal) {
    await say(send, joinSpoken(preamble, refusal));
    return null;
  }
  return record;
}

// Ask a session to stop, and confirm it did before saying so.
//
// "Confirm" means the roster, not the signal. stopSession polls the pid it
// signalled until it is gone, and that used to be the whole check -- until a
// stop was reported done on a session that was still on the roster two
// minutes later: its worker went away, the daemon handed the session to
// another one, and the pid check could not see that. So the roster is re-read
// after the signal, and what is said, and what is recorded, comes from that.
async function dispatchStop(send, session, preamble, roster) {
  const record = await resolveSession(send, roster, session, preamble);
  if (!record) return;

  activity(send, "stopping", { subject: record.name });
  try {
    send({ type: "state", value: "thinking" });
    const result = await stopSession(record);
    // fresh() rather than read({ maxAgeMs: 0 }): read() falls back to the last
    // roster when the listing fails, and that roster is from before the stop.
    const listed = result.ok ? isListed(await rosterPoller.fresh(), record.sessionId) : null;
    const verdict = stopVerdict({ name: record.name, result, listed });

    if (verdict.stopped) {
      // Anything still waiting for it can never be delivered now.
      takeQueued(memoryStore, record.sessionId);
      // A watch on it too: left in place it would fire "gone" on the next
      // tick, spend a read-back, and announce that the session finished --
      // seconds after Krane stopped it on purpose, and in words that say the
      // opposite of what happened.
      if (watchers.cancel(record.sessionId)) log(`no longer watching ${record.name}: stopped`);
      // Noted so the report when it leaves the roster says it was stopped rather
      // than that it finished -- which are different things to read at midnight.
      // Only for sessions Dante started: writing a record here for a terminal
      // somebody was sitting at would turn "Dante stopped it" into a recap entry
      // about a session the recap log has never heard of.
      if (getSessionRecord(memoryStore, record.sessionId)) {
        rememberSession(memoryStore, record.sessionId, { stoppedAt: Date.now() });
      }
      saveStore(memoryStore);
      log(`stopped ${record.name} via ${result.via}${result.alreadyGone ? " (already gone)" : ""}`);
    } else if (!result.ok) {
      log(`stop ${record.name} failed: ${result.error}`);
    } else {
      // Neither the queue nor stoppedAt is touched: the session may still
      // deliver the one and the recap must not claim the other.
      log(`stop ${record.name} sent but not confirmed: ${listed === null ? "roster unreadable" : "still listed"}`);
    }
    await say(send, joinSpoken(preamble, verdict.spoken));
  } finally {
    activity(send, null);
  }
}

// Pass something on to a session that is already running.
//
// lib/peer.js's sendToSession is tried first: of the three ways this codebase
// can reach another session, it is the only one that writes into the live
// session itself rather than around it -- no forked transcript (tellSession),
// no waiting for the session to go idle (queueForSession). "now"-priority
// delivery is also the only way `interrupt` means anything: it is what lets a
// steer land mid-turn instead of behind it. But the channel is undocumented
// by the CLI and not every version offers it, so the older queue-and-resume
// path stays underneath as the fallback for a session that has no peer
// address to answer to.
async function dispatchTell(send, session, preamble, roster, verb = "tell") {
  const record = await resolveSession(send, roster, session, preamble);
  if (!record) return;

  // The name resolved above is what this actually delivers to, not necessarily
  // what the tag said -- so the trail from spoken name to live process is
  // unbroken even when the two differ (a prefix match, a repo-qualified query).
  log(`${verb} delivering to ${JSON.stringify(record.name)} (${record.sessionId}, pid ${record.pid ?? "none"})`);

  activity(send, verb === "interrupt" ? "interrupting" : "telling", { subject: record.name });
  // A finally rather than an activity(send, null) before each return: this
  // function alone has eight early returns below, and a single missed one
  // would leave "telling jarvis-1" on screen for a session that was never
  // actually told.
  try {
    // A brief composed from an interview is what the session should hear --
    // the task is only its label. Written as `||` over `(task ?? text ??
    // message)` rather than a chain of `??`, so an empty-string brief (never
    // written) does not win over a real task the way `??` alone would let it.
    // A slash command outranks all of them: it was vetted and normalised
    // where the tag was read, and the line is the whole message -- a brief
    // after it would become the command's arguments, not the session's
    // instructions.
    const command = typeof session.command === "string" && session.command.startsWith("/") ? session.command : "";
    const text = command || session.brief || (session.task ?? session.text ?? session.message);
    // Checked before the busy branch: without this, a tag with no message at all
    // reports a full queue, which is a different problem with a different fix.
    if (typeof text !== "string" || text.trim() === "") {
      await say(send, joinSpoken(preamble, `What should I tell ${record.name}, sir?`));
      return;
    }

    const plan = planDelivery(verb, text);
    // Text that is non-empty but cleans to nothing (control characters, stray
    // whitespace) is the same problem the empty-text check above exists for, so
    // it gets the same question rather than a second branch that says the same
    // thing differently.
    if (!plan) {
      await say(send, joinSpoken(preamble, `What should I tell ${record.name}, sir?`));
      return;
    }

    send({ type: "state", value: "thinking" });
    // A slash command never takes the peer channel. Verified live against CLI
    // 2.1.257: a "/cost" frame written into a counting session's socket
    // reached its transcript as "Another Claude session sent a message:
    // /cost ..." -- the CLI wraps every peer frame in a sentence about where it
    // came from, and the session read the command as prose and answered that
    // it could not run it. The resume path below (`claude -p --resume ... --
    // "/cost"`) expands a built-in, a custom command and a skill (only the
    // last of which Dante ever sends), all three verified the same day, and
    // deliverQueued uses that same path, so a command queued behind a busy
    // session expands when its turn comes too.
    if (command) {
      log(`${verb} of ${command} to ${record.name} takes the resume path, not the peer channel`);
    } else {
      const delivered = await sendToSession({
        pid: record.pid,
        sessionId: record.sessionId,
        text: plan.content,
        priority: plan.priority,
      });
      if (delivered.ok) {
        log(`${verb} sent to ${record.name} over the peer channel`);
        // "Sent" is as far as this can honestly go: sendToSession resolving ok
        // means the frame reached the session's socket, not that the model has
        // read it, acted on it, or replied -- the CLI sends no acknowledgement
        // for a user frame at all. This used to say "has it", which is already
        // a claim about the far end; tellVerdict says what was done and that
        // the rest cannot be checked.
        await say(send, joinSpoken(preamble, tellVerdict({ name: record.name, verb, channel: "peer" })));
        return;
      }
      log(`peer send to ${record.name} failed: ${delivered.error}`);
    }

    // Fallback: no peer address for this session (older CLI, or the state file
    // this reads did not exist). The gate below is the whole reason this path
    // used to be the only one. Resuming a session that is CURRENTLY WORKING is
    // not a join: two processes on one session id is the race askResilient and
    // conv.settled exist to prevent inside Dante, and it is worse across
    // processes. So a busy session gets the message queued, and the roster
    // poller delivers it on the first tick that sees it idle.
    if (isWorking(record)) {
      const queued = queueForSession(memoryStore, record.sessionId, text);
      if (!queued) {
        await say(send, joinSpoken(preamble, `${record.name} already has as much waiting as I will hold, sir.`));
        return;
      }
      saveStore(memoryStore);
      log(`queued for ${record.name}: ${JSON.stringify(queued)}`);
      // Said plainly, because "queued" and "sent" are different promises and the
      // difference is minutes.
      await say(send, joinSpoken(preamble, tellVerdict({ name: record.name, verb, channel: "queued" })));
      return;
    }

    // No second "thinking" send here: the peer attempt above already sent one,
    // and by this point in the fallback that state is still current.
    const result = await tellSession({ sessionId: record.sessionId, cwd: record.cwd, text });
    if (!result.ok) {
      log(`tell ${record.name} failed: ${result.error}`);
      await say(send, joinSpoken(preamble, `${record.name} would not take that, sir. ${result.error}.`));
      return;
    }
    log(`told ${record.name}`);
    // The resumed session ran to completion, so its reply is the one delivery
    // here that is verified rather than merely sent.
    await say(send, joinSpoken(preamble, tellVerdict({ name: record.name, verb, channel: "resume", reply: result.reply })));
  } finally {
    activity(send, null);
  }
}

// Start watching a session someone just confirmed. resolveSession re-targets
// by sessionId (the proposal carried it -- see proposeSession), which is the
// exact process the "Shall I, sir?" was about; refuseWatch is checked again
// rather than trusted from the proposal, because the roster it resolved
// against is however many seconds old the "yes" took to arrive, and the
// session may have gone idle, gone altogether, or been watched by some other
// route in that window.
async function dispatchWatch(send, session, preamble, roster) {
  const record = await resolveSession(send, roster, session, preamble);
  if (!record) return;

  const refusal = refuseWatch(record, watchers);
  if (refusal) {
    await say(send, refusal);
    return;
  }

  watchers.add({
    sessionId: record.sessionId,
    name: record.name,
    cwd: record.cwd,
    // The brief a start or tell held for this session, if any -- readSession
    // (via reportWatch) folds it into the question it asks the transcript,
    // the same way dispatchRead already does for verb=read.
    task: getSessionRecord(memoryStore, record.sessionId)?.task ?? "",
    state: record.state,
    // Carried through so a later ghost row (ghostRecords, once this session
    // has left the roster) knows where it ran and how long -- see add()'s
    // own comment in lib/watch.js for why these two are held at all.
    alias: record.alias,
    startedAt: record.startedAt,
  });
  log(`watching ${record.name} (${record.sessionId})`);
  await say(send, joinSpoken(preamble, watchVerdict({ name: record.name })));
}

// Cancel a watch. Unlike dispatchWatch this never touches a live process --
// it only forgets a promise Dante made to itself -- which is why verb=unwatch
// needs no confirmation at all (see lib/confirm.js's CONFIRMED_VERBS).
async function dispatchUnwatch(send, session, preamble) {
  // repo= that names a real workspace is a repository, never a session name,
  // and cancelTarget's name fallback (session.name ?? session.repo) exists
  // only for the model putting a NAME in the wrong field. Resolved letters
  // arrive here as aliases (see the resolveRepoRef block in the message
  // handler), so "unwatch repo=B" with one live watch must fall through to
  // the exactly-one-watch branch rather than refuse "I am not watching
  // fitness, sir."
  const target = repoCrossCheckAlias(session.repo) ? { ...session, repo: undefined } : session;
  const { watch, refusal } = cancelTarget(watchers, target);
  if (refusal) {
    await say(send, refusal);
    return;
  }
  watchers.cancel(watch.sessionId);
  log(`no longer watching ${watch.name} (${watch.sessionId})`);
  await say(send, joinSpoken(preamble, unwatchVerdict({ name: watch.name })));
}

// Every session that can be asked about right now: what Dante remembers
// starting, minus whatever has no transcript on disk, plus what is running, all inside the
// repositories named out loud. Built here rather than cached because the two
// inputs both move -- the roster every five seconds, the workspace list the
// moment somebody names a repo mid-conversation.
function recallable(roster) {
  return recallableSessions(getSessions(memoryStore), roster, {
    roots: Object.values(workspacePaths(memoryStore)),
  });
}

// What a session did, read back out loud.
//
// The only verb here that answers rather than acts, and the only one that is not
// proposed first (see the note in lib/confirm.js). It resolves a name against
// sessions that have FINISHED as well as ones still running, which is the whole
// point: the moment a session ends it falls off the roster, and that is exactly
// when someone wants to know what came of it.
//
// It reads the session's own transcript, live or finished -- the same thing
// anyone would see by opening that session in a terminal and scrolling back.
// That transcript is the only source. The one-line summary reportComplete
// produces goes into the recap log (recordEvent, a short list that a recap
// reads once and clears), and this never consults it: a deleted session
// is simply not readable, with no cached answer standing in for it.
//
// What Dante says here IS kept, though: a successful read is filed as a note
// (lib/notes.js) so the conversation that follows can build on it and a
// restart does not forget it. The note is written from what was just read,
// never read from -- see lib/recall.js's own comment for the full rule.
//
// `preamble` is usually "" here, and deliberately: the chat turn that
// dispatches a read blanks the model's sentence before calling in, because a
// read is finished before a word of it is spoken and "let me read what jarvis
// three is doing" fused onto the findings announces an action that has already
// happened as one still pending. See the read branch of the chat handler for
// when the sentence is kept anyway.
async function dispatchRead(send, session, preamble, roster, conv) {
  const candidates = recallable(roster);
  // The number-then-name resolution, and the wording of each refusal, live in
  // lib/confirm.js's readTarget so they can be tested without a live roster or
  // a real transcript on disk -- this is only the wiring that speaks the
  // refusal when there is one.
  const { record, refusal } = readTarget(roster, candidates, session);
  // Every path out of this function speaks conv?.flag alongside whatever it
  // was already going to say, and settles the tracker once that speech
  // actually happened -- a refusal or a failed read is still a turn that
  // heard the caveat, and skipping it here would be exactly the silent loss
  // conv.notes.settle()'s own comment describes: computed but never spoken,
  // and then never offered again because pending() only tracks WHETHER
  // something has been reported, not whether it was ever actually said.
  if (refusal) {
    const spoken = await say(send, joinSpoken(preamble, refusal, conv?.flag ?? ""));
    if (spoken) conv?.notes?.settle();
    return;
  }

  const question = session.question ?? session.task ?? session.text ?? session.message;

  activity(send, "reading", { subject: record.name });
  try {
    send({ type: "state", value: "thinking" });
    // `running` goes along so the read model knows the "still working, sir"
    // prefix below is coming and does not open its own answer the same way.
    const { text, reason } = await readSession({
      cwd: record.cwd, sessionId: record.sessionId, task: record.task, question,
      running: record.running,
    });

    if (!text) {
      log(`read ${record.name} failed: ${reason}`);
      const spoken = await say(send, joinSpoken(
        preamble,
        reason === "no-transcript"
          ? `${record.name} left nothing I can read, sir.`
          : `I could not read ${record.name} back, sir.`,
        conv?.flag ?? "",
      ));
      if (spoken) conv?.notes?.settle();
      return;
    }

    log(`read ${record.name} (${text.length} chars)`);

    // Filed before the answer is spoken, not after: a failed write here must
    // never fail the read, so writeSection's null is simply "not saved" and
    // the sentence below is spoken exactly the same either way.
    const now = Date.now();
    const spec = sessionNoteSpec(record, question, text, now);
    const written = spec && writeSection(
      NOTES_DIR,
      spec.topic,
      { ...spec.section, title: spec.title, summary: spec.summary, about: spec.about, facts: spec.facts },
      getNoteLimits(memoryStore),
    );
    if (written) {
      log(`note saved ${spec.topic}`);
      logPruned(written.pruned);
      // conv is null when dispatchRead is reached with no conversation state
      // to track against (a call site added later that has none, say) -- the
      // note is still saved above either way, since the file on disk is not
      // per-conversation; only the touch/topic/contradiction bookkeeping,
      // which lives on conv, is skipped.
      if (conv) {
        conv.notes.touch(written.note);
        conv.topic = { topic: spec.topic, at: now };
        // pending(), not settled here: a read can itself create the
        // contradiction (two reads of the same session disagreeing on a
        // fact), and this only computes the sentence -- settle(), below,
        // is what marks it reported, once it has actually been spoken.
        // Assigned, not appended: pending() is cumulative and still holds
        // whatever foldNotes found at the start of this turn, so appending
        // would speak that contradiction twice -- and with the newest note
        // just changed, the second telling could name the opposite winner.
        conv.flag = describeContradictions(conv.notes.pending(), now);
      }
    }

    // Said plainly when the session is still going, because "it decided X" and
    // "it has decided X so far" are different facts and the difference is whether
    // to act on it. `running` is null when the listing failed, and then nothing is
    // claimed either way rather than something being guessed.
    //
    // conv.flag rides last, after the answer: the read is what was asked for,
    // and a contradiction between notes is a caveat about something else
    // entirely, worth hearing only once the actual answer has been. conv?.flag
    // ?? "" so a null conv (see above) speaks the plain answer rather than
    // throwing on a property read that has nothing behind it.
    const spoken = await say(send, joinSpoken(
      preamble,
      record.running === true ? `${record.name} is still working, sir. So far: ${text}` : text,
      conv?.flag ?? "",
    ));
    // settle(), not a conv.flag reset: the flag string itself is left for
    // the outer finally in the connection handler to clear unconditionally.
    // settle() is the lasting half of "this was spoken" -- it marks every
    // contradiction just spoken as reported, independent of that string.
    if (spoken) conv?.notes?.settle();
  } finally {
    activity(send, null);
  }
}

// "What happened while I was out." Reads the event log back as one spoken
// paragraph and clears it -- and clears the announcement queue too, because
// whatever was waiting there for a free floor is exactly what the recap just
// said. It changes no process, which is why the caller (below) never routes
// it through propose(): there is nothing here for a "yes" to authorize.
async function dispatchRecap(send, preamble = "") {
  const events = getEvents(memoryStore);
  const recap = formatRecap(events);
  log(`recap: ${events.length} event(s)`);
  await say(send, joinSpoken(preamble, recap));

  clearEvents(memoryStore);
  saveStore(memoryStore);
  const cleared = clearPendingAnnouncements();
  if (cleared > 0) log(`recap cleared ${cleared} pending announcement(s)`);
}

// Start a real Claude Code session in one of the workspaces, and say one
// sentence about it. Everything that decides anything lives in lib/ -- which
// repository (getWorkspace), whether to at all (refuseStart), what to call it
// (buildName), what reaches the command line (buildStartArgs). This is the
// wiring between them.
//
// It never waits for the session to do anything. That is the entire point of
// starting one by voice: the confirmation is immediate, and the roster is what
// reports what happened afterwards.
// `conv` rides through here only to reach dispatchRead's verb=read branch,
// which is the one verb here that writes and tracks a note against this
// conversation -- the other four verbs (recap, tell, interrupt, stop, start)
// never touch lib/notes.js and never look at it. Both call sites (the direct
// one below and the proposal `run` closure in proposeSession) have a real
// conv in scope and pass it; the `= null` default is only a guard against a
// third call site someday forgetting to, and dispatchRead treats a null conv
// as "read it and speak it, just do not track it against a conversation."
async function dispatchSession(send, session, preamble = "", roster = null, conv = null) {
  if (session.verb === "recap") {
    await dispatchRecap(send, preamble);
    return;
  }
  if (session.verb === "tell" || session.verb === "interrupt") {
    await dispatchTell(send, session, preamble, roster, session.verb);
    return;
  }
  if (session.verb === "stop") {
    await dispatchStop(send, session, preamble, roster);
    return;
  }
  if (session.verb === "read") {
    await dispatchRead(send, session, preamble, roster, conv);
    return;
  }
  if (session.verb === "watch") {
    await dispatchWatch(send, session, preamble, roster);
    return;
  }
  if (session.verb === "unwatch") {
    await dispatchUnwatch(send, session, preamble);
    return;
  }
  if (session.verb !== "start") {
    // Saying so is better than silence: the tag was stripped, so otherwise
    // nothing would happen and nothing would explain why.
    await say(send, joinSpoken(preamble, "I can start a session, talk to one, interrupt one, stop one, read one back, watch one, or catch you up, sir."));
    return;
  }

  // session.repo is already resolved by the time it gets here -- see the
  // resolveRepoAlias call in the message handler, which runs before this
  // session is ever described back as a confirmation sentence. Resolving it
  // again here, a second time, is exactly how the confirmation and the
  // dispatch once disagreed about which repository "start a session to fix
  // the tests" meant.
  const workspace = getWorkspace(memoryStore, session.repo);
  const live = Array.isArray(roster) ? roster : [];
  // Only the sessions Dante itself started. Counting every background session
  // on the machine was a real bug: a Claude Code background job is
  // indistinguishable from one of Dante's, so a machine in ordinary use sat at
  // four of five before Dante had done anything, every start was refused, and
  // the refusal named somebody else's session as the thing to stop. What the
  // ceiling bounds is unattended sessions Dante is responsible for.
  const own = ownRunning(live, getSessions(memoryStore));
  const refusal = refuseStart(session, {
    workspace,
    workspaces: workspacePaths(memoryStore),
    running: own.running,
    max: MAX_SESSIONS,
    // The oldest idle one is the obvious thing to stop, and naming it is what
    // makes a refusal actionable rather than a dead end -- now that it can only
    // ever be a session Dante started.
    oldestIdle: own.oldestIdle ?? undefined,
  });
  if (refusal) {
    log(`session refused: ${refusal}`);
    await say(send, joinSpoken(preamble, refusal));
    return;
  }

  activity(send, "starting", { subject: workspace?.alias });
  try {
    const started = await beginSession({
      workspace, task: session.task, kind: session.kind, taken: live, then: session.then, brief: session.brief,
      command: session.command,
    });

    if (!started.ok) {
      log(`session start failed name=${started.name} ${started.error}`);
      send({ type: "debug", stage: "session", msg: `start failed: ${started.error}` });
      await say(send, joinSpoken(preamble, `That session would not start, sir. ${started.error}.`));
      return;
    }

    send({ type: "debug", stage: "session", msg: `started ${started.name}` });
    // startSession's ok means the CLI outlived its startup window, which is a
    // fact about the process. "Running" is a fact about the session, and the
    // roster is what knows that, so it is asked before the word is used.
    const listed = isListed(await rosterPoller.fresh(), started.sessionId);
    if (listed !== true) log(`started ${started.name} but ${listed === null ? "roster unreadable" : "not yet listed"}`);
    // The preamble is the model's own confirmation, which is usually the whole
    // sentence. The name is added because it is how every later command refers to
    // this session, and hearing it once is what makes "stop jarvis three" possible.
    await say(send, joinSpoken(preamble, startVerdict({ name: started.name, listed })));
  } finally {
    activity(send, null);
  }
}

// Everything about starting a session that has nothing to do with a browser:
// naming it, spawning it, remembering it.
//
// Split out because a chained session is started by a poller tick with no
// socket in sight, and it must be started exactly the way a spoken one is --
// same naming, same thread. A second implementation would drift on the first
// change to either.
async function beginSession({ workspace, task, kind: kindId, taken = [], then = null, depth = 0, brief = undefined, command = undefined }) {
  const kind = sessionKinds.get(kindId) ?? null;
  // No per-repository counter reserved here any more: a session's number on
  // screen is its position in orderRoster's own order, decided fresh on every
  // tick, not a value burned into the name at start time. buildName's only
  // guard against a collision is the live names already in `taken`.
  //
  // A command session is named for its command ("review", "review-2"): that
  // is what it will be called out loud, and "run-review-high" is not.
  const commandName = typeof command === "string" ? command.slice(1).split(" ")[0] : "";
  const name = buildName(
    { task, hint: commandName || kind?.nameHint?.({ task }) },
    (Array.isArray(taken) ? taken : []).map((r) => r.name),
  );
  const sessionId = newSessionId();

  const started = await startSession({
    name,
    sessionId,
    cwd: workspace.path,
    task,
    brief,
    command,
    systemPrompt: kind?.systemPrompt?.({ task, alias: workspace.alias }),
    model: kind?.model,
    effort: kind?.effort,
  });

  if (!started.ok) {
    recordEvent(memoryStore, { kind: "failed", name, detail: started.error });
    saveStore(memoryStore);
    return { ok: false, name, error: started.error };
  }

  // `sessionId` above is only ever provisional: --bg ignores --session-id and
  // mints its own (see the comment on UUID in lib/spawn-session.js), so it is
  // not the id this session will actually answer to. The roster is what
  // knows that id, and resolveStartedSession is what finds the record on it
  // -- matched on the short id parseStartedId read off stdout, or by name
  // when that read came back empty. That record's own sessionId, not the
  // uuid above, is the key everything downstream has to agree with the
  // roster on: ownRunning counts against it, dispatchStop writes a stoppedAt
  // against it, and a chain fires off it.
  //
  // `list: () => rosterPoller.fresh()` rather than bare listAgents: a start
  // that spawned its own `claude agents --json` on every poll of this wait
  // would be a second, uncoordinated source of roster reads racing the
  // poller's own — fresh() is the poller's own de-duplicated read (see
  // createRosterPoller in lib/agents.js), so a start costs at most one
  // listing beyond whatever the poller was already about to do. `cwd` and
  // `since` are what let matchStarted's name fallback tell this session
  // apart from an older, unrelated one sharing its name — see matchStarted's
  // own comment for why both bounds matter.
  const resolved = await resolveStartedSession(
    { shortId: started.shortId, name, cwd: workspace.path, since: started.startedAtMs },
    { list: () => rosterPoller.fresh(), deadlineMs: 5000 },
  );
  const liveSessionId = resolved?.sessionId ?? sessionId;
  if (!resolved) {
    // Not a failed start -- the session is running either way -- but nothing
    // keyed on its real id will ever find it: ownRunning will not count it
    // against the cap, dispatchStop will not be able to record a stop for
    // it, and a chain on it will never fire. Worth a log line, not a spoken
    // error, since there is nothing here for a person to act on.
    log(`session started name=${name} id=${sessionId} but could not be matched on the roster -- cap, queue and chain will not track it`);
  }

  // Its own bucket, not the artifacts list: artifacts answer "what did we build
  // lately", and ten sessions would push every build out of that answer.
  rememberSession(memoryStore, liveSessionId, {
    name, alias: workspace.alias, cwd: workspace.path, task, kind: kindId ?? null,
    // daemonId(), not the record's `.id` read straight off it: everything the
    // roster carries came from the CLI, but a stored shortId is later handed
    // to `claude stop <id>` as an argument, and this is what makes sure it
    // still looks like an id rather than something that would be read as a
    // flag by the time that happens.
    shortId: daemonId(resolved?.record) ?? started.shortId ?? null,
  });
  // What to do once it finishes, if anything was asked for. Recorded now rather
  // than looked up later: by the time it ends, the turn that asked is long over.
  if (then) chainAfter(memoryStore, liveSessionId, { task: then, alias: workspace.alias, depth });
  recordEvent(memoryStore, { kind: "started", name, detail: task });
  saveStore(memoryStore);
  log(`session started name=${name} id=${liveSessionId} cwd=${workspace.path}${then ? " then=" + JSON.stringify(then) : ""}`);

  return { ok: true, name, sessionId: liveSessionId };
}

async function dispatchAction(send, conv, action, preamble = "") {
  log(`action primitive=${JSON.stringify(action.primitive)} params=${JSON.stringify(action.params)}`);

  const primitive = registry.get(action.primitive);
  if (!primitive) {
    // A model can invent a primitive that was never installed. That is a thing
    // to say in character, not a thing to crash on.
    const name = readableName(action.primitive);
    log(`action unknown primitive=${JSON.stringify(action.primitive)}`);
    await say(send, name
      ? `I don't know how to build a ${name} yet, sir.`
      : "I'm not sure what you'd like me to build, sir.");
    return;
  }

  // Said early so nobody sits through a round of questions only to be turned
  // away at the end. The slot is not claimed here — the claim happens at the
  // moment the build actually starts, which is the only place it is safe.
  if (!slotFree()) {
    log(`build deferred primitive=${primitive.id} (one already running)`);
    await say(send, BUSY_LINE);
    return;
  }

  await advance(send, conv, primitive, { ...action.params }, preamble);
}

// Ask for the next missing answer, or start the build once nothing is missing.
// One question per turn: the answer arrives as the next thing the person says.
async function advance(send, conv, primitive, params, preamble = "") {
  const question = firstUnanswered(primitive, params);
  if (question) {
    conv.pending = { primitive, params, key: question.key };
    send({ type: "ask", text: question.ask });
    // Spoken as well as sent, because the person is listening rather than
    // reading the screen -- and fused to the acknowledgement so "of course,
    // sir" and the question arrive as one sentence.
    await say(send, joinSpoken(preamble, question.ask));
    return;
  }
  await build(send, primitive, params, preamble);
}

async function build(send, primitive, params, preamble = "") {
  // The real guard. Answering a question takes as long as the person takes, so
  // the check in dispatchAction can be minutes stale by the time a build starts
  // and another tab may have taken the slot in between.
  if (!claimSlot()) {
    log(`build refused primitive=${primitive.id} (one already running)`);
    await say(send, joinSpoken(preamble, BUSY_LINE));
    return;
  }

  activity(send, "building", { subject: primitive.id });
  try {
    let started = Date.now();
    let outcome;
    try {
      // Confirm out loud BEFORE the HUD takes over. Someone who just answered a
      // question needs to hear that the answer landed; a silent jump to the build
      // readout reads as the assistant ignoring them. `nextState` hands the orb to
      // the HUD when this line finishes rather than racing it.
      const kickoff = typeof primitive.startLine === "function"
        ? primitive.startLine(params)
        : "Starting now, sir.";
      await say(send, joinSpoken(preamble, kickoff), "working");

      started = Date.now();
      log(`build start primitive=${primitive.id} params=${JSON.stringify(params)}`);
      outcome = await runBuild(primitive, params, (line) => send({ type: "progress", line }));
    } finally {
      // Released the moment the CLI is done and before a word is spoken about it,
      // so a Fish outage — while announcing the start or while reporting the
      // result — cannot leave the slot claimed and lock the machine out of ever
      // building again.
      releaseSlot();
    }

    const ms = Date.now() - started;
    const dir = basename(outcome.dir);
    log(`build finish primitive=${primitive.id} ok=${outcome.ok} ${ms}ms dir=${dir}`);

    if (outcome.ok) {
      // The basename, never the absolute path: it is the same token the /builds/
      // route uses, and it keeps a home directory out of a file whose contents are
      // read back into a system prompt on every future turn.
      recordArtifact(memoryStore, PROJECT_KEY, {
        primitive: primitive.id,
        dir,
        outputContract: primitive.outputContract,
      });
      saveStore(memoryStore);
      refreshPersona();

      await say(send, primitive.doneLine(params));
      // Served by the /builds/ route above. Encoded because a primitive's output
      // contract is a filename, and filenames are allowed to contain spaces.
      send({ type: "open", url: encodeURI(`${BUILDS_URL}${dir}/${primitive.outputContract}`) });
      // No "idle" here. say() returns once the audio has been SENT, not once it has
      // been heard, and the browser handles each message as it arrives — so an idle
      // sent now lands while the done-line is still playing and drops the orb dead
      // mid-sentence. Playback ending is what returns it to idle.
      return;
    }

    // builder.run() reports an outcome rather than an exit code. A terminal result
    // event that is not an error means the CLI finished its turn cleanly, which is
    // what an exit code of 0 tells describeFailure — and it is the difference
    // between "the build stopped" and the far more useful "the build finished but
    // never wrote index.html".
    const code = outcome.result && outcome.result.is_error !== true ? 0 : undefined;
    const trouble = describeFailure({
      code,
      dir: outcome.dir,
      outputContract: primitive.outputContract,
      result: outcome.result,
      timedOut: outcome.timedOut,
      // Only a chain sets this; a single-shot outcome has no such key, and
      // describeFailure leaves the sentence alone when it is absent.
      failedStep: outcome.failedStep,
    }) || "The build did not finish.";

    await say(send, `${trouble} Nothing is broken, sir. Say the word and I'll try again.`);
    // The log path is the one thing worth reading afterwards, so it goes on screen
    // rather than into the spoken line.
    send({ type: "error", message: outcome.log ? `${trouble} Full log: ${outcome.log}` : trouble });
    send({ type: "state", value: "idle" });
  } finally {
    activity(send, null);
  }
}

// ---------------------------------------------------------------------------
// End-of-session summary
// ---------------------------------------------------------------------------

// Its own bookkeeping voice, deliberately not the DANTE persona: the spoken
// rules -- forty words, no lists, address Krane as sir -- would shape a note
// nobody is ever going to hear into something shorter and vaguer than the next
// session needs.
const SUMMARY_PERSONA =
  "You are keeping notes in a voice assistant's memory file, for your own use in a later " +
  "session. In two or three plain sentences, record what this conversation was about and what " +
  "is worth carrying forward: what was built, what was asked for, what was decided. Write it " +
  "as notes, not as speech. No greeting, no persona, no markdown, no questions.";

// Below this a conversation is "what's the weather" and a summary is worse than
// nothing -- it would overwrite a real one from earlier in the day.
const SUMMARY_MIN_TURNS = 3;

// Module scope, not per-socket: a page that reloads in a loop would otherwise
// start a summary process per reload, each one a real CLI invocation.
let summarizing = false;

// Fire and forget by design. Nothing is awaited, nothing is sent to the socket
// (it is closing or gone), and every error is swallowed into the log -- a failed
// note is not worth a visible failure, and there is nobody left to tell.
function summarizeOnClose(sessionId, turns) {
  if (!sessionId || turns < SUMMARY_MIN_TURNS || summarizing) return;
  summarizing = true;

  ask("Summarize this conversation for your own notes.", sessionId, { persona: SUMMARY_PERSONA })
    .then(({ reply }) => {
      if (!reply) return;
      // The session id this call returns is deliberately thrown away. Storing it
      // would put "Summarize this conversation for your own notes" at the head
      // of whatever gets resumed next.
      touchProject(memoryStore, PROJECT_KEY, { summary: reply });
      saveStore(memoryStore);
      refreshPersona();
      log(`memory summary saved (${reply.length} chars)`);
    })
    .catch((e) => log("memory summary skipped:", e.message || e))
    .finally(() => { summarizing = false; });
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

// A WebSocket is exempt from the same-origin policy: any page, in any tab, can
// open a socket to a port on this machine and start talking. With no check on
// who opened it, a page the reader merely visits could start a build here — a
// model with file-writing tools, on their machine, with no click and nothing
// visible — and read the whole conversation back, absolute paths included.
// Origin is the one header a page cannot forge, because the browser sets it, so
// it is the check. A MISSING Origin is refused as well: a browser always sends
// one, so its absence means the request did not come from a page at all.
function originAllowed(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.has(origin.toLowerCase());
}

const wss = new WebSocketServer({
  noServer: true, // the upgrade is accepted below, after the origin is checked
  // The default ceiling is 100MB per message, and a message's text is handed to
  // a subprocess. Speech is short; this is far more room than a sentence needs.
  maxPayload: 64 * 1024,
});

server.on("upgrade", async (req, socket, head) => {
  if (!originAllowed(req.headers.origin)) {
    log(`ws refused origin=${JSON.stringify(req.headers.origin ?? null)}`);
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  // This is the check the login screen is a decoration on top of. What accepting
  // this socket grants is a Claude Code session with file tools on, running
  // under this login — so the answer has to be decided here, where a refusal is
  // a destroyed socket, and not in a page that could simply be skipped by
  // opening the socket directly. The cookie is the only credential considered:
  // it is HttpOnly, so no script on this origin (a build's page included) can
  // read it, and it is never carried in the URL, which this server logs.
  if (!(await auth.verify(sessionToken(req)))) {
    log("ws refused unauthenticated");
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

const sessions = new Map(); // ws -> sessionId

wss.on("connection", (ws) => {
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  // Per-tab state, held in this connection's closure rather than a global map,
  // so it cannot outlive the socket. `pending` is the question waiting on an
  // answer. The one-build-at-a-time guard is deliberately NOT here: it counts
  // builds on the machine, and two tabs are two of these closures.
  // `unanswered` is everything said since the last spoken reply, oldest first.
  // It is usually one sentence and is cleared the moment a reply is actually
  // spoken; it holds more only when someone interrupted themselves. `abort` is
  // the call in flight, and `settled` is how the next one waits for the abandoned
  // child to finish dying -- two of them resuming one session id at the same
  // time is the race this whole arrangement exists to avoid.
  // notes/topic/flag are this conversation's memory-notes state: `notes` is the
  // per-conversation tracker of notes touched (so a contradiction is only ever
  // spoken once), `topic` is the note a session read most recently landed in.
  // It does NOT null itself once stale -- it is only ever nulled on socket
  // close (see below) or replaced by a fresher read/discussion -- so every
  // consumer (recordDiscussion, and the notes-fold hint) checks topicIsLive
  // itself before trusting it. `flag` is a contradiction sentence waiting to
  // be appended to the next thing spoken.
  const conv = {
    pending: null, proposal: null, interview: null, held: null, turns: 0, unanswered: [], abort: null, settled: Promise.resolve(),
    notes: createNoteTracker(), topic: null, flag: "",
  };
  const gate = createTurnGate();

  // Read fresh from the store rather than from a boot-time snapshot: a second
  // tab opened mid-conversation has to join the session that is current now, not
  // the one that existed when the server started.
  const remembered = getProject(memoryStore, PROJECT_KEY)?.sessionId;
  if (remembered) sessions.set(ws, remembered);

  // The newest page is the one that gets asked. A tab that never speaks is
  // still a room with someone in it.
  voice = send;

  // Anything still live from before this page connected -- most often a
  // watcher's report that fired while every tab was closed -- is offered
  // again right away rather than left to expire unheard. `take` deletes on
  // first take, so a page that reconnects twice in quick succession offering
  // the same entry twice is harmless: whichever ack arrives first wins it,
  // and the other finds nothing left to take.
  //
  // `cue` is false whenever another socket is already open at this moment:
  // that other tab may already hold this very entry and have chimed for it
  // once already (announce() reaches only `voice`, the newest tab, so an
  // older still-open one can be sitting on the same still-pending news), and
  // a second chime for news already sounded once is exactly the double this
  // guards against (see cueFor's own comment, public/attention-policy.js).
  // Count live sockets (the only open tab) rather than remembered sessions,
  // so another tab browser process counts even if it has no stored project session.
  for (const entry of pending.live(Date.now())) {
    send({
      type: "announce", id: entry.id, text: entry.text, kind: entry.kind, sessionId: entry.sessionId,
      reoffered: true, cue: [...wss.clients].filter((c) => c.readyState === 1).length <= 1,
    });
  }

  log("client connected");
  // The first poller tick is a baseline and fires no events, so a page opened
  // after it would sit empty until something changed.
  sendRoster(send, rosterPoller.current());
  sendWorkspaces(send);
  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    // The page reporting that the floor is free and it will take one of the
    // announcements it was offered. Handled before the "say" guard because it
    // carries no text at all.
    if (msg.type === "announce_ready") {
      if (typeof msg.id === "string") await speakAnnouncement(send, msg.id);
      return;
    }
    // Choosing a repository from the panel rather than saying it: same
    // sanitizing and same refusal-by-silence as every other memory write here,
    // just without a sentence to narrate it back through -- the panel's own
    // re-render (from the workspaces broadcast below) is the confirmation.
    if (msg.type === "set_main") {
      if (setMainRepo(memoryStore, msg.alias)) {
        saveStore(memoryStore);
        broadcastWorkspaces();
        renumberNow();
        log(`main repository set to ${getMainRepo(memoryStore)}`);
      } else {
        log(`set_main refused: ${JSON.stringify(msg.alias)}`);
      }
      return;
    }
    if (msg.type !== "say" || !msg.text?.trim()) return;
    log("say:", JSON.stringify(msg.text));
    send({ type: "debug", stage: "stt", msg: `heard "${msg.text}"` });
    try {
      // An approval outranks everything, including a half-finished build
      // question: a real process is blocked on it right now.
      if (await answerApproval(send, msg.text)) return;

      // Then a proposal waiting on a yes. Above conv.pending because a build
      // question is part of a build already agreed to; this is the agreement.
      if (await answerProposal(send, conv, msg.text)) return;

      // Then a read-back the machine spoke, waiting on its yes. Below the
      // proposal for the same reason the proposal is below an approval: it is
      // the earlier step of the same exchange.
      if (await answerHeld(send, conv, msg.text)) return;

      // An outstanding question owns the next thing said: it is an answer, not a
      // new turn, so it goes to the build rather than to the chat model.
      if (conv.pending) {
        const { primitive, params, key } = conv.pending;
        conv.pending = null;
        const answer = msg.text.trim();
        log(`answer ${primitive.id} ${key}=${JSON.stringify(answer)}`);
        send({ type: "debug", stage: "ask", msg: `${key} = "${answer}"` });
        await advance(send, conv, primitive, { ...params, [key]: answer });
        return;
      }

      // Whoever spoke last has the floor. The call already running is abandoned
      // rather than left to answer a question that has been overtaken, and what
      // it was asked stays in `unanswered` so the call replacing it carries both.
      conv.unanswered.push(msg.text);
      if (conv.abort) {
        log("turn superseded");
        send({ type: "debug", stage: "brain", msg: "superseded by a newer turn" });
        conv.abort.abort();
      }
      const token = gate.begin();
      const controller = new AbortController();
      conv.abort = controller;

      send({ type: "state", value: "thinking" });
      const tb = Date.now();
      // Started here rather than awaited here: the listing is a child process
      // of its own, and the wait below is dead time it can spend running. It
      // never rejects, so there is nothing to catch.
      const listing = rosterPoller.read();
      // The abandoned child is still shutting down and still owns the session
      // file, so the replacement waits for it rather than racing it.
      const previous = conv.settled;
      let release;
      conv.settled = new Promise((done) => { release = done; });
      await previous;

      // null when the CLI could not be asked, which leaves the turn exactly as
      // it would have been. The roster is a nicety; answering is not.
      const roster = await listing;

      // An interview nobody has touched for ten minutes is over, and the label
      // saying one is on must not outlive it: interviewBlock would already say
      // nothing about it, so this only makes the page agree with the model.
      if (conv.interview && !isLive(conv.interview)) {
        conv.interview = null;
        conv.held = null;
        activity(send, null);
        log("interview expired");
      }

      // The escape phrase is read here, once, so the machine-state line built
      // below carries the decision even if the model asks another question
      // anyway -- interviewBlock's tail then tells it to stop regardless of
      // what it was about to do.
      if (isLive(conv.interview) && wantsToProceed(msg.text)) conv.interview = markProceed(conv.interview);

      // Read in the same tick as the list itself, so it counts exactly the
      // sentences this call was asked about and nothing that arrives behind it.
      // The recallable list rides along for the same reason the roster does: a
      // finished session appears in no listing, so without it the model has
      // never heard the name it is being asked about.
      // Folding a note into the prompt counts as accessing it, the same as a
      // read does -- foldNotes touches every recent note into conv.notes and
      // hands back both the machine-state block to fold into this turn's
      // prompt and the sentence for whatever contradiction that touch
      // surfaced against a note touched earlier this conversation. A plain
      // assignment, not a join: conv.flag is always "" here, since the outer
      // finally below clears it unconditionally at the end of every turn,
      // spoken or not.
      //
      // The hint is what keeps the note about the session this turn is
      // actually discussing from losing its seat to one that merely got
      // appended to more recently: conv.topic is the live read/discussion
      // window (set by dispatchRead, refreshed by recordDiscussion), gated
      // through topicIsLive here so a read from hours ago cannot keep
      // monopolizing a fold seat just because nobody has closed the socket
      // since -- conv.topic itself is only ever nulled on close (see
      // above), not on going stale. mentionedSessions catches a session
      // named by voice even outside that window -- both roster and
      // `recalled` (computed once here, reused by mergeTurns below) so a finished
      // session can still be pinned by name, the same reach dispatchRead
      // itself gets from recallable.
      const now = Date.now();
      const recalled = recallable(roster);
      const hint = {
        topic: topicIsLive(conv.topic, now) ? conv.topic.topic : null,
        names: mentionedSessions(conv.unanswered.join(" "), [...(roster ?? []), ...recalled]),
      };
      const { context: notesForPrompt, flag, topics, chars } = foldNotes(conv.notes, NOTES_DIR, now, hint);
      conv.flag = flag;
      // Wiring only -- the numbers themselves come from lib/notes.js. This is
      // the number the trim in this branch was made to shrink; watching it
      // in production is how the next tuning decision gets made on real
      // turns instead of a guess.
      if (topics.length) log(`notes folded ${topics.length} note(s) ${chars} chars: ${topics.join(", ")}`);

      const asked = mergeTurns(conv.unanswered, {
        roster, recalled, aliases: workspacePaths(memoryStore),
        interview: interviewBlock(conv.interview),
        notes: notesForPrompt,
        workspaces: workspacesForClient(memoryStore),
        // Names, not sessionIds -- the persona teaches the WATCHING line as
        // something read out by name, the same as every other machine-state
        // line, and the model never sees a sessionId anywhere else either.
        watching: watchers.names(),
      });
      const answering = conv.unanswered.length;

      let spoken, sessionId, recovered;
      try {
        // askResilient, not ask: a remembered session id can have expired since it
        // was written, and the first turn after a page load is exactly where that
        // shows up. It retries once from cold rather than failing the turn.
        ({ reply: spoken, sessionId, recovered } = await askResilient(
          asked,
          sessions.get(ws),
          { session: brainSession(), persona, signal: controller.signal },
        ));
      } finally {
        if (conv.abort === controller) conv.abort = null;
        release();
      }
      const bms = Date.now() - tb;
      if (recovered) log("brain recovered from an unresumable session id");
      sessions.set(ws, sessionId);
      conv.turns += 1;
      // Persisted every turn, because this id is what the next page load resumes
      // from -- and after a recovery it is what replaces the dead one.
      touchProject(memoryStore, PROJECT_KEY, { sessionId });
      saveStore(memoryStore);
      // The model may append machine-readable tags: one asking for a build, one
      // recording a standing preference. Split them off first -- a tag is for
      // dispatch, never for the voice.
      const parsed = parseAction(spoken);
      const { reply, action, memory } = parsed;
      let session = parsed.session;

      // Applied before dispatch, with nothing awaited in between: "make it dark
      // from now on and build me a landing page" has to have the preference on
      // disk before the build starts reading it. The two tags are independent;
      // both apply. applyMemoryTag does its own sanitizing and capping, so what
      // it returns is only what actually survived.
      if (memory) {
        // Workspace pairs first, and separately: they name a directory a real
        // session will run in rather than a standing preference, so they are
        // checked against the filesystem instead of folded into the persona.
        const workspaces = applyWorkspaceTag(memoryStore, memory);
        if (workspaces) {
          saveStore(memoryStore);
          // `workspaces` is `true`, not a {alias: path} map, when the tag only
          // set a main -- registered nothing new to log a path for, so the log
          // line says what actually happened instead of the word "true".
          log(workspaces === true
            ? `main repository set to ${getMainRepo(memoryStore)}`
            : `workspace set ${JSON.stringify(workspaces)}`);
          broadcastWorkspaces();
          renumberNow();
        }
        // Lowering memory-max-mb or memory-max-files is itself a write to the
        // memory system, so the cleanup it implies runs right here rather than
        // waiting for the next note to be saved -- the same reason a lowered
        // limit is also swept at startup, above.
        const limits = applyNoteLimitsTag(memoryStore, memory);
        if (limits) {
          saveStore(memoryStore);
          const pruned = pruneNotes(NOTES_DIR, getNoteLimits(memoryStore));
          log(`note limits set ${JSON.stringify(limits)}`);
          logPruned(pruned);
        }
        const saved = applyMemoryTag(memoryStore, PROJECT_KEY, memory);
        if (saved) {
          saveStore(memoryStore);
          refreshPersona();
          log(`memory set ${JSON.stringify(saved)}`);
        }
      }
      // The call landed after the floor had already passed to a newer sentence:
      // the abort fired a moment too late to stop it. What it learned is kept --
      // the exchange really did happen, and the session id and any preference
      // are worth having -- but the answer belongs to a question that has been
      // overtaken, so it is never spoken and never dispatches a build.
      if (!gate.isCurrent(token)) {
        log(`brain superseded after answering ${bms}ms session=${sessionId}`);
        return;
      }

      log(`brain ok ${bms}ms session=${sessionId} reply=${JSON.stringify(reply)}` +
          (action ? ` action=${JSON.stringify(action.primitive)}` : ""));
      send({ type: "debug", stage: "brain", ms: bms, msg: `claude: "${reply}"` });
      // With a build to dispatch, the reply is not spoken on its own: it is
      // handed down as a preamble and fused onto the question (or the kickoff)
      // so the whole turn is one utterance. Speaking it here would add a second
      // clip and a synthesis gap to every build request.
      //
      // What was asked comes off the list once the reply has actually been
      // spoken, not when it was produced. A turn abandoned halfway -- whether the
      // call was killed or the clip was overtaken during synthesis -- has to leave
      // what it was asked behind for the call that supersedes it, and only the
      // sentences this reply addressed come off, so one said during synthesis is
      // still waiting afterwards.
      if (session) {
        // The exact string the model produced, tag and all, before parseAction
        // ever touches it -- so a truncated or mangled name= can be traced back
        // to whether the model wrote it wrong or the parser cut it short.
        log(`session tag raw=${JSON.stringify(spoken)}`);

        // Resolved here, before anything branches on session.repo -- above
        // even the interview check just below, which returns early and
        // stores whatever session.repo holds into conv.interview.repo via
        // noteInterview. A letter Krane said ("repo B") has to become the
        // real alias before that store happens: conv.interview.repo is what
        // the interviewing activity line's subject reads, and it is what the
        // brief's own Where: line is composed from once the interview
        // finishes (composeBrief, below and near dispatchSession) -- both
        // would otherwise read back the letter itself rather than the
        // repository it names. Run for every verb, not just start: a tell or
        // a stop can carry "repo B" on its own tag just as easily, and
        // vetCommand just below never touches .repo, so resolving before it
        // costs nothing.
        if (typeof session.repo === "string" && session.repo) {
          session.repo = resolveRepoRef(memoryStore, session.repo);
        }

        // The question IS the reply here: it is not confirmed and not
        // dispatched, because letting it reach dispatchSession would speak
        // dispatchSession's unknown-verb fallback ("I can start a session,
        // talk to one...") instead of the question just asked. needsConfirmation
        // is false for "interview", so without this branch it would fall
        // through to dispatchSession below -- that is the bug this branch
        // exists to prevent.
        if (session.verb === "interview") {
          // msg.text alone is only the newest sentence. A turn that answered
          // this interview question can have been a merged one -- someone
          // interrupted themselves and mergeTurns folded up to MAX_UNANSWERED
          // sentences into the one turn askResilient was actually asked --
          // and every one of them was said in answer to the question, not
          // just the last. conv.unanswered.slice(0, answering) is exactly
          // that set: the same prefix dropAnswered below is about to remove,
          // captured before the await above could let a newer sentence arrive
          // and grow the list underneath it.
          conv.interview = noteInterview(conv.interview, session, Date.now(), conv.unanswered.slice(0, answering));
          activity(send, "interviewing", { subject: conv.interview.repo || undefined });
          log(`interview asked ${conv.interview.asked} (repo=${conv.interview.repo || "none"}, ` +
              `notes=${conv.interview.notes.length}, covered=${conv.interview.covered.join(",") || "none"})`);
          // A tag with no question in front of it is a model that forgot the
          // question. It still counts -- asked is logged and reported, never
          // enforced -- but there is nothing to speak. What actually ends an
          // interview is the TTL, or the escape phrase read earlier this turn.
          if (!reply) {
            dropAnswered(conv.unanswered, answering);
            log("interview tag carried no question");
            return;
          }
          if (await say(send, reply, undefined, () => gate.isCurrent(token))) {
            dropAnswered(conv.unanswered, answering);
          }
          return;
        }

        // Read before the match below can clear it: a live interview about a
        // start carries the repo it already asked about and got an answer to,
        // and that answer must survive conv.interview being nulled a few
        // lines down. Scoped to verb=start on the interview itself, not just
        // on the session tag it produced -- INTERVIEW_VERBS also covers tell
        // and interrupt, and their own "repo" means "which session," which
        // has nothing to do with where an unrelated start should land.
        // A skill on the tag is vetted here, once, before it is described,
        // proposed or dispatched -- so every one of those sees the same
        // normalised line or none of them sees a tag at all. The rules are
        // lib/commands.js's (vetCommand); this only speaks the refusal.
        {
          const vetted = vetCommand(session, knownCommands);
          if (vetted.refusal) {
            log(`command refused: ${JSON.stringify(session.command)} -> ${vetted.refusal}`);
            dropAnswered(conv.unanswered, answering);
            await say(send, vetted.refusal);
            return;
          }
          if (vetted.session.verb !== session.verb) log(`command ${vetted.session.command} delivered as a ${vetted.session.verb}: a skill waits its turn`);
          session = vetted.session;
        }

        const fromInterview = conv.interview?.verb === "start" ? conv.interview.repo : "";

        // The main-repo default for a start with nothing named -- the only
        // repo-related thing left to do here, now that resolveRepoRef has
        // already run once, above, before this session was ever described
        // back as a confirmation sentence or an activity line. That single
        // resolve is also why fromInterview needs no resolving of its own:
        // conv.interview.repo was written by noteInterview from this same
        // session.repo on the earlier turn that asked the interview
        // question, which had already been run through resolveRepoRef by
        // the same block -- so a letter never reaches this point unresolved,
        // whether it came fresh on this tag or carried forward from the
        // interview. An interview's own answer outranks the main repository,
        // since it is the more specific thing actually said; a named repo is
        // untouched either way.
        if (session.verb === "start") {
          session.repo = session.repo?.trim() ? session.repo : (fromInterview || resolveRepoAlias(memoryStore, "") || session.repo);
        }

        const ownInterview = isLive(conv.interview) && matchesInterview(conv.interview, session) ? conv.interview : null;

        // A start, tell or interrupt is never proposed straight off the
        // model's own tag: confirming is the machine's job, not the model's,
        // and it runs exactly once per proposal. A proposal's "Shall I,
        // sir?" confirms the act, not the understanding behind it -- a yes to
        // "start a session in jarvis to fix the tests" says nothing about
        // which tests the model has in mind -- and that used to be checked
        // twice over, once by a read-back the model wrote into its own tag
        // (confirming=/confirmed=) and once more by the machine for whatever
        // that read-back left out, which is how the same understanding ended
        // up read back to Krane in two similar-sounding questions. Now
        // readyToPropose only ever says yes when Krane told the model
        // outright to proceed, so every other start, tell or interrupt lands
        // here and is held: the read-back is spoken from the model's own
        // brief, covering all four facets in one question, in place of the
        // proposal. It is folded into the interview as a question the
        // machine asked (spokenFor), so the model's next turn knows Krane's
        // yes, no or correction answers that question and not whatever it
        // said last, and the tag itself is kept (conv.held) so that a yes
        // lifts the hold on exactly what was read back rather than on
        // whatever the model recomposes a turn later -- see answerHeld. The
        // escape phrase is one way past this, because it is Krane saying so;
        // a skill is the other, because its facets ARE the command line, and
        // the proposal reads that line back exactly -- a read-back before it
        // would be the same question asked twice. holdForReadBack is the
        // rule; this is the wiring.
        if (holdForReadBack(session, ownInterview)) {
          // For a tell or an interrupt the session is resolved first, for the
          // same reason proposeSession resolves it before proposing: reading
          // back "I would tell jarvis-1 to ..." and hearing a yes, only to say
          // "I cannot find jarvis-1" afterwards, is worse than saying so now.
          // The resolved name is what is read back, since it is the session
          // the words will actually reach.
          let name = "";
          if (session.verb !== "start") {
            const { record, refusal } = findTarget(roster, session.name ?? session.repo, {
              number: session.number, alias: repoCrossCheckAlias(session.repo),
            });
            if (refusal) {
              log(`${session.verb} refused before read-back: ${refusal}`);
              dropAnswered(conv.unanswered, answering);
              await say(send, refusal);
              return;
            }
            name = record.name;
          }
          // Every facet, every time -- one read-back that covers the whole
          // brief rather than only whatever the model left uncovered, which
          // is what let a partial model-side read-back and this one land on
          // the same facet twice.
          const facets = FACETS;
          const question = readBack({ ...session, name }, facets);
          // Computed into locals rather than committed to conv straight away.
          // say() can drop a clip as superseded (a newer utterance interrupts
          // it before it plays), in which case it returns false and Krane
          // never heard this question at all -- but conv.interview/conv.held
          // used to be set unconditionally above, so his next "yes" (meant
          // for whatever he actually said) would still be read by answerHeld
          // as agreeing to a read-back nobody spoke. Waiting for say() to
          // resolve true before assigning keeps the hold in sync with what
          // was actually heard.
          const nextInterview = noteInterview(
            ownInterview,
            { for: session.verb, repo: session.repo, name, confirming: facets.join(","), spokenFor: true },
            Date.now(),
            conv.unanswered.slice(0, answering),
          );
          const held = { session: { ...session, ...(name ? { name } : {}) }, spoken: question };
          // activity and the log both wait for say() to resolve true, same
          // reasoning as the comment above: a dropped clip means Krane never
          // heard the question, so the page must not label itself
          // "confirming" and the log must not claim a hold that never
          // actually happened.
          if (await say(send, question, undefined, () => gate.isCurrent(token))) {
            activity(send, "confirming", { subject: nextInterview.repo || undefined });
            log(`confirming: ${session.verb} held (facets=${facets.join(",")}, asked=${nextInterview.asked}): ${JSON.stringify(question)}`);
            conv.interview = nextInterview;
            conv.held = held;
            dropAnswered(conv.unanswered, answering);
          }
          return;
        }

        // The interview is spent the moment its command is proposed: its
        // notes become the brief when the model did not write one itself, and
        // the state is cleared here so a later, unrelated session tag never
        // folds stale notes into a brief that has nothing to do with them.
        if (ownInterview) {
          session.brief = composeBrief({
            task: session.task, brief: session.brief,
            notes: ownInterview.notes, said: ownInterview.said, repo: ownInterview.repo,
          });
          conv.interview = null;
          conv.held = null;
        }

        // The request is settled either way: it is now a proposal waiting on a
        // yes, or it was refused or asked about before ever becoming one.
        dropAnswered(conv.unanswered, answering);
        // The model's reply is dropped here on purpose, not just left unsaid:
        // this is the one place a "jarvis-1 has it, sir" could be spoken about
        // a session nothing has touched yet, and these four never dispatch
        // unconfirmed -- see needsConfirmation in lib/confirm.js.
        if (needsConfirmation(session)) {
          await proposeSession(send, conv, session, roster);
        } else {
          // A read's sentence is dropped too, but only when the turn answered
          // a single sentence. The persona is told to say nothing for a read,
          // because the findings are heard after the read is already done and
          // "let me read what jarvis three is doing" then promises something
          // finished -- but a model that says it anyway must not be heard, so
          // the drop is enforced here. A merged turn is the exception: "what
          // is jarvis three doing, and make the orb blue" gets its second
          // sentence answered in that same prose, and dropAnswered above has
          // already marked it answered, so blanking it there would lose the
          // answer for good. The persona covers that case instead.
          const sentence = session.verb === "read" && answering <= 1 ? "" : reply;
          if (sentence !== reply) log(`read: dropped the model's sentence ${JSON.stringify(reply)}`);
          await dispatchSession(send, session, sentence, roster, conv);
        }
      } else if (action) {
        dropAnswered(conv.unanswered, answering);
        const held = await propose(send, conv, { action, primitive: registry.get(action.primitive) },
          () => dispatchAction(send, conv, action, ""));
        if (!held) await dispatchAction(send, conv, action, reply);
      } else if (reply) {
        // Captured before dropAnswered removes the prefix it addresses: `said`
        // is exactly what this reply answered, and it is what recordDiscussion
        // below records Krane as having said.
        const said = conv.unanswered.slice(0, answering);
        if (await say(send, joinSpoken(conv.flag, reply), undefined, () => gate.isCurrent(token))) {
          dropAnswered(conv.unanswered, answering);
          // conv.flag itself is left for the outer finally below to clear.
          // settle() is the lasting half of "this was spoken": it marks every
          // contradiction just spoken as reported, so pending() omits it next
          // turn -- independent of the transient string that carried it.
          conv.notes.settle();
          // Only a plain reply is ever appended to the note a read just landed
          // in. A build or a session command is its own record already -- an
          // artifact on disk, a line in the recap log -- so appending it here
          // too would duplicate it; the discussion that follows a read is what
          // the note exists to keep, and this branch is the only place that
          // discussion is heard. recordDiscussion covers the live-topic check,
          // the empty-discussion check and the write in one call.
          const recorded = recordDiscussion(NOTES_DIR, conv.topic, said, reply, Date.now(), getNoteLimits(memoryStore));
          if (recorded) {
            conv.topic = recorded.topic;
            log(`note updated ${recorded.topic.topic}`);
            logPruned(recorded.pruned);
          }
        }
      } else {
        dropAnswered(conv.unanswered, answering);
        log("brain returned no speakable text");
      }
    } catch (e) {
      // An abandoned turn is not a failure to report. Nobody is waiting on it,
      // the person is already mid-sentence, and the turn that superseded it owns
      // the screen now -- an error line here would flash over their own words.
      if (e.aborted) return;
      // Narrowed to sessionExhausted on purpose: a dead session must not survive
      // as a stored id, or the next tab resumes it and fails the same way. Any
      // other failure -- a Fish outage, say -- must not cost the conversation
      // its context.
      if (e.sessionExhausted) {
        sessions.delete(ws);
        touchProject(memoryStore, PROJECT_KEY, { sessionId: null });
        saveStore(memoryStore);
      }
      log("ERROR:", e.message || e);
      send({ type: "debug", stage: "error", msg: String(e.message || e) });
      send({ type: "error", message: String(e.message || e) });
      send({ type: "state", value: "idle" });
    } finally {
      // conv.flag (a note contradiction found while folding notes into
      // this turn's prompt, well before this try) is only ever fused into
      // something spoken by the two branches that speak sentence-shaped
      // text -- dispatchRead's own read-back and the plain-reply branch
      // above. Every other way this turn can end -- a session or build
      // dispatch that never speaks it, the superseded-turn return above,
      // or landing in the catch just above this -- leaves it unspoken, and
      // only a finally on the OUTER try is guaranteed to run after every
      // one of those. Clearing it here, unconditionally, is what keeps it
      // from ever surviving into a turn that had nothing to do with
      // raising it.
      conv.flag = "";
    }
  });
  ws.on("close", () => {
    // Read before the delete: this map is the only handle on the id, and the
    // summary below still needs it.
    const sessionId = sessions.get(ws);
    sessions.delete(ws);
    conv.pending = null;
    conv.proposal = null;
    conv.interview = null;
    conv.held = null;
    // The tracker itself lives only as long as the conv object does; a note's
    // topic surviving past the conversation that read it would let a stale
    // "still live" topic append an unrelated chat to it, so both die here too.
    conv.topic = null;
    conv.flag = "";
    // A question already asked is left to time out rather than answered by a
    // closing tab. Nothing is decided by a page going away.
    //
    // A pre-existing quirk, left as is: `voice` only ever points at the ONE
    // newest connection (see `voice = send` at connect), never back at an
    // older tab that is still open. Closing the newer of two open tabs nulls
    // it, so a watch fired after that holds until the older tab reconnects
    // (which sets `voice` again) rather than being offered to the tab that
    // is actually still sitting there. Out of scope here; the durability
    // this commit adds -- the recap entry, and the reconnect re-offer above
    // -- is what keeps that wait from ever losing a report, not a fix for
    // the wait itself.
    if (voice === send) voice = null;
    // A build already running is left to finish: it has been paid for and its
    // artifact still lands on disk. Nothing here points back at this socket
    // afterwards, and send() is a no-op once the socket is gone, so a progress
    // update arriving late has nowhere to go rather than something to break.
    log("client disconnected");
    // The summary resumes this session id in a process of its own, and the warm
    // CLI is still holding it -- two processes on one session is the race the
    // per-turn abort was built to avoid, arriving here by a different road. With
    // the last tab gone the conversation is over anyway, so the CLI is let go
    // first and the summary gets the session to itself. The next turn pays one
    // boot, at the one moment nobody is waiting on it.
    const others = [...wss.clients].filter((c) => c !== ws && c.readyState === 1).length;
    if (others === 0 && brain) {
      brain.close();
      brain = null;
      log("brain session closed (no clients left)");
    }
    summarizeOnClose(sessionId, conv.turns);
  });
});

// A port already in use is the single most common way starting this fails, and
// an unhandled EADDRINUSE prints a stack trace that says nothing about what to
// do next.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use — stop the other server or run PORT=${PORT + 1} node server.js`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});

// Loopback by default (DANTE_HOST unset or empty). This process runs a model
// with file-writing tools on and then serves what it wrote, which is not
// something to expose to the local network without deciding to -- set
// DANTE_HOST to opt in.
server.listen(PORT, HOST, () => {
  const ids = [...registry.keys()];
  const kinds = [...sessionKinds.keys()];
  console.log(`Dante on http://${bracketHost(HOST)}:${PORT}`);
  console.log(`primitives: ${ids.length ? ids.join(", ") : "none"}`);
  console.log(`session kinds: ${kinds.length ? kinds.join(", ") : "none"}`);
  // Started once the server is actually up: a poller ticking behind a failed
  // listen() would be a child process every five seconds with nobody to tell.
  // Seeded first with the finish times remembered from before the last stop,
  // so the first tick confirms them against the listing rather than stamping
  // every session still sitting done with the time Dante came back.
  for (const [id, at] of endedSeeds(memoryStore)) rosterPoller.noteEnded(id, at);
  rosterPoller.start();
});
