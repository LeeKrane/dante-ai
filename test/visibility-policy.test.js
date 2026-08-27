import test from "node:test";
import assert from "node:assert/strict";
import { getVisibilityToggle, panelToggles } from "../public/visibility-policy.js";

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

test("lists every panel in key order, saying which is on", () => {
  assert.deepEqual(
    panelToggles({ caption: true, interface: true, diagnostics: false, sessions: true }),
    [
      { key: "t", target: "caption", label: "caption", on: true },
      { key: "h", target: "interface", label: "interface", on: true },
      { key: "d", target: "diagnostics", label: "diagnostics", on: false },
      { key: "s", target: "sessions", label: "sessions", on: true },
    ],
  );
});

test("an unstated panel counts as off", () => {
  const allOff = [
    { key: "t", target: "caption", label: "caption", on: false },
    { key: "h", target: "interface", label: "interface", on: false },
    { key: "d", target: "diagnostics", label: "diagnostics", on: false },
    { key: "s", target: "sessions", label: "sessions", on: false },
  ];
  assert.deepEqual(panelToggles({}), allOff);
  assert.deepEqual(panelToggles(), allOff);
});
