import test from "node:test";
import assert from "node:assert/strict";
import { parseAction } from "../lib/action.js";

test("returns the spoken reply and the action when the tag has params", () => {
  const { reply, action } = parseAction(
    "On it, sir. [ACTION:BUILD primitive=landing-page subject=coffee]",
  );
  assert.equal(reply, "On it, sir.");
  assert.deepEqual(action, {
    primitive: "landing-page",
    params: { subject: "coffee" },
  });
});

test("returns an empty param bag when the tag carries only a primitive", () => {
  const { reply, action } = parseAction("Right away. [ACTION:BUILD primitive=landing-page]");
  assert.equal(reply, "Right away.");
  assert.deepEqual(action, { primitive: "landing-page", params: {} });
});

test("returns the trimmed reply and no action when there is no tag", () => {
  const { reply, action } = parseAction("  Online and at your service, sir.  ");
  assert.equal(reply, "Online and at your service, sir.");
  assert.equal(action, null);
});

test("matches the tag name regardless of case", () => {
  const lower = parseAction("Done. [action:build primitive=landing-page]");
  assert.deepEqual(lower.action, { primitive: "landing-page", params: {} });

  const mixed = parseAction("Done. [Action:Build Primitive=landing-page Subject=coffee]");
  assert.deepEqual(mixed.action, {
    primitive: "landing-page",
    params: { subject: "coffee" },
  });
});

test("tolerates extra whitespace inside the tag, including around the equals sign", () => {
  const { reply, action } = parseAction(
    "On it. [  ACTION:BUILD   primitive = landing-page    subject =coffee  ]",
  );
  assert.equal(reply, "On it.");
  assert.deepEqual(action, {
    primitive: "landing-page",
    params: { subject: "coffee" },
  });
});

test("splits each pair on the first equals sign so values may contain equals signs", () => {
  const { action } = parseAction(
    "Sure. [ACTION:BUILD primitive=landing-page query=a=b=c]",
  );
  assert.deepEqual(action, {
    primitive: "landing-page",
    params: { query: "a=b=c" },
  });
});

test("treats an empty primitive value as not dispatchable but still cleans the reply", () => {
  const { reply, action } = parseAction("Hmm. [ACTION:BUILD primitive=]");
  assert.equal(reply, "Hmm.");
  assert.equal(action, null);
});

test("returns no action when the tag has no primitive key", () => {
  const { reply, action } = parseAction("Hmm. [ACTION:BUILD subject=coffee]");
  assert.equal(reply, "Hmm.");
  assert.equal(action, null);
});

test("strips a mid-sentence tag without leaving a double space", () => {
  const { reply, action } = parseAction(
    "Right away [ACTION:BUILD primitive=landing-page] sir.",
  );
  assert.equal(reply, "Right away sir.");
  assert.ok(!reply.includes("  "));
  assert.deepEqual(action, { primitive: "landing-page", params: {} });
});

test("collapses stray whitespace and newlines left behind by the tag", () => {
  const { reply } = parseAction("One moment.\n\n[ACTION:BUILD primitive=landing-page]\n");
  assert.equal(reply, "One moment.");
});

test("leaves an unclosed tag alone and reports no action", () => {
  const text = "Working on it. [ACTION:BUILD primitive=landing-page";
  const { reply, action } = parseAction(text);
  assert.equal(reply, text);
  assert.equal(action, null);
});

test("ignores tokens inside the tag that are not key=value pairs", () => {
  const bareWord = parseAction(
    "Fine. [ACTION:BUILD primitive=landing-page orphan subject=coffee]",
  );
  assert.deepEqual(bareWord.action, {
    primitive: "landing-page",
    params: { subject: "coffee" },
  });

  // A token with no key on the left of the equals sign is dropped too.
  const noKey = parseAction("Fine. [ACTION:BUILD =stray primitive=landing-page]");
  assert.deepEqual(noKey.action, { primitive: "landing-page", params: {} });
});

test("strips every tag and dispatches the first one that has a primitive", () => {
  const { reply, action } = parseAction(
    "Sure. [ACTION:BUILD subject=coffee] Starting now. [ACTION:BUILD primitive=landing-page]",
  );
  assert.equal(reply, "Sure. Starting now.");
  assert.deepEqual(action, { primitive: "landing-page", params: {} });
});

test("returns a fresh result object every call, so a caller's edit cannot leak", () => {
  const first = parseAction(null);
  first.reply = "mutated";
  first.action = { primitive: "leaked", params: {} };
  assert.deepEqual(parseAction(undefined), { reply: "", action: null, memory: null, session: null });
});

