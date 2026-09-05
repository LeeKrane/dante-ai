import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withTempFiles } from "./helpers.js";
import { MAX_BRIEF_CHARS } from "../lib/spawn-session.js";
import {
  MAX_NAME_CHARS,
  buildName,
  leadingSkill,
  loadSessionKinds,
  missingSkill,
  promptFor,
  recordedKind,
  slugify,
  speaksVerdict,
  validateSessionKind,
} from "../lib/sessions.js";

const SESSIONS = new URL("../sessions/", import.meta.url);

// A minimal kind that satisfies every required field. Negative cases are built
// by deleting or corrupting exactly one field of this object.
function validKind(overrides = {}) {
  return {
    id: "sample",
    systemPrompt: () => "do the thing",
    ...overrides,
  };
}

// Each temp dir gets a fresh path so dynamic import() never serves a cached
// module — see test/helpers.js for the `return await` rationale.
const withTempSessions = (files, fn) => withTempFiles("dante-sessions-", files, fn);

const kindSource = (body) => `export default ${body};\n`;

// ---------------------------------------------------------------------------
// The shipped kinds
// ---------------------------------------------------------------------------

test("the shipped session kinds load", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  assert.ok(kinds.get("review"), "review should be registered");
  assert.ok(kinds.get("tests"), "tests should be registered");
  assert.ok(kinds.get("brainstorm"), "brainstorm should be registered");
});

test("the template is an example rather than a live session kind", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  assert.equal(kinds.has("your-session-id"), false);
  assert.equal(kinds.has("_template"), false);
});

test("a session kind names no tools, because a session is not a build", () => {
  // The distinction the whole module rests on. A primitive's allowedTools is
  // its boundary; a session runs under the user's own permissions, and a
  // Dante-shaped restriction here would only make a voice-started session
  // weaker than one started in a terminal.
  const review = { id: "review", systemPrompt: () => "x", allowedTools: undefined };
  assert.equal(review.allowedTools, undefined);
  assert.equal(validateSessionKind(review, "review.mjs"), true);
});

test("a review is told not to fix what it finds", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  const prompt = kinds.get("review").systemPrompt({ task: "the builder changes" });
  assert.match(prompt, /Do not fix what you find/);
  assert.match(prompt, /the builder changes/);
});

test("a test-fixing session is told that deleting the assertion is not a fix", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  const prompt = kinds.get("tests").systemPrompt({});
  assert.match(prompt, /deleting an assertion to make it pass is a failure/i);
});

test("a brainstorm session's prompt opens the council skill and carries the brief verbatim", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  const brief = "Goal: ship the widget.\nConstraints: no new deps.\nDone when: tests pass.";
  const prompt = kinds.get("brainstorm").prompt({ task: "brainstorm the widget plan", brief });
  assert.match(prompt, /^\/council-review\n/);
  assert.ok(prompt.includes(brief), "the brief should appear in the prompt unchanged");
  assert.match(prompt, /Rewrite the brief in the same Goal \/ Constraints \/ Done when shape/);
});

test("a brainstorm session falls back to the task when the interview left no brief", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  const prompt = kinds.get("brainstorm").prompt({ task: "brainstorm the widget plan", brief: "" });
  assert.ok(prompt.includes("brainstorm the widget plan"));
});

test("a brainstorm session is told not to implement or commit, and names its repository", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  const prompt = kinds.get("brainstorm").systemPrompt({ task: "x", alias: "jarvis" });
  assert.match(prompt, /jarvis/);
  assert.match(prompt, /do not implement/i);
  assert.match(prompt, /do not commit/i);
});

test("brainstorm drops the trigger that collides with review.mjs's own", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  const triggers = kinds.get("brainstorm").triggers;
  assert.equal(triggers.includes("council review this"), false);
  assert.deepEqual(triggers, ["brainstorm", "brainstorming", "brainstorming session", "debate this"]);
});

test("brainstorm is the one kind trusted to speak its own transcript as a verdict, and it names its skill", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  const brainstorm = kinds.get("brainstorm");
  assert.equal(brainstorm.speaksVerdict, true);
  assert.equal(brainstorm.skill, "council-review");
});

