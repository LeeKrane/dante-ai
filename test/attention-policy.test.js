import test from "node:test";
import assert from "node:assert/strict";

import {
  CUE_COOLDOWN_MS, GHOST_MS, WATCH_KINDS, attentionPending, cueFor, isWatchKind, notifyFor, offerNotifyControl,
  owesCue, retainAnnouncement, titleFor,
} from "../public/attention-policy.js";
import { GHOST_MS as SERVER_GHOST_MS } from "../lib/watch.js";

const NOW = 1_800_000_000_000;
const TTL = 120_000;

test("a blocked report never goes stale, because nothing else will say it", () => {
  assert.equal(retainAnnouncement({ kind: "watch-blocked", at: NOW - TTL * 10 }, NOW, TTL), true);
  assert.equal(retainAnnouncement({ kind: "watch-blocked" }, NOW, TTL), true);
});

test("every other announcement keeps the two-minute rule", () => {
  assert.equal(retainAnnouncement({ kind: "watch-idle", at: NOW - TTL - 1 }, NOW, TTL), false);
  assert.equal(retainAnnouncement({ kind: "watch-gone", at: NOW - TTL - 1 }, NOW, TTL), false);
  assert.equal(retainAnnouncement({ kind: "other", at: NOW - TTL - 1 }, NOW, TTL), false);
  assert.equal(retainAnnouncement({ kind: "other", at: NOW - 1 }, NOW, TTL), true);
});

test("an unrecognised kind is an ordinary announcement, not a never-stale one", () => {
  assert.equal(retainAnnouncement({ kind: "something-new", at: NOW - TTL - 1 }, NOW, TTL), false);
  assert.equal(isWatchKind("something-new"), false);
  assert.equal(isWatchKind("watch-blocked"), true);
  assert.equal(WATCH_KINDS.has("other"), false);
});

test("the ghost window agrees with the server's own copy of it", () => {
  // public/ cannot import from lib/, so this local copy has to be kept in
  // step by hand -- the same reason roster-panel.js's own MAX_ROWS is pinned
  // against lib/agents.js's MAX_LISTED in test/roster-panel.test.js.
  assert.equal(GHOST_MS, SERVER_GHOST_MS);
});

// --- cueFor --------------------------------------------------------------

const audible = { audioReady: true, now: NOW, lastCueAt: null };

test("a blocked report is worth a sound and an ordinary one is not", () => {
  assert.equal(cueFor({ ...audible, speak: { kind: "watch-blocked" }, stale: [] }), true);
  assert.equal(cueFor({ ...audible, speak: { kind: "other" }, stale: [] }), false);
});

test("dropped words still get their tone, because the tone is all that is left", () => {
  assert.equal(cueFor({ ...audible, speak: null, stale: [{ kind: "watch-idle" }] }), true);
  assert.equal(cueFor({ ...audible, speak: null, stale: [{ kind: "watch-gone" }] }), true);
  assert.equal(cueFor({ ...audible, speak: null, stale: [{ kind: "other" }] }), false);
  assert.equal(cueFor({ ...audible, speak: null, stale: [] }), false);
});

test("a page never allowed to make a sound makes none", () => {
  assert.equal(cueFor({ ...audible, audioReady: false, speak: { kind: "watch-blocked" } }), false);
});

test("a re-offered line another tab may also hold does not chime twice", () => {
  // speak.cue === false is the connect-time re-offer's own flag (server.js's
  // connect handler, carried onto the queued item by app.js's
  // receiveAnnouncement) -- it means another socket was open when this page
  // reconnected and may already hold, and have chimed for, this exact entry.
  assert.equal(cueFor({ ...audible, speak: { kind: "watch-blocked", cue: false }, stale: [] }), false);
  // Without the flag (an ordinary fresh blocked report, or a re-offer with
  // nothing else open to have chimed for it already) the cue still rings.
  assert.equal(cueFor({ ...audible, speak: { kind: "watch-blocked", cue: true }, stale: [] }), true);
  assert.equal(cueFor({ ...audible, speak: { kind: "watch-blocked" }, stale: [] }), true);
  // A false cue on `speak` only takes `speak` itself out of the running --
  // stale and owed still ring on their own merits.
  assert.equal(cueFor({ ...audible, speak: { kind: "watch-blocked", cue: false }, stale: [{ kind: "watch-idle" }] }), true);
  assert.equal(cueFor({ ...audible, speak: { kind: "watch-blocked", cue: false }, stale: [], owed: true }), true);
});

