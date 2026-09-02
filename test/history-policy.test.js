import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_CAP,
  append,
  createHistory,
  formatTime,
  historyStep,
  snapToNewest,
  stepNewer,
  stepOlder,
  view,
} from "../public/history-policy.js";

const AT = 1_700_000_000_000;

function said(...lines) {
  let state = createHistory();
  for (const [who, text, extra] of lines) state = append(state, { who, text, at: AT, ...extra });
  return state;
}

function shown(state) {
  return view(state).entry?.text ?? null;
}

test("an empty history views as live with no entry and neither button", () => {
  assert.deepEqual(view(createHistory()), { live: true, entry: null, canOlder: false, canNewer: false, index: 0, total: 0 });
});

test("appending while live keeps the view live and shows the new entry", () => {
  const state = said(["you", "hello"], ["dante", "good evening"]);
  assert.deepEqual(view(state), {
    live: true,
    entry: { who: "dante", text: "good evening", at: AT },
    canOlder: true,
    canNewer: false,
    index: 2,
    total: 2,
  });
});

test("appending a plain reply while stepped back leaves the cursor where it was and lights newer", () => {
  let state = stepOlder(said(["you", "one"], ["dante", "two"]));
  state = append(state, { who: "dante", text: "three", at: AT });
  assert.deepEqual(view(state), {
    live: false,
    entry: { who: "you", text: "one", at: AT },
    canOlder: false,
    canNewer: true,
    index: 1,
    total: 3,
  });
});

test("appending an ask while stepped back snaps to newest", () => {
  let state = stepOlder(said(["you", "one"], ["dante", "two"]));
  state = append(state, { who: "dante", text: "which folder, sir?", at: AT, demandsAttention: true });
  assert.equal(view(state).live, true);
  assert.equal(shown(state), "which folder, sir?");
});

test("appending an error while stepped back snaps to newest", () => {
  let state = stepOlder(said(["you", "one"], ["dante", "two"]));
  state = append(state, { who: "error", text: "No transcript captured", at: AT, demandsAttention: true });
  assert.equal(view(state).live, true);
  assert.equal(shown(state), "No transcript captured");
});

test("an empty or non-string text is not recorded", () => {
  const state = said(["you", "one"]);
  assert.equal(append(state, { who: "dante", text: "", at: AT }), state);
  assert.equal(append(state, { who: "dante", text: "   ", at: AT }), state);
  assert.equal(append(state, { who: "dante", text: undefined, at: AT }), state);
  assert.equal(append(state, { who: "dante", text: 42, at: AT }), state);
  assert.equal(append(state), state);
});

test("stepping older from live shows the entry before the newest", () => {
  const state = stepOlder(said(["you", "one"], ["dante", "two"], ["you", "three"]));
  assert.equal(shown(state), "two");
  assert.deepEqual(view(state), {
    live: false,
    entry: { who: "dante", text: "two", at: AT },
    canOlder: true,
    canNewer: true,
    index: 2,
    total: 3,
  });
});

test("stepping older stops at the oldest entry", () => {
  let state = said(["you", "one"], ["dante", "two"], ["you", "three"]);
  state = stepOlder(stepOlder(state));
  assert.equal(shown(state), "one");
  assert.equal(view(state).canOlder, false);
  assert.equal(stepOlder(state), state);
});

test("stepping newer past the second-newest entry returns to live", () => {
  let state = said(["you", "one"], ["dante", "two"], ["you", "three"]);
  state = stepOlder(stepOlder(state));
  state = stepNewer(state);
  assert.equal(shown(state), "two");
  assert.equal(view(state).live, false);
  state = stepNewer(state);
  assert.equal(shown(state), "three");
  assert.equal(view(state).live, true);
  assert.equal(view(state).canNewer, false);
});

test("stepping newer while live is a no-op", () => {
  const state = said(["you", "one"], ["dante", "two"]);
  assert.equal(stepNewer(state), state);
});

test("snapping to newest from a stepped-back view returns to live, and is a no-op when already live", () => {
  const live = said(["you", "one"], ["dante", "two"]);
  const back = stepOlder(live);
  assert.equal(view(snapToNewest(back)).live, true);
  assert.equal(shown(snapToNewest(back)), "two");
  assert.equal(snapToNewest(live), live);
});

test("a single entry offers neither button", () => {
  const state = said(["dante", "only"]);
  assert.deepEqual(view(state), {
    live: true,
    entry: { who: "dante", text: "only", at: AT },
    canOlder: false,
    canNewer: false,
    index: 1,
    total: 1,
  });
  assert.equal(stepOlder(state), state);
});

test("the cap drops the oldest entry and a cursor keeps pointing at the same text", () => {
  let state = createHistory();
  for (let i = 1; i <= HISTORY_CAP; i++) state = append(state, { who: "you", text: `line ${i}`, at: AT });
  state = stepOlder(stepOlder(state));
  assert.equal(shown(state), `line ${HISTORY_CAP - 2}`);
  state = append(state, { who: "dante", text: "one more", at: AT });
  assert.equal(view(state).total, HISTORY_CAP);
  assert.equal(shown(state), `line ${HISTORY_CAP - 2}`);
  assert.equal(view(state).index, HISTORY_CAP - 3);
  assert.equal(view(snapToNewest(state)).entry.text, "one more");
});

test("a cursor on the oldest entry when the cap drops it moves to the new oldest", () => {
  let state = createHistory();
  for (let i = 1; i <= HISTORY_CAP; i++) state = append(state, { who: "you", text: `line ${i}`, at: AT });
  for (let i = 0; i < HISTORY_CAP; i++) state = stepOlder(state);
  assert.equal(shown(state), "line 1");
  state = append(state, { who: "dante", text: "one more", at: AT });
  assert.equal(shown(state), "line 2");
  assert.equal(view(state).canOlder, false);
});

test("arrow keys map to steps only while the talk key is up", () => {
  assert.equal(historyStep("ArrowLeft", false), "older");
  assert.equal(historyStep("ArrowRight", false), "newer");
  assert.equal(historyStep("ArrowUp", false), null);
  assert.equal(historyStep("t", false), null);
  assert.equal(historyStep("ArrowLeft", true), null);
  assert.equal(historyStep("ArrowRight", true), null);
});

test("formatTime zero-pads hours and minutes", () => {
  const d = new Date(2026, 8, 2, 7, 5);
  assert.equal(formatTime(d.getTime()), "07:05");
  const e = new Date(2026, 8, 2, 23, 59);
  assert.equal(formatTime(e.getTime()), "23:59");
});