test("a brainstorm brief near the cap composes to at most MAX_BRIEF_CHARS, preamble intact, brief head preserved", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  const brief = "Goal: ship the widget. " + "x".repeat(MAX_BRIEF_CHARS);
  const prompt = kinds.get("brainstorm").prompt({ task: "brainstorm the widget plan", brief, maxChars: MAX_BRIEF_CHARS });

  assert.ok(prompt.length <= MAX_BRIEF_CHARS, `prompt was ${prompt.length} chars`);
  assert.match(prompt, /^\/council-review\n/);
  assert.match(prompt, /Rewrite the brief in the same Goal \/ Constraints \/ Done when shape/);
  assert.ok(prompt.includes("Goal: ship the widget."), "the brief's own head should survive the trim");
});

// ---------------------------------------------------------------------------
// validateSessionKind
// ---------------------------------------------------------------------------

test("a session kind needs an id and a system prompt and nothing else", () => {
  assert.equal(validateSessionKind(validKind(), "sample.mjs"), true);
});

test("a kind missing what it cannot work without is refused by name", () => {
  const cases = [
    [validKind({ id: undefined }), /"id"/],
    [validKind({ id: "   " }), /"id"/],
    [validKind({ systemPrompt: undefined }), /"systemPrompt"/],
    [validKind({ systemPrompt: "a string" }), /"systemPrompt"/],
    [null, /session kind config object/],
    ["not an object", /session kind config object/],
    [["an array"], /session kind config object/],
  ];
  for (const [kind, pattern] of cases) {
    assert.throws(() => validateSessionKind(kind, "sample.mjs"), pattern);
    assert.throws(() => validateSessionKind(kind, "sample.mjs"), /^Error: sample\.mjs: /);
  }
});

test("a model or an effort of the wrong type is caught at load, not at spawn", () => {
  // Both go straight onto a command line, where the failure mode for a wrong
  // type is the argv token "[object Object]" rather than a loud error — and it
  // would surface minutes later, out loud, naming nothing.
  assert.throws(() => validateSessionKind(validKind({ model: 42 }), "s.mjs"), /"model"/);
  assert.throws(() => validateSessionKind(validKind({ model: "" }), "s.mjs"), /"model"/);
  assert.throws(() => validateSessionKind(validKind({ effort: "maximum" }), "s.mjs"), /"effort"/);
  assert.throws(() => validateSessionKind(validKind({ effort: 3 }), "s.mjs"), /"effort"/);
  assert.equal(validateSessionKind(validKind({ model: "opus", effort: "high" }), "s.mjs"), true);
});

test("every effort level the CLI accepts is accepted here", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(validateSessionKind(validKind({ effort }), "s.mjs"), true, effort);
  }
});

test("a trigger that is not a phrase is refused", () => {
  assert.throws(() => validateSessionKind(validKind({ triggers: "review" }), "s.mjs"), /"triggers"/);
  assert.throws(() => validateSessionKind(validKind({ triggers: [42] }), "s.mjs"), /"triggers\[0\]"/);
  assert.throws(() => validateSessionKind(validKind({ triggers: ["  "] }), "s.mjs"), /"triggers\[0\]"/);
});

test("a nameHint that is not callable is refused", () => {
  assert.throws(() => validateSessionKind(validKind({ nameHint: "review" }), "s.mjs"), /"nameHint"/);
});

test("a prompt hook must be a function when present, and a kind may leave it out entirely", () => {
  assert.throws(() => validateSessionKind(validKind({ prompt: "/council-review" }), "s.mjs"), /"prompt"/);
  assert.throws(() => validateSessionKind(validKind({ prompt: 42 }), "s.mjs"), /"prompt"/);
  assert.equal(validateSessionKind(validKind({ prompt: ({ brief }) => brief }), "s.mjs"), true);
  assert.equal(validateSessionKind(validKind(), "s.mjs"), true);
});

