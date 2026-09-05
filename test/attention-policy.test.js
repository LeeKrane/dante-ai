import test from "node:test";
import assert from "node:assert/strict";

import {
  CUE_COOLDOWN_MS, GHOST_MS, WATCH_KINDS, attentionPending, cueFor, isWatchKind, retainAnnouncement, titleFor,
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

test("a second cue within the minute is one too many", () => {
  const recent = { ...audible, lastCueAt: NOW - 1000, speak: { kind: "watch-blocked" } };
  assert.equal(cueFor(recent), false);
  const justOutside = { ...audible, lastCueAt: NOW - CUE_COOLDOWN_MS - 1, speak: { kind: "watch-blocked" } };
  assert.equal(cueFor(justOutside), true);
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
