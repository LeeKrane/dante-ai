import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MAX_NAME_CHARS,
  buildName,
  loadSessionKinds,
  slugify,
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
// module. `return await` is load-bearing: without it the finally block deletes
// the directory while fn is still awaiting an import.
async function withTempSessions(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "dante-sessions-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(dir, name), source);
    }
    return await fn(pathToFileURL(dir + "/"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const kindSource = (body) => `export default ${body};\n`;

// ---------------------------------------------------------------------------
// The shipped kinds
// ---------------------------------------------------------------------------

test("the shipped session kinds load", async () => {
  const kinds = await loadSessionKinds(SESSIONS);
  assert.ok(kinds.get("review"), "review should be registered");
  assert.ok(kinds.get("tests"), "tests should be registered");
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
