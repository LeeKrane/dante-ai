import test from "node:test";
import assert from "node:assert/strict";

import { MAX_BRIEF_CHARS, MAX_SUBJECT_CHARS, describeActivity } from "../public/activity-policy.js";

test("an interview reads as interviewing and a proposal as awaiting your yes", () => {
  assert.deepEqual(describeActivity({ value: "interviewing" }), { label: "interviewing", detail: "" });
  assert.deepEqual(describeActivity({ value: "proposing", brief: "Build it." }), {
    label: "awaiting your yes",
    detail: "Build it.",
  });
});

test("the machine's read-back reads as confirming, with no detail of its own", () => {
  // Its own label rather than folded into "interviewing": it is a different
  // phase, run by the machine rather than the model, and the page should say
  // so. It carries no brief the way "proposing" does -- the read-back is
  // spoken, not shown.
  assert.deepEqual(describeActivity({ value: "confirming" }), { label: "confirming", detail: "" });
  assert.deepEqual(describeActivity({ value: "confirming", subject: "jarvis" }), { label: "confirming", detail: "" });
});

test("a verb names its subject, and a primitive id is read as words", () => {
  assert.deepEqual(describeActivity({ value: "telling", subject: "kessler-ridge" }), {
    label: "telling kessler-ridge",
    detail: "",
  });
  assert.deepEqual(describeActivity({ value: "stopping", subject: "jarvis-3-fix" }), {
    label: "stopping jarvis-3-fix",
    detail: "",
  });
  // Only a build's subject is a primitive id rather than a name someone
  // chose, so only "building" reads its dashes and underscores as spaces.
  assert.deepEqual(describeActivity({ value: "building", subject: "landing-page" }), {
    label: "building landing page",
    detail: "",
  });
  assert.deepEqual(describeActivity({ value: "building", subject: "weekend_planner" }), {
    label: "building weekend planner",
    detail: "",
  });
});

test("a verb with no subject is just the verb", () => {
  assert.deepEqual(describeActivity({ value: "starting" }), { label: "starting", detail: "" });
  assert.deepEqual(describeActivity({ value: "reading", subject: "" }), { label: "reading", detail: "" });
  assert.deepEqual(describeActivity({ value: "interrupting", subject: "   " }), {
    label: "interrupting",
    detail: "",
  });
});

test("nothing going on is an empty label", () => {
  assert.deepEqual(describeActivity({ value: null }), { label: "", detail: "" });
  assert.deepEqual(describeActivity({}), { label: "", detail: "" });
});

test("a subject is capped and stripped because whoever started the session wrote it", () => {
  const long = describeActivity({ value: "starting", subject: "a".repeat(200) });
  assert.equal(long.label, `starting ${"a".repeat(MAX_SUBJECT_CHARS)}`);

  // Whitespace collapsed, control and bidi-override characters stripped --
  // the same class confirm.js strips before reading a name back to someone.
  const messy = describeActivity({ value: "telling", subject: "jarvis   three\u0000\u202a" });
  assert.deepEqual(messy, { label: "telling jarvis three", detail: "" });
});

test("the brief is shown only while a proposal awaits a yes, capped, with its line breaks kept", () => {
  // Not proposing: whatever else the server sent along, the brief is not this
  // page's business until a yes is actually being asked for.
  assert.equal(describeActivity({ value: "starting", brief: "Do the thing." }).detail, "");

  // \r dropped, tabs become spaces, runs of three or more newlines collapse to
  // two, and a genuine paragraph break survives -- this is read pre-wrap.
  const brief = "First line.\r\n\tIndented.\n\n\n\nSecond paragraph.";
  assert.equal(
    describeActivity({ value: "proposing", brief }).detail,
    "First line.\n Indented.\n\nSecond paragraph.",
  );

  const capped = describeActivity({ value: "proposing", brief: "x".repeat(MAX_BRIEF_CHARS + 500) });
  assert.equal(capped.detail.length, MAX_BRIEF_CHARS);

  assert.equal(describeActivity({ value: "proposing" }).detail, "");
});

test("a structured brief's sections survive whole, dash bullets and all", () => {
  const brief = [
    "Goal: fix the flaky test",
    "Where: jarvis, test/builder.test.js",
    "Constraints:",
    "- do not touch lib/builder.js",
    "- keep the existing fixtures",
    "Done when:",
    "- npm test is green",
  ].join("\n");
  assert.equal(describeActivity({ value: "proposing", brief }).detail, brief);
});

test("an unknown value is not guessed at", () => {
  assert.deepEqual(describeActivity({ value: "dancing" }), { label: "", detail: "" });
  assert.deepEqual(describeActivity({ value: 42 }), { label: "", detail: "" });
  assert.deepEqual(describeActivity(null), { label: "", detail: "" });
  assert.deepEqual(describeActivity(undefined), { label: "", detail: "" });
  assert.deepEqual(describeActivity("proposing"), { label: "", detail: "" });
});