test("strips quotes around values so a quoted primitive still dispatches", () => {
  const double = parseAction('Sure. [ACTION:BUILD primitive="landing-page"]');
  assert.deepEqual(double.action, { primitive: "landing-page", params: {} });

  const single = parseAction("Sure. [ACTION:BUILD primitive='landing-page']");
  assert.deepEqual(single.action, { primitive: "landing-page", params: {} });
});

test("keeps a quoted value whole so multi-word params are not truncated", () => {
  const { action } = parseAction(
    'On it. [ACTION:BUILD primitive=landing-page subject="a coffee shop"]',
  );
  assert.deepEqual(action, {
    primitive: "landing-page",
    params: { subject: "a coffee shop" },
  });
});

test("leaves a lone quote inside the value alone", () => {
  const { action } = parseAction("On it. [ACTION:BUILD primitive=landing-page subject=o'clock]");
  assert.deepEqual(action, {
    primitive: "landing-page",
    params: { subject: "o'clock" },
  });
});

test("preserves the reply's own line breaks when stripping a tag", () => {
  const { reply } = parseAction("Line one.\nLine two. [ACTION:BUILD primitive=landing-page]");
  assert.equal(reply, "Line one.\nLine two.");

  // A tag alone on its own line collapses to a single newline, not a blank one.
  const own = parseAction("Before.\n[ACTION:BUILD primitive=landing-page]\nAfter.");
  assert.equal(own.reply, "Before.\nAfter.");
});

test("captures a param literally named __proto__ without touching the prototype", () => {
  const { action } = parseAction("Sure. [ACTION:BUILD primitive=x __proto__=polluted]");
  assert.equal(Object.getPrototypeOf(action.params), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(action.params, "__proto__")?.value, "polluted");
  assert.equal({}.polluted, undefined);
});

test("never reads the verb as a param key", () => {
  const { action } = parseAction("Fine. [ACTION:BUILD primitive=landing-page]");
  assert.deepEqual(action, { primitive: "landing-page", params: {} });

  // Padded equals must not let the verb pair up with a following stray "=".
  const stray = parseAction("Fine. [ACTION:BUILD =stray primitive=landing-page]");
  assert.deepEqual(stray.action, { primitive: "landing-page", params: {} });
});

test("dispatches a tag that carries no verb at all", () => {
  const { reply, action } = parseAction("Right. [ACTION: primitive=landing-page]");
  assert.equal(reply, "Right.");
  assert.deepEqual(action, { primitive: "landing-page", params: {} });
});

test("rejects pathological input promptly instead of backtracking", () => {
  // Both of these used to take seconds; the budget is loose enough not to flake.
  const unclosed = `Working. [action:${"a".repeat(100000)}`;
  const padded = `Working. [ACTION:BUILD${" ".repeat(100000)}primitive=landing-page]`;

  const started = Date.now();
  assert.equal(parseAction(unclosed).action, null);
  assert.deepEqual(parseAction(padded).action, { primitive: "landing-page", params: {} });
  assert.ok(Date.now() - started < 1000, "parsing 100k-char input should not take a second");
});

test("never throws on malformed or non-string input", () => {
  for (const bad of [null, undefined, 42, {}, [], true, () => {}]) {
    assert.deepEqual(parseAction(bad), { reply: "", action: null, memory: null, session: null });
  }
  assert.deepEqual(parseAction(""), { reply: "", action: null, memory: null, session: null });
  assert.deepEqual(parseAction("[]"), { reply: "[]", action: null, memory: null, session: null });
  assert.deepEqual(parseAction("[ACTION:BUILD]"), { reply: "", action: null, memory: null, session: null });
  assert.deepEqual(parseAction("[ACTION:BUILD ===]"), { reply: "", action: null, memory: null, session: null });
});

test("returns clean speech, a dispatchable action, and captured preferences when both tags appear", () => {
  const { reply, action, memory } = parseAction(
    "On it, sir. [MEMORY:SET palette=dark] [ACTION:BUILD primitive=landing-page subject=coffee]",
  );
  assert.equal(reply, "On it, sir.");
  assert.deepEqual(action, { primitive: "landing-page", params: { subject: "coffee" } });
  assert.deepEqual(memory, { palette: "dark" });
});

test("merges preferences across multiple memory tags, with the later tag winning on a duplicate key", () => {
  const { reply, memory } = parseAction(
    "Noted. [MEMORY:SET palette=dark tone=formal] [MEMORY:SET palette=light]",
  );
  assert.equal(reply, "Noted.");
  assert.deepEqual(memory, { palette: "light", tone: "formal" });
});

