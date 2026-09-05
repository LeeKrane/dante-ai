import test from "node:test";
import assert from "node:assert/strict";

import { ANNOUNCE_KINDS, createPending, neverStale, normalizeKind } from "../lib/announcements.js";

const NOW = 1_800_000_000_000;

test("an announcement is offered once, and taking it removes it so it cannot be offered again", () => {
  let clock = NOW;
  const pending = createPending({ ttlMs: 1000, max: 5, now: () => clock });
  const offered = pending.offer("jarvis-1 finished, sir.");
  assert.equal(typeof offered.id, "string");
  assert.equal(offered.entry.text, "jarvis-1 finished, sir.");

  const taken = pending.take(offered.id, clock);
  assert.equal(taken.text, "jarvis-1 finished, sir.");
  assert.equal(pending.take(offered.id, clock), null);
});

test("an entry older than the hold time is swept before a new one is offered", () => {
  let clock = NOW;
  const pending = createPending({ ttlMs: 1000, max: 5, now: () => clock });
  const old = pending.offer("old news, sir.");
  clock += 2000;
  pending.offer("fresh news, sir.");
  assert.equal(pending.take(old.id, clock), null);
});

test("a blocked report is never swept, however long the page stays busy", () => {
  let clock = NOW;
  const retain = (entry) => entry.kind === "watch-blocked";
  const pending = createPending({ ttlMs: 1000, max: 5, retain, now: () => clock });
  const blocked = pending.offer("jarvis-1 is blocked, sir.", { kind: "watch-blocked" });
  clock += 10 * 60 * 1000; // ten minutes -- ten times the ordinary hold time
  pending.offer("something else entirely, sir.", { kind: "other" });
  assert.notEqual(pending.take(blocked.id, clock), null);
});

test("a blocked report held well past the hold time is still spoken when it is finally asked for", () => {
  let clock = NOW;
  const retain = (entry) => entry.kind === "watch-blocked";
  const pending = createPending({ ttlMs: 1000, max: 5, retain, now: () => clock });
  const blocked = pending.offer("jarvis-1 is blocked, sir.", { kind: "watch-blocked" });
  clock += 10 * 60 * 1000;
  const taken = pending.take(blocked.id, clock);
  assert.equal(taken.text, "jarvis-1 is blocked, sir.");
});

test("the oldest entry is evicted first at the cap, whatever kind it carries", () => {
  // retain() true forever would otherwise keep every one of these alive --
  // proving the cap still evicts one shows retain buys immunity from
  // staleness, not from running out of room.
  const pending = createPending({ ttlMs: 1_000_000, max: 2, retain: () => true, now: () => NOW });
  const a = pending.offer("a", { kind: "watch-blocked" });
  pending.offer("b", { kind: "watch-blocked" });
  pending.offer("c", { kind: "watch-blocked" });
  assert.equal(pending.take(a.id, NOW), null);
});

test("with no cap given the map still stops at ten", () => {
  // No `max` in this options object at all -- proving the default kicks in
  // rather than `entries.size > undefined`, which is always false and would
  // let this grow forever.
  const pending = createPending({ ttlMs: 1_000_000, now: () => NOW });
  const first = pending.offer("0");
  for (let i = 1; i < 15; i++) pending.offer(String(i));
  assert.equal(pending.live(NOW).length, 10);
  assert.equal(pending.take(first.id, NOW), null);
});

test("a recap clears every line and says how many it cleared", () => {
  const pending = createPending({ ttlMs: 1000, max: 5, now: () => NOW });
  pending.offer("a");
  pending.offer("b");
  assert.equal(pending.clear(), 2);
  assert.deepEqual(pending.live(NOW), []);
});

test("an unknown kind is treated as ordinary, not as a watcher's own report", () => {
  assert.equal(normalizeKind("watch-blocked"), "watch-blocked");
  assert.equal(normalizeKind("something-new"), "other");
  assert.equal(normalizeKind(undefined), "other");
  assert.equal(ANNOUNCE_KINDS.has("other"), true);
});

test("neverStale is true only for a watch-blocked entry", () => {
  assert.equal(neverStale({ kind: "watch-blocked" }), true);
  assert.equal(neverStale({ kind: "watch-idle" }), false);
  assert.equal(neverStale({ kind: "other" }), false);
  assert.equal(neverStale(null), false);
});

test("a meta that carries its own id cannot displace the generated one", () => {
  const pending = createPending({ ttlMs: 1000, max: 5, now: () => NOW });
  const offered = pending.offer("jarvis-1 finished, sir.", { id: "not-the-real-id", kind: "other" });
  assert.equal(offered.entry.id, offered.id);
  assert.notEqual(offered.entry.id, "not-the-real-id");
});
