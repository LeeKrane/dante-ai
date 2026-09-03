import test from "node:test";
import assert from "node:assert/strict";

import { WATCH_KINDS, isWatchKind, retainAnnouncement } from "../public/attention-policy.js";

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
