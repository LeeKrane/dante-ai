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
  const dir = mkdtempSync(join(tmpdir(), "dante-primitives-"));
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
  const root = mkdtempSync(join(tmpdir(), "dante-shadow-"));
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
    () => loadRegistry(join(tmpdir(), "dante-does-not-exist-a7f3")),
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

// --- steps ------------------------------------------------------------------

// A primitive that runs as a chain. The last step's contract has to match the
// primitive's own, which is what makes the chain's success the primitive's.
function steppedPrimitive(overrides = {}) {
  return validPrimitive({
    timeoutMs: 300000,
    steps: [
      {
        id: "plan",
        systemPrompt: () => "write a plan",
        allowedTools: ["Write"],
        outputContract: "plan.md",
      },
      {
        id: "build",
        systemPrompt: () => "build it",
        allowedTools: ["Write", "Edit", "Read"],
        outputContract: "index.html",
      },
    ],
    ...overrides,
  });
}

test("accepts a primitive that declares a chain of steps", () => {
  assert.equal(validatePrimitive(steppedPrimitive(), "chain.mjs"), true);
});

test("rejects steps that are not an array", () => {
  assert.throws(() => validatePrimitive(validPrimitive({ steps: "plan" }), "bad.mjs"), /steps/);
});

test("rejects an empty steps array, which would spawn nothing and call it a success", () => {
  assert.throws(
    () => validatePrimitive(validPrimitive({ steps: [] }), "bad.mjs"),
    (err) => /steps/.test(err.message) && /empty/.test(err.message),
  );
});

test("rejects a step that is not an object", () => {
  assert.throws(
    () => validatePrimitive(steppedPrimitive({ steps: ["plan"] }), "bad.mjs"),
    /steps\[0\]/,
  );
});

test("rejects a step with no usable id", () => {
  for (const id of [undefined, "", "  ", 7]) {
    const steps = [{ id, systemPrompt: () => "x", allowedTools: ["Write"], outputContract: "index.html" }];
    assert.throws(
      () => validatePrimitive(validPrimitive({ steps }), "bad.mjs"),
      /steps\[0\]\.id/,
      `id ${JSON.stringify(id)} should be refused`,
    );
  }
});

test("rejects two steps sharing an id, which would name the same log separator twice", () => {
  const steps = [
    { id: "plan", systemPrompt: () => "x", allowedTools: ["Write"], outputContract: "plan.md" },
    { id: "plan", systemPrompt: () => "y", allowedTools: ["Write"], outputContract: "index.html" },
  ];
  assert.throws(
    () => validatePrimitive(validPrimitive({ steps }), "bad.mjs"),
    (err) => /steps\[1\]\.id/.test(err.message) && /plan/.test(err.message),
  );
});

test("rejects a step with no systemPrompt function", () => {
  const steps = steppedPrimitive().steps;
  delete steps[0].systemPrompt;
  assert.throws(() => validatePrimitive(validPrimitive({ steps }), "bad.mjs"), /steps\[0\]\.systemPrompt/);
});

test("a step must declare its own tools rather than inherit the primitive's", () => {
  const steps = steppedPrimitive().steps;
  delete steps[0].allowedTools;
  assert.throws(
    () => validatePrimitive(validPrimitive({ steps }), "bad.mjs"),
    /steps\[0\]\.allowedTools/,
  );
});

test("rejects unusable entries in a step's tool and MCP lists", () => {
  const withTools = (allowedTools) => steppedPrimitive({
    steps: [{ id: "only", systemPrompt: () => "x", allowedTools, outputContract: "index.html" }],
  });
  assert.throws(() => validatePrimitive(withTools([""]), "bad.mjs"), /steps\[0\]\.allowedTools\[0\]/);
  assert.throws(() => validatePrimitive(withTools([42]), "bad.mjs"), /steps\[0\]\.allowedTools\[0\]/);

  const withMcp = steppedPrimitive({
    steps: [{ id: "only", systemPrompt: () => "x", allowedTools: ["Write"], outputContract: "index.html", mcp: [""] }],
  });
  assert.throws(() => validatePrimitive(withMcp, "bad.mjs"), /steps\[0\]\.mcp\[0\]/);
});

test("rejects a step whose output contract reaches outside the build directory", () => {
  for (const outputContract of ["", "/etc/hosts", "../escaped.html"]) {
    const steps = [{ id: "only", systemPrompt: () => "x", allowedTools: ["Write"], outputContract }];
    assert.throws(
      () => validatePrimitive(validPrimitive({ steps }), "bad.mjs"),
      /steps\[0\]\.outputContract/,
      `${JSON.stringify(outputContract)} should be refused`,
    );
  }
});

test("the last step must promise the same file the primitive does", () => {
  const stepped = steppedPrimitive();
  stepped.steps[stepped.steps.length - 1].outputContract = "verify.txt";
  assert.throws(
    () => validatePrimitive(stepped, "bad.mjs"),
    (err) => /verify\.txt/.test(err.message) && /index\.html/.test(err.message),
  );
});

test("rejects a timeout share that is not a positive number of milliseconds", () => {
  for (const timeoutShareMs of [0, -1, "1000", Infinity, NaN]) {
    const stepped = steppedPrimitive();
    stepped.steps[0].timeoutShareMs = timeoutShareMs;
    assert.throws(
      () => validatePrimitive(stepped, "bad.mjs"),
      /steps\[0\]\.timeoutShareMs/,
      `${timeoutShareMs} should be refused`,
    );
  }
});