test("a second cue within the minute is one too many", () => {
  const recent = { ...audible, lastCueAt: NOW - 1000, speak: { kind: "watch-blocked" } };
  assert.equal(cueFor(recent), false);
  const justOutside = { ...audible, lastCueAt: NOW - CUE_COOLDOWN_MS - 1, speak: { kind: "watch-blocked" } };
  assert.equal(cueFor(justOutside), true);
});

// --- owesCue ---------------------------------------------------------------

test("a watch line swept while the floor is busy still owes its tone", () => {
  assert.equal(owesCue([{ kind: "watch-idle" }]), true);
  assert.equal(owesCue([{ kind: "watch-gone" }]), true);
  assert.equal(owesCue([{ kind: "other" }]), false);
  assert.equal(owesCue([]), false);
  assert.equal(owesCue(null), false);
});

test("an owed cue rings even when nothing was swept or spoken on this pump", () => {
  assert.equal(cueFor({ ...audible, speak: null, stale: [], owed: true }), true);
  assert.equal(cueFor({ ...audible, speak: null, stale: [], owed: false }), false);
});

// --- attentionPending ------------------------------------------------------

test("a queue with nothing watched leaves the orb alone", () => {
  assert.equal(attentionPending([]), false);
  assert.equal(attentionPending([{ kind: "other" }]), false);
  assert.equal(attentionPending([{ kind: "other" }, { kind: "watch-idle" }]), true);
  assert.equal(attentionPending(null), false);
});

// --- titleFor ----------------------------------------------------------

test("the tab says something only while nobody is looking", () => {
  assert.equal(titleFor("Dante", true, true), "• Dante");
  assert.equal(titleFor("Dante", true, false), "Dante");
  assert.equal(titleFor("Dante", false, true), "Dante");
  assert.equal(titleFor("Dante", false, false), "Dante");
});

// --- notifyFor ---------------------------------------------------------

test("a blocked watcher's report reaches a tab nobody is looking at", () => {
  assert.equal(notifyFor({ kind: "watch-blocked", hidden: true, permission: "granted" }), true);
});

test("nothing is posted to a tab already in front of someone", () => {
  assert.equal(notifyFor({ kind: "watch-blocked", hidden: false, permission: "granted" }), false);
});

test("permission never asked for, or refused, means nothing is posted", () => {
  assert.equal(notifyFor({ kind: "watch-blocked", hidden: true, permission: "default" }), false);
  assert.equal(notifyFor({ kind: "watch-blocked", hidden: true, permission: "denied" }), false);
  assert.equal(notifyFor({ kind: "watch-blocked", hidden: true, permission: undefined }), false);
});

test("an ordinary announcement never becomes a notification", () => {
  assert.equal(notifyFor({ kind: "watch-idle", hidden: true, permission: "granted" }), false);
  assert.equal(notifyFor({ kind: "watch-gone", hidden: true, permission: "granted" }), false);
  assert.equal(notifyFor({ kind: "other", hidden: true, permission: "granted" }), false);
});

// --- offerNotifyControl -------------------------------------------------

test("the control is offered only when something is actually watched", () => {
  assert.equal(offerNotifyControl({ watchedCount: 0, permission: "default", supported: true }), false);
  assert.equal(offerNotifyControl({ watchedCount: 1, permission: "default", supported: true }), true);
});

test("the control is offered only while permission has never been decided", () => {
  assert.equal(offerNotifyControl({ watchedCount: 1, permission: "granted", supported: true }), false);
  assert.equal(offerNotifyControl({ watchedCount: 1, permission: "denied", supported: true }), false);
});

test("the control is never offered where Notification does not exist", () => {
  assert.equal(offerNotifyControl({ watchedCount: 1, permission: "default", supported: false }), false);
});