test("keeps a quoted value whole in a memory tag", () => {
  const { memory } = parseAction('Noted. [MEMORY:SET tone="confident, understated"]');
  assert.deepEqual(memory, { tone: "confident, understated" });
});

test("returns no memory when a memory tag carries no pairs", () => {
  const { reply, memory } = parseAction("Noted. [MEMORY:SET]");
  assert.equal(reply, "Noted.");
  assert.equal(memory, null);
});

test("leaves a tag in an unknown namespace untouched in the spoken reply", () => {
  const { reply, action, memory } = parseAction("Sure. [NOTE:foo bar=1] Done.");
  assert.equal(reply, "Sure. [NOTE:foo bar=1] Done.");
  assert.equal(action, null);
  assert.equal(memory, null);
});

test("returns no action when only a memory tag is present", () => {
  const { action, memory } = parseAction("Noted. [MEMORY:SET palette=dark]");
  assert.equal(action, null);
  assert.deepEqual(memory, { palette: "dark" });
});

test("matches the memory tag name regardless of case", () => {
  const lower = parseAction("Noted. [memory:set palette=dark]");
  assert.deepEqual(lower.memory, { palette: "dark" });

  const mixed = parseAction("Noted. [Memory:Set Palette=dark]");
  assert.deepEqual(mixed.memory, { palette: "dark" });
});

// ---------------------------------------------------------------------------
// [ACTION:SESSION ...]
// ---------------------------------------------------------------------------

test("a session tag says what to do to which repository", () => {
  const { reply, session, action } = parseAction(
    'Starting it now, sir. [ACTION:SESSION verb=start repo=jarvis task="fix the failing builder test" kind=tests]',
  );
  assert.equal(reply, "Starting it now, sir.");
  assert.deepEqual(session, {
    verb: "start",
    repo: "jarvis",
    task: "fix the failing builder test",
    kind: "tests",
  });
  // A session is not a build, and dispatching one as the other would look up a
  // primitive named after a repository.
  assert.equal(action, null);
});

test("the verb is read whatever case it was written in", () => {
  assert.deepEqual(parseAction("[action:session VERB=Start repo=jarvis task=x]").session, {
    verb: "start",
    repo: "jarvis",
    task: "x",
  });
});

test("a session tag with no verb is a garbled tag rather than a guess", () => {
  assert.equal(parseAction("[ACTION:SESSION repo=jarvis task=x]").session, null);
  assert.equal(parseAction("[ACTION:SESSION]").session, null);
  assert.equal(parseAction("[ACTION:SESSION verb=]").session, null);
});

test("a build tag is still a build, and never a session", () => {
  const { action, session } = parseAction("[ACTION:BUILD primitive=landing-page subject=coffee]");
  assert.deepEqual(action, { primitive: "landing-page", params: { subject: "coffee" } });
  assert.equal(session, null);
});

test("a session tag and a memory tag in one reply both apply", () => {
  const { session, memory, reply } = parseAction(
    'Noted. [MEMORY:SET palette=dark] [ACTION:SESSION verb=start repo=jarvis task="build it"]',
  );
  assert.equal(reply, "Noted.");
  assert.deepEqual(memory, { palette: "dark" });
  assert.equal(session.verb, "start");
});

test("two session tags in one reply means the first one, not both", () => {
  // A model that changed its mind mid-sentence starts one session, not two.
  const { session } = parseAction(
    "[ACTION:SESSION verb=start repo=jarvis task=first] [ACTION:SESSION verb=start repo=jarvis task=second]",
  );
  assert.equal(session.task, "first");
});

test("a then= key on a start names a successor task", () => {
  const { session } = parseAction(
    '[ACTION:SESSION verb=start repo=jarvis task="fix the tests" then="run the linter"]',
  );
  assert.deepEqual(session, {
    verb: "start",
    repo: "jarvis",
    task: "fix the tests",
    then: "run the linter",
  });
});

test("a session tag is stripped from the spoken text like every other tag", () => {
  const { reply } = parseAction("On it.\n[ACTION:SESSION verb=stop name=jarvis-1]");
  assert.equal(reply, "On it.");
});

test("a recap tag names no session and takes no other keys", () => {
  const { reply, session, action } = parseAction("Let me check, sir. [ACTION:SESSION verb=recap]");
  assert.equal(reply, "Let me check, sir.");
  assert.deepEqual(session, { verb: "recap" });
  assert.equal(action, null);
});

test("the recap verb parses like any other, whatever case it was written in", () => {
  assert.deepEqual(parseAction("[action:session VERB=Recap]").session, { verb: "recap" });
});