test("accepts timeout shares that fit inside the primitive's own ceiling", () => {
  const stepped = steppedPrimitive({ timeoutMs: 10000 });
  stepped.steps[0].timeoutShareMs = 4000;
  stepped.steps[1].timeoutShareMs = 6000;
  assert.equal(validatePrimitive(stepped, "chain.mjs"), true);
});

test("rejects timeout shares that add up to more than the build is allowed, naming both numbers", () => {
  const stepped = steppedPrimitive({ timeoutMs: 10000 });
  stepped.steps[0].timeoutShareMs = 7000;
  stepped.steps[1].timeoutShareMs = 6000;
  assert.throws(
    () => validatePrimitive(stepped, "bad.mjs"),
    (err) => err.message.includes("13000") && err.message.includes("10000"),
  );
});

test("a step that leaves its share unstated means whatever is left, so the sum is not checked", () => {
  const stepped = steppedPrimitive({ timeoutMs: 10000 });
  stepped.steps[0].timeoutShareMs = 9999999;
  assert.equal(validatePrimitive(stepped, "chain.mjs"), true);
});

// --- output contracts and startLine -----------------------------------------

test("rejects an output contract that is absolute or climbs out of the build directory", () => {
  for (const outputContract of ["/etc/hosts", "../escaped.html", ".."]) {
    assert.throws(
      () => validatePrimitive(validPrimitive({ outputContract }), "bad.mjs"),
      /outputContract/,
      `${outputContract} should be refused`,
    );
  }
});

test("startLine is optional but must be a function when it is there", () => {
  assert.equal(validatePrimitive(validPrimitive({ startLine: () => "off we go" }), "ok.mjs"), true);
  assert.throws(
    () => validatePrimitive(validPrimitive({ startLine: "off we go" }), "bad.mjs"),
    /startLine/,
  );
});

// --- defaults ---------------------------------------------------------------

test("a primitive with no steps has none, rather than an empty chain", async () => {
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
      // run() branches on truthiness, so [] would take the chain path and
      // spawn nothing at all.
      assert.equal(registry.get("poster").steps, undefined);
    },
  );
});

test("a loaded chain is a copy, so one caller cannot corrupt every later load", async () => {
  await withTempPrimitives(
    { "chain.mjs": primitiveSource(`{
      id: "chain",
      systemPrompt: () => "x",
      allowedTools: ["Write"],
      outputContract: "index.html",
      doneLine: () => "done",
      timeoutMs: 1000,
      steps: [
        { id: "plan", systemPrompt: () => "p", allowedTools: ["Write"], outputContract: "plan.md" },
        { id: "build", systemPrompt: () => "b", allowedTools: ["Write"], outputContract: "index.html" },
      ],
    }`) },
    async (dirUrl) => {
      const first = await loadRegistry(dirUrl);
      first.get("chain").steps[0].id = "vandalised";
      first.get("chain").steps.push({ id: "extra" });

      // The module cache hands back the same object on the second import.
      const second = await loadRegistry(dirUrl);
      assert.equal(second.get("chain").steps.length, 2);
      assert.equal(second.get("chain").steps[0].id, "plan");
    },
  );
});

// --- the real chained primitive ---------------------------------------------

test("loads the real marketing-site primitive as a three-step chain", async () => {
  const registry = await loadRegistry(PRIMITIVES);
  const site = registry.get("marketing-site");

  assert.ok(site, "marketing-site should be registered");
  assert.deepEqual(site.steps.map((s) => s.id), ["plan", "build-pages", "verify"]);
  // The last step's contract is what the whole build is judged on.
  assert.equal(site.steps[site.steps.length - 1].outputContract, site.outputContract);
  // The planning step must not be holding the tools that write the site.
  assert.deepEqual(site.steps[0].allowedTools, ["Write"]);
});

test("every marketing-site step prompt renders before anything has been built", async () => {
  const registry = await loadRegistry(PRIMITIVES);
  const site = registry.get("marketing-site");
  // What the FIRST step is handed. Rendering a later step's prompt with it is
  // artificial on purpose: a prompt that reaches into previous.artifact.length,
  // or any other property of a thing that is null on step one, throws inside
  // buildSpawnArgs and rejects the whole build rather than failing it.
  const params = {
    subject: "a coffee roaster",
    vibe: "warm",
    previous: { dir: "/tmp/build", id: null, artifact: null },
  };

  for (const step of site.steps) {
    const prompt = step.systemPrompt(params);
    assert.equal(typeof prompt, "string", `${step.id} should render a string`);
    assert.ok(prompt.trim().length > 0, `${step.id} rendered an empty prompt`);
  }
  assert.ok(site.systemPrompt(params).includes("a coffee roaster"));
});

test("the marketing-site steps fit inside the time the build is allowed", async () => {
  const registry = await loadRegistry(PRIMITIVES);
  const site = registry.get("marketing-site");
  const total = site.steps.reduce((sum, s) => sum + s.timeoutShareMs, 0);
  assert.ok(total <= site.timeoutMs, `${total}ms of steps in a ${site.timeoutMs}ms build`);
});