test("speaksVerdict must be a boolean when present", () => {
  assert.throws(() => validateSessionKind(validKind({ speaksVerdict: "yes" }), "s.mjs"), /"speaksVerdict"/);
  assert.throws(() => validateSessionKind(validKind({ speaksVerdict: 1 }), "s.mjs"), /"speaksVerdict"/);
  assert.equal(validateSessionKind(validKind({ speaksVerdict: true }), "s.mjs"), true);
  assert.equal(validateSessionKind(validKind({ speaksVerdict: false }), "s.mjs"), true);
  assert.equal(validateSessionKind(validKind(), "s.mjs"), true);
});

test("skill must be a non-empty string when present", () => {
  assert.throws(() => validateSessionKind(validKind({ skill: "" }), "s.mjs"), /"skill"/);
  assert.throws(() => validateSessionKind(validKind({ skill: "  " }), "s.mjs"), /"skill"/);
  assert.throws(() => validateSessionKind(validKind({ skill: 42 }), "s.mjs"), /"skill"/);
  assert.equal(validateSessionKind(validKind({ skill: "council-review" }), "s.mjs"), true);
});

// ---------------------------------------------------------------------------
// speaksVerdict
// ---------------------------------------------------------------------------

test("only a kind whose own field is true speaks its transcript as a verdict", () => {
  assert.equal(speaksVerdict({ speaksVerdict: true }), true);
  assert.equal(speaksVerdict({ speaksVerdict: false }), false);
  assert.equal(speaksVerdict({}), false);
  assert.equal(speaksVerdict(null), false);
  assert.equal(speaksVerdict(undefined), false);
  // A kind-less session (sessionKinds.get(null) or a stale kindId) is
  // exactly the case that must default closed, not open: a Map miss hands
  // this undefined, the same as a session started with no kind at all.
  assert.equal(speaksVerdict(new Map().get("no-such-kind")), false);
});

// ---------------------------------------------------------------------------
// missingSkill
// ---------------------------------------------------------------------------

test("a kind that names no skill has nothing missing", () => {
  assert.equal(missingSkill({}, new Map()), null);
  assert.equal(missingSkill(null, new Map()), null);
});

test("a skill the known map has is not missing", () => {
  const known = new Map([["council-review", { name: "council-review", source: "/home/krane" }]]);
  assert.equal(missingSkill({ skill: "council-review" }, known), null);
});

test("a skill matched case-insensitively against the known map is not missing", () => {
  const known = new Map([["council-review", { name: "council-review", source: "/home/krane" }]]);
  assert.equal(missingSkill({ skill: "Council-Review" }, known), null);
});

test("a skill nothing discovered is refused by name", () => {
  assert.equal(missingSkill({ skill: "council-review" }, new Map()), "council-review");
});

test("a known that is not a Map is treated as no skills known, not silently guessed at", () => {
  // loadCommands (lib/commands.js) always returns a Map, and beginSession
  // (server.js) is this function's sole caller -- so this only ever fires on
  // a programming error, never a real lookup. Refusing by name, the same
  // answer an actually-empty Map gives, is the honest answer rather than a
  // shape-sniffing guess.
  assert.equal(missingSkill({ skill: "council-review" }, undefined), "council-review");
  assert.equal(missingSkill({ skill: "council-review" }, null), "council-review");
  assert.equal(missingSkill({ skill: "council-review" }, new Set(["council-review"])), "council-review");
  assert.equal(missingSkill({ skill: "council-review" }, { has: () => true, get: () => true }), "council-review");
});

// ---------------------------------------------------------------------------
// leadingSkill
// ---------------------------------------------------------------------------

test("a prompt whose first line is a slash command names the skill", () => {
  assert.equal(leadingSkill("/council-review\n\nBrainstorm the brief."), "council-review");
  assert.equal(leadingSkill("/review high"), "review");
});

test("a prompt with no leading slash, or no prompt at all, names no skill", () => {
  assert.equal(leadingSkill("Just an ordinary sentence."), null);
  assert.equal(leadingSkill("brainstorm the brief\n/council-review"), null);
  assert.equal(leadingSkill(""), null);
  assert.equal(leadingSkill(undefined), null);
  assert.equal(leadingSkill(null), null);
  assert.equal(leadingSkill(42), null);
});

