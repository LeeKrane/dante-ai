import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadRegistry, validatePrimitive } from "../lib/registry.js";

const PRIMITIVES = new URL("../primitives/", import.meta.url);

// A minimal primitive that satisfies every required field. Negative cases are
// built by deleting or corrupting exactly one field of this object.
function validPrimitive(overrides = {}) {
  return {
    id: "sample",
    systemPrompt: () => "build something",
    allowedTools: ["Write"],
    outputContract: "index.html",
    doneLine: () => "done",
    timeoutMs: 1000,
    ...overrides,
  };
}

// Each temp dir gets a fresh path so dynamic import() never serves a cached module.
// `return await` is load-bearing: without it the finally block deletes the
// directory while fn is still awaiting an import, which only looks fine when
// the fixture has a single file and the loader wins the race.
async function withTempPrimitives(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-primitives-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(dir, name), source);
    }
    return await fn(pathToFileURL(dir + "/"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function primitiveSource(body) {
  return `export default ${body};\n`;
}

test("loads the real landing-page primitive", async () => {
  const registry = await loadRegistry(PRIMITIVES);
  const landing = registry.get("landing-page");

  assert.ok(landing, "landing-page should be registered");
  assert.equal(landing.id, "landing-page");
  assert.equal(landing.outputContract, "index.html");
  // A tuning knob, not a contract — assert it is usable, not what it is set to.
  assert.ok(landing.timeoutMs > 0, "timeoutMs should be a positive duration");
  assert.deepEqual(landing.allowedTools, ["Write", "Edit", "Read"]);
  assert.deepEqual(landing.mcp, ["refero"]);
  assert.deepEqual(
    landing.questions.map((q) => q.key),
    ["subject", "vibe"],
  );
  assert.ok(landing.triggers.includes("landing page"));
});

test("landing-page renders a prompt and a spoken done line", async () => {
  const registry = await loadRegistry(PRIMITIVES);
  const landing = registry.get("landing-page");
  const params = { subject: "a dog walking service", vibe: "warm and playful" };

  const prompt = landing.systemPrompt(params);
  assert.equal(typeof prompt, "string");
  assert.ok(prompt.includes("index.html"), "prompt should name the output file");
  assert.ok(prompt.includes(params.subject), "prompt should carry the answers through");

  const done = landing.doneLine(params);
  assert.equal(typeof done, "string");
  assert.ok(done.length > 0);
});

test("skips files whose name starts with an underscore", async () => {
  const registry = await loadRegistry(PRIMITIVES);
  assert.equal(registry.has("_template"), false);
  assert.equal(registry.has("your-primitive-id"), false);
  assert.equal(registry.has("template"), false);
});

test("the template is itself a valid primitive once copied and renamed", async () => {
  const template = (await import(new URL("_template.mjs", PRIMITIVES).href)).default;
  assert.equal(validatePrimitive(template, "_template.mjs"), true);
  assert.equal(template.id, "your-primitive-id");
});

test("rejects each missing required field, naming the field", () => {
  const required = [
    "id",
    "systemPrompt",
    "allowedTools",
    "outputContract",
    "doneLine",
    "timeoutMs",
  ];
  for (const field of required) {
    const broken = validPrimitive();
    delete broken[field];
    assert.throws(
      () => validatePrimitive(broken, "broken.mjs"),
      (err) => err.message.includes(field) && err.message.includes("broken.mjs"),
      `missing ${field} should throw naming the field and the file`,
    );
  }
});

test("rejects wrong-typed required fields", () => {
  const cases = {
    id: 42,
    systemPrompt: "not a function",
    allowedTools: "Write",
    outputContract: "",
    doneLine: null,
    timeoutMs: 0,
  };
  for (const [field, value] of Object.entries(cases)) {
    assert.throws(
      () => validatePrimitive(validPrimitive({ [field]: value }), "bad.mjs"),
      (err) => err.message.includes(field),
      `bad ${field} should throw`,
    );
  }
});

test("rejects wrong-typed optional fields and malformed questions", () => {
  assert.throws(
    () => validatePrimitive(validPrimitive({ triggers: "landing" }), "bad.mjs"),
    /triggers/,
  );
  assert.throws(
    () => validatePrimitive(validPrimitive({ mcp: "refero" }), "bad.mjs"),
    /mcp/,
  );
  assert.throws(
    () => validatePrimitive(validPrimitive({ questions: [{ key: "subject" }] }), "bad.mjs"),
    /ask/,
  );
  assert.throws(
    () => validatePrimitive(validPrimitive({ questions: [{ ask: "What for?" }] }), "bad.mjs"),
    /key/,
  );
});

test("accepts a valid primitive", () => {
  assert.equal(validatePrimitive(validPrimitive(), "sample.mjs"), true);
});

test("rejects an id that does not match its filename", async () => {
  await withTempPrimitives(
    { "poster.mjs": primitiveSource(`{
      id: "flyer",
      systemPrompt: () => "x",
      allowedTools: ["Write"],
      outputContract: "index.html",
      doneLine: () => "done",
      timeoutMs: 1000,
    }`) },
    async (dirUrl) => {
      await assert.rejects(
        () => loadRegistry(dirUrl),
        (err) => err.message.includes("poster.mjs") && err.message.includes("flyer"),
      );
    },
  );
});

test("names the offending file when a primitive is invalid", async () => {
  await withTempPrimitives(
    { "poster.mjs": primitiveSource(`{
      id: "poster",
      systemPrompt: () => "x",
      allowedTools: ["Write"],
      outputContract: "index.html",
      doneLine: () => "done",
    }`) },
    async (dirUrl) => {
      await assert.rejects(
        () => loadRegistry(dirUrl),
        (err) => err.message.includes("poster.mjs") && err.message.includes("timeoutMs"),
      );
    },
  );
});

test("rejects a file with no default export", async () => {
  await withTempPrimitives(
    { "poster.mjs": "export const nope = 1;\n" },
    async (dirUrl) => {
      await assert.rejects(() => loadRegistry(dirUrl), /poster\.mjs/);
    },
  );
});

test("applies defaults for the optional fields", async () => {
  await withTempPrimitives(
    { "poster.mjs": primitiveSource(`{
      id: "poster",
      systemPrompt: () => "x",
      allowedTools: ["Write"],
      outputContract: "index.html",
      doneLine: () => "done",
      timeoutMs: 1000,
    }`) },
    async (dirUrl) => {
      const registry = await loadRegistry(dirUrl);
      const poster = registry.get("poster");
      assert.deepEqual(poster.triggers, []);
      assert.deepEqual(poster.questions, []);
      assert.deepEqual(poster.mcp, []);
    },
  );
});

test("ignores non-mjs files and underscore files in any directory", async () => {
  await withTempPrimitives(
    {
      "_scratch.mjs": "throw new Error('underscore files must never be imported');\n",
      "notes.md": "not a primitive\n",
      "poster.mjs": primitiveSource(`{
        id: "poster",
        systemPrompt: () => "x",
        allowedTools: ["Write"],
        outputContract: "index.html",
        doneLine: () => "done",
        timeoutMs: 1000,
      }`),
    },
    async (dirUrl) => {
      const registry = await loadRegistry(dirUrl);
      assert.deepEqual([...registry.keys()], ["poster"]);
    },
  );
});

test("accepts a plain directory path as well as a file URL", async () => {
  await withTempPrimitives(
    { "poster.mjs": primitiveSource(`{
      id: "poster",
      systemPrompt: () => "x",
      allowedTools: ["Write"],
      outputContract: "index.html",
      doneLine: () => "done",
      timeoutMs: 1000,
    }`) },
    async (dirUrl) => {
      // fileURLToPath, not `.pathname`: the latter stays percent-encoded, so on
      // a machine whose TMPDIR contains a space this would test a bogus path.
      const registry = await loadRegistry(fileURLToPath(dirUrl));
      assert.ok(registry.has("poster"));
    },
  );
});

// --- regressions -----------------------------------------------------------

// A directory URL with no trailing slash used to resolve imports into the
// PARENT directory, silently loading a same-named primitive from there --
// including a different allowedTools grant. Loudest possible failure mode.
test("a directory URL without a trailing slash still loads from that directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-shadow-"));
  try {
    const sub = join(root, "primitives");
    mkdirSync(sub);
    writeFileSync(join(sub, "poster.mjs"), primitiveSource(`{
      id: "poster",
      systemPrompt: () => "real",
      allowedTools: ["Write"],
      outputContract: "index.html",
      doneLine: () => "done",
      timeoutMs: 1000,
    }`));
    // A decoy in the parent, with a broader tool grant.
    writeFileSync(join(root, "poster.mjs"), primitiveSource(`{
      id: "poster",
      systemPrompt: () => "shadowed",
      allowedTools: ["Bash"],
      outputContract: "index.html",
      doneLine: () => "done",
      timeoutMs: 1000,
    }`));

    for (const dir of [pathToFileURL(sub), pathToFileURL(sub).href, sub]) {
      const registry = await loadRegistry(dir);
      assert.equal(registry.get("poster").systemPrompt({}), "real");
      assert.deepEqual(registry.get("poster").allowedTools, ["Write"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loads primitives whose filename contains URL-significant characters", async () => {
  await withTempPrimitives(
    {
      "my#thing.mjs": primitiveSource(`{
        id: "my#thing", systemPrompt: () => "x", allowedTools: ["Write"],
        outputContract: "index.html", doneLine: () => "done", timeoutMs: 1000,
      }`),
      "100%.mjs": primitiveSource(`{
        id: "100%", systemPrompt: () => "x", allowedTools: ["Write"],
        outputContract: "index.html", doneLine: () => "done", timeoutMs: 1000,
      }`),
      "café plán.mjs": primitiveSource(`{
        id: "café plán", systemPrompt: () => "x", allowedTools: ["Write"],
        outputContract: "index.html", doneLine: () => "done", timeoutMs: 1000,
      }`),
    },
    async (dirUrl) => {
      const registry = await loadRegistry(dirUrl);
      assert.deepEqual([...registry.keys()].sort(), ["100%", "café plán", "my#thing"]);
    },
  );
});

test("rejects a directory argument that is empty or not a path", async () => {
  for (const bad of ["", "   ", null, 0, {}, []]) {
    await assert.rejects(
      () => loadRegistry(bad),
      /directory must be a non-empty path string or a file: URL/,
      `loadRegistry(${JSON.stringify(bad)}) should refuse rather than scan the filesystem root`,
    );
  }
});

test("reports a missing primitives directory as such", async () => {
  await assert.rejects(
    () => loadRegistry(join(tmpdir(), "jarvis-does-not-exist-a7f3")),
    /cannot read primitives directory/,
  );
});

test("names the file when a primitive fails to import", async () => {
  await withTempPrimitives(
    { "boom.mjs": "throw new Error('side effect at import time');\n" },
    async (dirUrl) => {
      await assert.rejects(
        () => loadRegistry(dirUrl),
        (err) =>
          err.message.includes("boom.mjs") && err.message.includes("side effect at import time"),
      );
    },
  );
  await withTempPrimitives(
    { "typo.mjs": "export default {{{;\n" },
    async (dirUrl) => {
      await assert.rejects(() => loadRegistry(dirUrl), /typo\.mjs: could not be imported/);
    },
  );
});

test("skips dotfiles and directories that happen to end in .mjs", async () => {
  await withTempPrimitives(
    {
      // What macOS leaves behind when the repo travels via a FAT/SMB volume.
      "._poster.mjs": "\u0000\u0005\u0016\u0007not javascript",
      "poster.mjs": primitiveSource(`{
        id: "poster", systemPrompt: () => "x", allowedTools: ["Write"],
        outputContract: "index.html", doneLine: () => "done", timeoutMs: 1000,
      }`),
    },
    async (dirUrl) => {
      mkdirSync(join(fileURLToPath(dirUrl), "stale.mjs"));
      const registry = await loadRegistry(dirUrl);
      assert.deepEqual([...registry.keys()], ["poster"]);
    },
  );
});

test("rejects non-string entries in allowedTools, triggers and mcp", () => {
  const cases = [
    ["allowedTools", ["Write", 42]],
    ["allowedTools", [null]],
    ["allowedTools", ["  "]],
    ["triggers", ["landing page", { phrase: "landing" }]],
    ["mcp", [["refero"]]],
  ];
  for (const [field, value] of cases) {
    assert.throws(
      () => validatePrimitive(validPrimitive({ [field]: value }), "bad.mjs"),
      (err) => err.message.includes(field) && err.message.includes("bad.mjs"),
      `${field}: ${JSON.stringify(value)} should be rejected`,
    );
  }
});

test("rejects two questions sharing one key", () => {
  assert.throws(
    () =>
      validatePrimitive(
        validPrimitive({
          questions: [
            { key: "subject", ask: "What for?" },
            { key: "subject", ask: "Say more?" },
          ],
        }),
        "bad.mjs",
      ),
    /questions\[1\]\.key" repeats "subject"/,
  );
});

test("validatePrimitive reads sensibly when called with no source name", () => {
  assert.throws(() => validatePrimitive({}), /^Error: primitive: "id" must be a non-empty string$/);
});

// The module cache returns one object per file, so handing out its arrays
// directly let one caller's mutation leak into every later load.
test("returned primitives do not share mutable state with later loads", async () => {
  const first = await loadRegistry(PRIMITIVES);
  first.get("landing-page").triggers.push("mutated");
  first.get("landing-page").questions[0].ask = "hijacked";

  const second = await loadRegistry(PRIMITIVES);
  assert.equal(second.get("landing-page").triggers.includes("mutated"), false);
  assert.equal(second.get("landing-page").questions[0].ask, "What's the landing page for?");
});
