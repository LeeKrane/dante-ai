import test from "node:test";
import assert from "node:assert/strict";
import { getVisibilityToggle, hiddenPanelHints } from "../public/visibility-policy.js";

test("maps visibility keys when push-to-talk is inactive", () => {
  assert.equal(getVisibilityToggle("t", false), "caption");
  assert.equal(getVisibilityToggle("T", false), "caption");
  assert.equal(getVisibilityToggle("h", false), "interface");
  assert.equal(getVisibilityToggle("d", false), "diagnostics");
  assert.equal(getVisibilityToggle("s", false), "sessions");
  assert.equal(getVisibilityToggle("x", false), null);
});

test("suppresses visibility toggles while push-to-talk is held", () => {
  assert.equal(getVisibilityToggle("t", true), null);
  assert.equal(getVisibilityToggle("h", true), null);
  assert.equal(getVisibilityToggle("d", true), null);
  assert.equal(getVisibilityToggle("s", true), null);
});

test("names every panel that is off, key first, in key order", () => {
  assert.deepEqual(
    hiddenPanelHints({ caption: false, interface: false, diagnostics: false, sessions: false }),
    [
      { key: "t", target: "caption", label: "caption" },
      { key: "h", target: "interface", label: "interface" },
      { key: "d", target: "diagnostics", label: "diagnostics" },
      { key: "s", target: "sessions", label: "sessions" },
    ],
  );
});

test("says nothing when everything is on", () => {
  assert.deepEqual(
    hiddenPanelHints({ caption: true, interface: true, diagnostics: true, sessions: true }),
    [],
  );
});

test("an unstated panel counts as off", () => {
  const allOff = [
    { key: "t", target: "caption", label: "caption" },
    { key: "h", target: "interface", label: "interface" },
    { key: "d", target: "diagnostics", label: "diagnostics" },
    { key: "s", target: "sessions", label: "sessions" },
  ];
  assert.deepEqual(hiddenPanelHints({}), allOff);
  assert.deepEqual(hiddenPanelHints(), allOff);
});