test("missingSkill checks what the composed prompt actually opens with when the kind names no skill of its own", () => {
  const known = new Map([["council-review", { name: "council-review", source: "/home/krane" }]]);
  assert.equal(missingSkill({}, known, "/council-review\n\nBrainstorm the brief."), null);
  assert.equal(missingSkill({}, known, "/no-such-skill\n\nBody"), "no-such-skill");
  // No prompt at all, and no declared skill either, is nothing to check.
  assert.equal(missingSkill({}, known), null);
});

test("a kind's own declared skill wins over whatever the prompt opens with", () => {
  const known = new Map([["council-review", { name: "council-review", source: "/home/krane" }]]);
  // The declared field names a real skill; the prompt's own first line is
  // left unchecked once that field is set.
  assert.equal(missingSkill({ skill: "council-review" }, known, "/something-else\n\nBody"), null);
  // The declared field names a fake one; the prompt's real skill does not
  // save it, because the declared field is what is trusted once it is set.
  assert.equal(missingSkill({ skill: "fake" }, known, "/council-review\n\nBody"), "fake");
});

// ---------------------------------------------------------------------------
// recordedKind
// ---------------------------------------------------------------------------

test("a session that ran its kind's own composed prompt is remembered under that kind", () => {
  assert.equal(recordedKind({ kindId: "brainstorm", command: undefined }), "brainstorm");
  assert.equal(recordedKind({ kindId: "brainstorm" }), "brainstorm");
});

test("an explicit command that overrode the kind's prompt is remembered as no kind at all", () => {
  // The verdict gate (speaksVerdict) must stay closed for a session whose
  // prompt the kind did not actually compose -- see recordedKind's own
  // comment in lib/sessions.js for why.
  assert.equal(recordedKind({ kindId: "brainstorm", command: "/review high" }), null);
  // No kindId at all is still null either way.
  assert.equal(recordedKind({ command: "/review high" }), null);
  assert.equal(recordedKind({}), null);
  assert.equal(recordedKind(), null);
});

// ---------------------------------------------------------------------------
// promptFor
// ---------------------------------------------------------------------------

test("a kind with no prompt hook leaves the brief exactly as it was handed in", () => {
  const kind = { id: "sample", systemPrompt: () => "x" };
  assert.equal(promptFor(kind, { task: "fix it", brief: "Goal: fix it.\nDone when: green." }), "Goal: fix it.\nDone when: green.");
  assert.equal(promptFor(kind, { task: "fix it", brief: undefined }), undefined);
  assert.equal(promptFor(null, { task: "fix it", brief: "a brief" }), "a brief");
});

test("a kind's own prompt hook replaces the brief entirely, not merely adds to it", () => {
  const kind = { id: "sample", systemPrompt: () => "x", prompt: ({ task, brief }) => `/skill\n\n${brief || task}` };
  assert.equal(promptFor(kind, { task: "fix it", brief: "the real brief" }), "/skill\n\nthe real brief");
  assert.equal(promptFor(kind, { task: "fix it", brief: "" }), "/skill\n\nfix it");
});

test("the prompt hook is handed maxChars, defaulting to MAX_BRIEF_CHARS when the caller gives none", () => {
  const kind = { id: "sample", systemPrompt: () => "x", prompt: ({ maxChars }) => String(maxChars) };
  assert.equal(promptFor(kind, { task: "x", brief: "x" }), String(MAX_BRIEF_CHARS));
  assert.equal(promptFor(kind, { task: "x", brief: "x", maxChars: 500 }), "500");
});

// ---------------------------------------------------------------------------
// loadSessionKinds
// ---------------------------------------------------------------------------

test("an id that does not match its filename is refused", async () => {
  // Drift between the two makes a kind impossible to find by name.
  await withTempSessions({ "review.mjs": kindSource('{ id: "audit", systemPrompt: () => "x" }') }, async (dir) => {
    await assert.rejects(loadSessionKinds(dir), /review\.mjs: "id" is "audit"/);
  });
});

test("a file with no default export is refused by name", async () => {
  await withTempSessions({ "broken.mjs": "export const nope = 1;\n" }, async (dir) => {
    await assert.rejects(loadSessionKinds(dir), /broken\.mjs: missing a default export/);
  });
});

