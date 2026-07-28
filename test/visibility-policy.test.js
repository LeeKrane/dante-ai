import test from "node:test";
import assert from "node:assert/strict";
import { getVisibilityToggle } from "../public/visibility-policy.js";

test("maps filming visibility keys when push-to-talk is inactive", () => {
  assert.equal(getVisibilityToggle("t", false), "caption");
  assert.equal(getVisibilityToggle("T", false), "caption");
  assert.equal(getVisibilityToggle("h", false), "interface");
  assert.equal(getVisibilityToggle("d", false), "diagnostics");
  assert.equal(getVisibilityToggle("x", false), null);
});

test("suppresses visibility toggles while push-to-talk is held", () => {
  assert.equal(getVisibilityToggle("t", true), null);
  assert.equal(getVisibilityToggle("h", true), null);
  assert.equal(getVisibilityToggle("d", true), null);
});
