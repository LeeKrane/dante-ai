import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadFishConfig, loadSupabaseConfig } from "./lib/config.js";
import { createSlack, loadSlackConfig } from "./lib/slack.js";
import { formatEvent, formatRecap, formatSpoken } from "./lib/notify.js";
import { createDeduper, isLoopback, parseHookEvent } from "./lib/hooks.js";
import { buildDecision, inApprovalScope, parseYesNo } from "./lib/approval.js";
import { clarify, describeIntent, findTarget, isAnswerable, needsConfirmation, readAnswer } from "./lib/confirm.js";
import { readSession, summarizeSession } from "./lib/transcript.js";
import { recallableSessions } from "./lib/recall.js";
import { COOKIE, clearCookie, createAuth, parseCookie } from "./lib/auth.js";
import { ask, askResilient, buildPersona, createBrainSession } from "./lib/brain.js";
import { createTurnGate, dropAnswered, mergeTurns } from "./lib/turns.js";
import { createRosterPoller, isWorking, matchSessions, ownRunning, visibleSessions } from "./lib/agents.js";
import { speakStream } from "./lib/tts.js";
import { parseAction } from "./lib/action.js";
import { loadRegistry } from "./lib/registry.js";
import { loadSessionKinds, buildName } from "./lib/sessions.js";
import {
  MAX_SESSIONS, newSessionId, refuseStart, startSession, stopSession, tellSession,
} from "./lib/spawn-session.js";
import { planDelivery, sendToSession } from "./lib/peer.js";
import { describeFailure } from "./lib/outcome.js";
import { run as runBuild } from "./lib/builder.js";
import {
  loadStore, saveStore, getProject, touchProject, recordArtifact, applyMemoryTag,
  addWorkspace, applyWorkspaceTag, workspacePaths, getWorkspace, nextSessionNumber,
  queueForSession, takeQueued, dropQueuesExcept, rememberSession, getSessionRecord, getSessions,
  chainAfter, takeChain, dropChainsExcept, recordEvent, getEvents, clearEvents,
} from "./lib/memory.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const BUILDS = join(HERE, "builds"); // one folder per build, created by lib/builder.js
const BUILDS_URL = "/builds/";
const PORT = Number(process.env.PORT) || 3210;
const WG_IP = "192.168.82.1";