test("a file that cannot be imported names itself in the error", async () => {
  await withTempSessions({ "typo.mjs": "export default { id: 'typo',,, };\n" }, async (dir) => {
    await assert.rejects(loadSessionKinds(dir), /typo\.mjs: could not be imported/);
  });
});

test("underscored and hidden files are skipped", async () => {
  await withTempSessions(
    {
      "_template.mjs": kindSource('{ id: "nope", systemPrompt: () => "x" }'),
      "._junk.mjs": "this is not even javascript",
      "notes.md": "# not a session kind",
      "real.mjs": kindSource('{ id: "real", systemPrompt: () => "x" }'),
    },
    async (dir) => {
      const kinds = await loadSessionKinds(dir);
      assert.deepEqual([...kinds.keys()], ["real"]);
    },
  );
});

test("a missing sessions directory is a working install, not an error", async () => {
  // Unlike primitives/, free-form is the default path here: starting a session
  // with a task and no kind is the ordinary case, so a clone with no session
  // kinds at all still works.
  const kinds = await loadSessionKinds(join(tmpdir(), "dante-no-such-sessions-dir"));
  assert.equal(kinds.size, 0);
});

test("a loaded kind's triggers cannot be mutated back into the module cache", async () => {
  await withTempSessions(
    { "real.mjs": kindSource('{ id: "real", systemPrompt: () => "x", triggers: ["one"] }') },
    async (dir) => {
      const first = await loadSessionKinds(dir);
      first.get("real").triggers.push("smuggled");
      const second = await loadSessionKinds(dir);
      assert.deepEqual(second.get("real").triggers, ["one"]);
    },
  );
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test("a task becomes the few words that tell one session from another", () => {
  assert.equal(slugify("fix the failing builder test"), "fix-failing-builder-test");
  assert.equal(slugify("Add a Slack notifier for completed builds"), "add-slack-notifier-completed");
  assert.equal(slugify("read the README"), "read-readme");
});

test("a task made entirely of filler still names something", () => {
  // A real sentence someone says, and not worth failing over: the alias and the
  // number already name the session.
  assert.equal(slugify("do the thing"), "do-thing");
  assert.equal(slugify("the a of and"), "");
  assert.equal(slugify(""), "");
  assert.equal(slugify(null), "");
  assert.equal(slugify(42), "");
});

test("a session is named for its task alone, with no repository or counter in front of it", () => {
  assert.equal(buildName({ task: "fix the failing builder test" }), "fix-failing-builder-test");
});

test("a kind's own hint beats the first few words of the task", () => {
  // "review" is a better name for a review than "look-over-my-recent-changes".
  assert.equal(
    buildName({ task: "look over my recent changes", hint: "review" }),
    "review",
  );
});

test("a name with nothing to say falls back to the word session, never to nothing", () => {
  assert.equal(buildName({}), "session");
  assert.equal(buildName({ task: "the a of and" }), "session");
});

test("a name already in use gets a sibling rather than being reused", () => {
  // Two live sessions with one name makes every later "tell review to also run
  // the linter" ambiguous, and that command signals a real process.
  const taken = ["review"];
  assert.equal(buildName({ hint: "review" }, taken), "review-2");
  assert.equal(buildName({ hint: "review" }, [...taken, "review-2"]), "review-3");
});

test("a very long task does not produce a name nobody can say", () => {
  const name = buildName({
    task: "completely rewrite the entire authentication subsystem including every single test",
  });
  assert.ok(name.length <= MAX_NAME_CHARS, `name was ${name.length} chars: ${name}`);
});

test("a collision suffix never pushes the name past the cap", () => {
  const long = "x".repeat(MAX_NAME_CHARS * 2);
  const first = buildName({ task: long });
  const second = buildName({ task: long }, [first]);
  assert.ok(second.length <= MAX_NAME_CHARS, `name was ${second.length} chars`);
  assert.notEqual(second, first);
});

test("a taken list full of things that are not names is ignored rather than trusted", () => {
  assert.equal(buildName({ hint: "review" }, null), "review");
  assert.equal(buildName({ hint: "review" }, [null, 42, {}]), "review");
});