// Only these two spellings of "this machine" are served, and only these two are
// allowed to open the socket. Both lists are built from PORT so moving the
// server does not quietly disable the checks below.
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`, // the hook bridge posts here, and it is the same machine
  `0.0.0.0:${PORT}`,
  `[::1]:${PORT}`,
  `${WG_IP}:${PORT}`
]);

const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://0.0.0.0:${PORT}`,
  `http://${WG_IP}:${PORT}`
]);

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
  filter: (roster) => visibleSessions(roster, {
    roots: Object.values(workspacePaths(memoryStore)),
    hideIds: ownSessionIds(),
    hideRoots: [BUILDS],
  }),

  onEvents: (events, roster) => {
    for (const { kind, session } of events) {
      log(`session ${kind}: ${session.name ?? session.sessionId}`);
      // The moment a session stops working is the moment anything queued for it
      // can be delivered. This is the whole reason the poller runs whether or
      // not a browser is connected.
      if (kind === "idle") deliverQueued(session);
      // The report someone walked away for. Not awaited: a poller tick must
      // not be held open by a Slack round trip and a summary behind it.
      if (kind === "gone") {
        reportComplete(session.sessionId, {
          cwd: session.cwd, name: session.name, startedAt: session.startedAt, roster,
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

// Hand a session everything that was said to it while it was busy, in the order
// it was said. Nothing here speaks: by the time a session goes idle the person
// who queued it may be gone, and Phase C is what will tell them. This is the
// delivery, not the report.
async function deliverQueued(record) {
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
}

// One exit, reported once, whichever mechanism noticed it.
//
// Both do. The roster poller is the floor -- it works for sessions started
// before Dante existed and needs nothing installed -- and the Stop and
// SessionEnd hooks are the fast path, firing the moment it happens. They are
// not alternatives, so the deduper is what keeps one exit from becoming two
// lines in the thread.
const reported = createDeduper();

// Where a session's events go. Its own thread if it has one; the channel if
// Slack was down or unconfigured when it started, because an event with
// nowhere to thread is still worth more than nothing.
async function postForSession(sessionId, line) {
  if (!line) return;
  const remembered = getSessionRecord(memoryStore, sessionId);
  if (remembered?.slackTs) await slack.postReply(remembered.slackTs, line);
  else await slack.postParent(line);
}

// Only sessions Dante started are reported. The roster sees every terminal on
// this machine, and posting to Slack every time somebody closes one would make
// the channel worthless within a day.
async function reportComplete(sessionId, context = {}) {
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
    durationMs: Number.isFinite(startedAt) ? Date.now() - startedAt : undefined,
    summary,
    detail: remembered.stoppedAt ? "stopped from here" : "",
  });

  // Recorded with the same words Slack gets -- whichever of summary or the
  // "stopped from here" note formatEvent actually chose to say -- so a recap
  // and the Slack thread can never disagree about what happened here.
  recordEvent(memoryStore, {
    kind: "complete",
    name: remembered.name ?? context.name,
    detail: summary || (remembered.stoppedAt ? "stopped from here" : ""),
  });
  saveStore(memoryStore);

  log(`session complete: ${line}`);
  // Slack first, unconditionally. The spoken form is shorter and only reaches
  // anyone if a page is open and the floor comes free before it goes stale.
  await postForSession(sessionId, line);
  announce(formatSpoken({
    kind: "complete",
    name: remembered.name ?? context.name,
    durationMs: Number.isFinite(startedAt) ? Date.now() - startedAt : undefined,
    summary,
  }));

  await dispatchChain(sessionId, remembered, chain, context.roster);
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
    await postForSession(
      sessionId,
      `I could not start the next session, sir -- I no longer know a workspace called ${chain.alias}.`,
    );
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
    await postForSession(sessionId, `I could not start the next session, sir. ${refusal}`);
    return;
  }

  const started = await beginSession({
    workspace, task: chain.task, kind: null, taken: live, then: null, depth: chain.depth + 1,
  });
  if (!started.ok) {
    // beginSession has already posted its own "failed" parent to Slack -- there
    // is no thread yet to reply into, the same reason a failed spoken start
    // gets one there and not a reply here.
    log(`chained session start failed name=${started.name} ${started.error}`);
    return;
  }

  log(`chain started: ${sessionId} -> ${started.name}`);
  // beginSession already opened the session's own Slack thread with a
  // "started" parent; this is the voice half of the same announcement, for
  // whoever still has a page open.
  announce(formatSpoken({ kind: "started", name: started.name }));
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
  await postForSession(event.sessionId, line);
  announce(formatSpoken({ kind: "needs-attention", name: remembered.name, detail: event.detail }));
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

  // Nobody to ask, or somebody already being asked. Slack still hears about it,
  // because a session waiting on a person is the thing you most want to know.
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
      // sort of thing to find in Slack afterwards.
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
// running twenty sessions does.
const MAX_ROSTER_ROWS = 8;

function rosterForClient(roster, aliases) {
  if (!Array.isArray(roster)) return [];
  const byPath = Object.entries(aliases ?? {});
  return roster.slice(0, MAX_ROSTER_ROWS).map((record) => ({
    sessionId: record.sessionId,
    name: record.name,
    // The alias rather than the path: a repository is called "jarvis" out loud,
    // and a page has no business being told where it lives on disk.
    alias: byPath.find(([, path]) => record.cwd === path || record.cwd?.startsWith(`${path}/`))?.[0] ?? "",
    state: record.state,
    status: record.status,
    startedAt: record.startedAt,
  }));
}

function sendRoster(send, roster) {
  send({ type: "roster", sessions: rosterForClient(roster, workspacePaths(memoryStore)) });
}

function broadcastRoster(roster) {
  for (const ws of sessions.keys()) {
    if (ws.readyState === 1) sendRoster((o) => ws.send(JSON.stringify(o)), roster);
  }
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

// Lines nobody asked for. Slack always gets them and is the durable channel;
// speaking one is the convenience, and a convenience does not get to interrupt.
//
// The timing decision is the browser's, because the floor is a client fact --
// only the page knows whether the mic is open or a clip is audible. So this
// offers the announcement, the page says when, and the text stays here until
// then rather than crossing the wire twice.
const MAX_PENDING_ANNOUNCEMENTS = 10;
const ANNOUNCEMENT_TTL_MS = 5 * 60 * 1000;
let announceSeq = 0;
const pendingAnnouncements = new Map();

function announce(text) {
  const line = typeof text === "string" ? text.trim() : "";
  // No page open is not a failure. It already went to Slack, which is the whole
  // reason Slack is unconditional.
  if (!line || !voice) return false;

  const now = Date.now();
  for (const [id, held] of pendingAnnouncements) {
    if (now - held.at >= ANNOUNCEMENT_TTL_MS) pendingAnnouncements.delete(id);
  }
  const id = `announce-${++announceSeq}`;
  pendingAnnouncements.set(id, { text: line, at: now });
  // Oldest out first, so a page that never asks for any of them cannot make
  // this grow for the life of the process.
  while (pendingAnnouncements.size > MAX_PENDING_ANNOUNCEMENTS) {
    pendingAnnouncements.delete(pendingAnnouncements.keys().next().value);
  }

  voice({ type: "announce", id, text: line });
  return true;
}

// The page has the floor free and is asking for one it was offered. Unknown or
// expired ids are ignored in silence: the page is entitled to ask late, and a
// dropped announcement is not worth a spoken apology.
async function speakAnnouncement(send, id) {
  const held = pendingAnnouncements.get(id);
  if (!held) return;
  pendingAnnouncements.delete(id);
  if (Date.now() - held.at >= ANNOUNCEMENT_TTL_MS) return;
  log(`announced: ${held.text}`);
  await say(send, held.text);
}

// A recap ("what happened while I was out") just spoke every one of these out
// loud in one paragraph, so leaving any of them queued means saying it again
// the next time the floor is free -- worse than saying nothing. Both halves
// are cleared: this server's own pending map, and every connected page's own
// queue, which it holds client-side and does not otherwise hear about.
function clearPendingAnnouncements() {
  const cleared = pendingAnnouncements.size;
  pendingAnnouncements.clear();
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

// The session equivalent of propose(), for the four verbs that always need a
// yes (see lib/confirm.js's CONFIRMED_VERBS). Unlike propose(), this never
// falls through to an unconfirmed dispatch: a tell, interrupt or stop that
// cannot be described is a missing detail, not a green light, so the missing
// detail is asked for instead.
async function proposeSession(send, conv, session, roster) {
  const verb = typeof session.verb === "string" ? session.verb.toLowerCase() : "";
  let target = null;
  if (verb === "tell" || verb === "interrupt" || verb === "stop") {
    // Resolved before it is ever proposed: a yes to a session that does not
    // exist is a false confirmation, and asking "shall I stop jarvis-1, sir?"
    // only to say "I cannot find jarvis-1 running" after the yes is worse than
    // saying so up front.
    const { record, refusal } = findTarget(roster, session.name ?? session.repo);
    if (refusal) {
      log(`session refused before proposing: ${refusal}`);
      await say(send, refusal);
      return;
    }
    target = record;
  }

  const spoken = describeIntent({ session, workspace: getWorkspace(memoryStore, session.repo), target });
  if (!spoken) {
    // These four never run unconfirmed. An undescribable tag here is a missing
    // detail (a tell with no task, a stop with nothing to name), and the fix is
    // to ask for the detail, never to dispatch and let the dispatcher explain.
    const question = clarify({ session, target });
    log(`session clarified rather than proposed: ${question}`);
    await say(send, question);
    return;
  }

  conv.proposal = {
    // The resolved roster name is what the dispatcher looks up after the yes,
    // so it resolves exactly and, if the session has since gone, says so by
    // that same name rather than the one the model happened to write.
    run: async () =>
      dispatchSession(
        send,
        { ...session, ...(target ? { name: target.name } : {}) },
        "",
        // Read again on the way in: the roster that produced the proposal is
        // however many seconds old the answer took to arrive, and a stop
        // resolves a name against a real process.
        await rosterPoller.read(),
      ),
    spoken,
    at: Date.now(),
  };
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
    log("proposal expired");
    return false;
  }

  const answer = readAnswer(text);
  // A correction is not an answer. The proposal is dropped and the sentence
  // goes on to be an ordinary turn -- the warm CLI still holds its own proposal
  // in context, so "no, the whole repo" re-proposes correctly by itself.
  if (answer === "amend") {
    conv.proposal = null;
    log(`proposal amended: ${JSON.stringify(text)}`);
    return false;
  }

  conv.proposal = null;
  if (answer === "no") {
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

// What earlier runs left behind. One server serves one project, so the whole
// store is keyed by the directory it was started in. Read once here; every
// write below goes through saveStore, which is atomic.
const memoryStore = loadStore();
const PROJECT_KEY = process.cwd();

// The directory the server was started in is a workspace by definition -- it is
// the repository the person is standing in -- so it is registered here rather
// than waiting to be named out loud. Idempotent: re-registering a path already
// known returns the existing alias and leaves its session counter alone, which
// is what stops a week of restarts producing jarvis, jarvis-2, jarvis-3.
if (addWorkspace(memoryStore, PROJECT_KEY)) saveStore(memoryStore);

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
let persona = buildPersona(registry, getProject(memoryStore, PROJECT_KEY), sessionKinds);

function refreshPersona() {
  persona = buildPersona(registry, getProject(memoryStore, PROJECT_KEY), sessionKinds);
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

const log = (...a) => console.log(new Date().toISOString(), ...a);

// The durable channel. Unconfigured it is a working object whose posts return
// null, so nothing below has to ask whether Slack exists -- and a missing
// config file is not a startup error, because an assistant without Slack is
// still an assistant.
const slackCfg = loadSlackConfig();
const slack = createSlack(slackCfg, { log });

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
  // instruction. A payload reaches lib/notify.js and Slack, and never a model
  // prompt. Anything unexpected is dropped in silence rather than answered
  // with a complaint, because a complaint is a channel too.
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
    const work = event.kind === "complete"
      ? reportComplete(event.sessionId, { cwd: event.cwd, roster: rosterPoller.current() })
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
// wiring that speaks the refusal when there is one.
async function resolveSession(send, roster, query, preamble) {
  const { record, refusal } = findTarget(roster, query);
  if (refusal) {
    await say(send, joinSpoken(preamble, refusal));
    return null;
  }
  return record;
}

// Ask a session to stop, and confirm it did before saying so.
async function dispatchStop(send, session, preamble, roster) {
  const record = await resolveSession(send, roster, session.name ?? session.repo, preamble);
  if (!record) return;

  send({ type: "state", value: "thinking" });
  const result = await stopSession(record);
  if (!result.ok) {
    log(`stop ${record.name} failed: ${result.error}`);
    await say(send, joinSpoken(preamble, `I could not stop ${record.name}, sir. ${result.error}.`));
    return;
  }

  // Anything still waiting for it can never be delivered now.
  takeQueued(memoryStore, record.sessionId);
  // Noted so the report when it leaves the roster says it was stopped rather
  // than that it finished -- which are different things to read at midnight.
  // Only for sessions Dante started: writing a record here for a terminal
  // somebody was sitting at would turn "Dante stopped it" into a Slack post
  // about a session Slack has never heard of.
  if (getSessionRecord(memoryStore, record.sessionId)) {
    rememberSession(memoryStore, record.sessionId, { stoppedAt: Date.now() });
  }
  saveStore(memoryStore);
  log(`stopped ${record.name}${result.alreadyGone ? " (already gone)" : ""}`);
  await say(
    send,
    joinSpoken(preamble, result.alreadyGone ? `${record.name} had already finished, sir.` : `${record.name} is stopped, sir.`),
  );
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
  const record = await resolveSession(send, roster, session.name ?? session.repo, preamble);
  if (!record) return;

  const text = session.task ?? session.text ?? session.message;
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
  const delivered = await sendToSession({
    pid: record.pid,
    sessionId: record.sessionId,
    text: plan.content,
    priority: plan.priority,
  });
  if (delivered.ok) {
    log(`${verb === "interrupt" ? "interrupted" : "told"} ${record.name} over the peer channel`);
    // "has it" is as far as this can honestly go: sendToSession resolving ok
    // means the frame reached the session's socket, not that the model has
    // read it, acted on it, or replied -- the CLI sends no acknowledgement for
    // a user frame at all.
    await say(
      send,
      joinSpoken(
        preamble,
        verb === "interrupt" ? `${record.name} is interrupted and has it, sir.` : `${record.name} has it, sir.`,
      ),
    );
    return;
  }
  log(`peer send to ${record.name} failed: ${delivered.error}`);

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
    // Said plainly, because "queued" and "told" are different promises and the
    // difference is minutes.
    await say(send, joinSpoken(preamble, `${record.name} is busy, sir. I will pass it on when it stops.`));
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
  await say(send, joinSpoken(preamble, result.reply || `${record.name} has it, sir.`));
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
// produces goes to Slack and into the recap log (recordEvent, a short list that
// a recap reads once and clears), and this never consults it: a deleted session
// is simply not readable, with no cached answer standing in for it.
async function dispatchRead(send, session, preamble, roster) {
  const candidates = recallable(roster);
  // Deliberately not resolveSession: that one resolves against the live roster,
  // and every session this is for has left it. The matcher is the same
  // (matchSessions works on anything carrying a name), so "jarvis three" finds
  // jarvis-3-fix-failing-builder-test here exactly as it does for a stop.
  const matches = matchSessions(candidates, session.name ?? session.repo);
  if (matches.length === 0) {
    await say(send, joinSpoken(preamble, "I have nothing readable by that name, sir."));
    return;
  }
  if (matches.length > 1) {
    // Never the first of several. Reading the wrong session's work back is a
    // quieter mistake than stopping the wrong process, but it is still an answer
    // about work that was never done.
    const names = matches.slice(0, 3).map((record) => record.name).join(", ");
    await say(send, joinSpoken(preamble, `Which one, sir? ${names}.`));
    return;
  }

  const record = matches[0];
  const question = session.question ?? session.task ?? session.text ?? session.message;

  send({ type: "state", value: "thinking" });
  const { text, reason } = await readSession({
    cwd: record.cwd, sessionId: record.sessionId, task: record.task, question,
  });

  if (!text) {
    log(`read ${record.name} failed: ${reason}`);
    await say(send, joinSpoken(
      preamble,
      reason === "no-transcript"
        ? `${record.name} left nothing I can read, sir.`
        : `I could not read ${record.name} back, sir.`,
    ));
    return;
  }

  log(`read ${record.name} (${text.length} chars)`);
  // Said plainly when the session is still going, because "it decided X" and
  // "it has decided X so far" are different facts and the difference is whether
  // to act on it. `running` is null when the listing failed, and then nothing is
  // claimed either way rather than something being guessed.
  await say(send, joinSpoken(
    preamble,
    record.running === true ? `${record.name} is still working, sir. So far: ${text}` : text,
  ));
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
async function dispatchSession(send, session, preamble = "", roster = null) {
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
    await dispatchRead(send, session, preamble, roster);
    return;
  }
  if (session.verb !== "start") {
    // Saying so is better than silence: the tag was stripped, so otherwise
    // nothing would happen and nothing would explain why.
    await say(send, joinSpoken(preamble, "I can start a session, talk to one, interrupt one, stop one, read one back, or catch you up, sir."));
    return;
  }

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

  const started = await beginSession({ workspace, task: session.task, kind: session.kind, taken: live, then: session.then });

  if (!started.ok) {
    log(`session start failed name=${started.name} ${started.error}`);
    send({ type: "debug", stage: "session", msg: `start failed: ${started.error}` });
    await say(send, joinSpoken(preamble, `That session would not start, sir. ${started.error}.`));
    return;
  }

  send({ type: "debug", stage: "session", msg: `started ${started.name}` });
  // The preamble is the model's own confirmation, which is usually the whole
  // sentence. The name is added because it is how every later command refers to
  // this session, and hearing it once is what makes "stop jarvis three" possible.
  await say(send, joinSpoken(preamble, `Running as ${started.name}.`));
}

// Everything about starting a session that has nothing to do with a browser:
// naming it, spawning it, remembering it, opening its Slack thread.
//
// Split out because a chained session is started by a poller tick with no
// socket in sight, and it must be started exactly the way a spoken one is --
// same numbering, same naming, same thread. A second implementation would drift
// on the first change to either.
async function beginSession({ workspace, task, kind: kindId, taken = [], then = null, depth = 0 }) {
  const kind = sessionKinds.get(kindId) ?? null;
  // Reserved before the spawn, not after: two requests in flight must not be
  // handed the same number, and a number burned by a failed start is cheaper
  // than two sessions called jarvis-3.
  const number = nextSessionNumber(memoryStore, workspace.alias);
  saveStore(memoryStore);

  const name = buildName(
    { alias: workspace.alias, number, task, hint: kind?.nameHint?.({ task }) },
    (Array.isArray(taken) ? taken : []).map((r) => r.name),
  );
  const sessionId = newSessionId();

  const started = await startSession({
    name,
    sessionId,
    cwd: workspace.path,
    task,
    systemPrompt: kind?.systemPrompt?.({ task, alias: workspace.alias }),
    model: kind?.model,
    effort: kind?.effort,
  });

  if (!started.ok) {
    recordEvent(memoryStore, { kind: "failed", name, detail: started.error });
    saveStore(memoryStore);
    // Its own parent message, not a reply: there is no thread, because there
    // was never a session to start one.
    slack.postParent(formatEvent({ kind: "failed", name, detail: started.error }));
    return { ok: false, name, error: started.error };
  }

  // Its own bucket, not the artifacts list: artifacts answer "what did we build
  // lately", and ten sessions would push every build out of that answer.
  rememberSession(memoryStore, sessionId, {
    name, alias: workspace.alias, cwd: workspace.path, task, kind: kindId ?? null,
  });
  // What to do once it finishes, if anything was asked for. Recorded now rather
  // than looked up later: by the time it ends, the turn that asked is long over.
  if (then) chainAfter(memoryStore, sessionId, { task: then, alias: workspace.alias, depth });
  recordEvent(memoryStore, { kind: "started", name, detail: task });
  saveStore(memoryStore);
  log(`session started name=${name} id=${sessionId} cwd=${workspace.path}${then ? " then=" + JSON.stringify(then) : ""}`);

  // Not awaited. A Slack round trip is up to five seconds and the confirmation
  // is the answer to something someone just said out loud; making them wait on
  // a notification would be exactly backwards. The thread id lands in memory
  // whenever it arrives, and every later event for this session looks it up
  // there.
  slack.postParent(formatEvent({ kind: "started", name, task })).then((ts) => {
    if (!ts) return;
    rememberSession(memoryStore, sessionId, { slackTs: ts });
    saveStore(memoryStore);
  });

  return { ok: true, name, sessionId };
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
}

// ---------------------------------------------------------------------------
// End-of-session summary
// ---------------------------------------------------------------------------

// Its own bookkeeping voice, deliberately not the DANTE persona: the spoken
// rules -- forty words, no lists, address Jesse as sir -- would shape a note
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
  const conv = { pending: null, proposal: null, turns: 0, unanswered: [], abort: null, settled: Promise.resolve() };
  const gate = createTurnGate();

  // Read fresh from the store rather than from a boot-time snapshot: a second
  // tab opened mid-conversation has to join the session that is current now, not
  // the one that existed when the server started.
  const remembered = getProject(memoryStore, PROJECT_KEY)?.sessionId;
  if (remembered) sessions.set(ws, remembered);

  // The newest page is the one that gets asked. A tab that never speaks is
  // still a room with someone in it.
  voice = send;

  log("client connected");
  // The first poller tick is a baseline and fires no events, so a page opened
  // after it would sit empty until something changed.
  sendRoster(send, rosterPoller.current());
  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    // The page reporting that the floor is free and it will take one of the
    // announcements it was offered. Handled before the "say" guard because it
    // carries no text at all.
    if (msg.type === "announce_ready") {
      if (typeof msg.id === "string") await speakAnnouncement(send, msg.id);
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

      // Read in the same tick as the list itself, so it counts exactly the
      // sentences this call was asked about and nothing that arrives behind it.
      // The recallable list rides along for the same reason the roster does: a
      // finished session appears in no listing, so without it the model has
      // never heard the name it is being asked about.
      const asked = mergeTurns(conv.unanswered, {
        roster, recalled: recallable(roster), aliases: workspacePaths(memoryStore),
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
      const { reply, action, memory, session } = parseAction(spoken);

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
          log(`workspace set ${JSON.stringify(workspaces)}`);
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
          await dispatchSession(send, session, reply, roster);
        }
      } else if (action) {
        dropAnswered(conv.unanswered, answering);
        const held = await propose(send, conv, { action, primitive: registry.get(action.primitive) },
          () => dispatchAction(send, conv, action, ""));
        if (!held) await dispatchAction(send, conv, action, reply);
      } else if (reply) {
        if (await say(send, reply, undefined, () => gate.isCurrent(token))) {
          dropAnswered(conv.unanswered, answering);
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
    }
  });
  ws.on("close", () => {
    // Read before the delete: this map is the only handle on the id, and the
    // summary below still needs it.
    const sessionId = sessions.get(ws);
    sessions.delete(ws);
    conv.pending = null;
    conv.proposal = null;
    // A question already asked is left to time out rather than answered by a
    // closing tab. Nothing is decided by a page going away.
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

// Loopback only. This process runs a model with file-writing tools on and then
// serves what it wrote, which is not something to expose to the local network.
server.listen(PORT, "0.0.0.0", () => {
  const ids = [...registry.keys()];
  const kinds = [...sessionKinds.keys()];
  console.log(`Dante on http://0.0.0.0:${PORT}`);
  console.log(`primitives: ${ids.length ? ids.join(", ") : "none"}`);
  console.log(`session kinds: ${kinds.length ? kinds.join(", ") : "none"}`);
  console.log(`slack: ${slack.enabled ? `on (${slackCfg.channel})` : "off"}`);
  // Started once the server is actually up: a poller ticking behind a failed
  // listen() would be a child process every five seconds with nobody to tell.
  rosterPoller.start();
});
