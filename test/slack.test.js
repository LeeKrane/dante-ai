import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_TEXT_CHARS,
  createSlack,
  escapeSlackText,
  loadSlackConfig,
} from "../lib/slack.js";

const CFG = { botToken: "xoxb-not-a-real-token", channel: "C123" };

// Records every call and answers with whatever the queue holds. Nothing here
// touches the network: a test that could post to a real workspace is a test
// nobody can run twice.
function fakeFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return { status: 200, json: async () => next };
  };
  fn.calls = calls;
  return fn;
}

function withTempConfig(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-slack-"));
  const path = join(dir, "slack.json");
  try {
    if (contents !== null) writeFileSync(path, contents);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// loadSlackConfig
// ---------------------------------------------------------------------------

test("a missing Slack config is a working install, not a startup error", () => {
  withTempConfig(null, (path) => {
    const cfg = loadSlackConfig(path, {});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.botToken, "");
    assert.equal(cfg.channel, "");
  });
});

test("a config file with both halves enables Slack", () => {
  withTempConfig(JSON.stringify(CFG), (path) => {
    const cfg = loadSlackConfig(path, {});
    assert.deepEqual(cfg, { botToken: CFG.botToken, channel: CFG.channel, enabled: true });
  });
});

test("the environment beats the file, so a token need never be written to disk", () => {
  withTempConfig(JSON.stringify(CFG), (path) => {
    const cfg = loadSlackConfig(path, { JARVIS_SLACK_TOKEN: "xoxb-env", JARVIS_SLACK_CHANNEL: "C999" });
    assert.equal(cfg.botToken, "xoxb-env");
    assert.equal(cfg.channel, "C999");
  });
});

test("half a configuration is not a configuration", () => {
  // A token with nowhere to post and a channel with no way to post both look
  // enabled and then fail on every single event for the life of the process.
  withTempConfig(JSON.stringify({ botToken: "xoxb-only" }), (path) => {
    assert.equal(loadSlackConfig(path, {}).enabled, false);
  });
  withTempConfig(JSON.stringify({ channel: "C123" }), (path) => {
    assert.equal(loadSlackConfig(path, {}).enabled, false);
  });
});

test("a config file that is not an object is ignored rather than trusted", () => {
  withTempConfig("[1, 2, 3]", (path) => {
    assert.equal(loadSlackConfig(path, {}).enabled, false);
  });
  withTempConfig("{ this is not json", (path) => {
    assert.equal(loadSlackConfig(path, {}).enabled, false);
  });
});

// ---------------------------------------------------------------------------
// escapeSlackText
// ---------------------------------------------------------------------------

test("a summary that says at-channel cannot notify a workspace", () => {
  // The whole reason this function exists. Slack reads these sequences out of
  // ordinary message text, and the text here came from a model or a transcript.
  assert.equal(escapeSlackText("<!channel> ship it"), "&lt;!channel&gt; ship it");
  assert.equal(escapeSlackText("<!here>"), "&lt;!here&gt;");
  assert.equal(escapeSlackText("<@U024BE7LH>"), "&lt;@U024BE7LH&gt;");
});

test("an ampersand is escaped first, so an escape cannot be escaped twice", () => {
  assert.equal(escapeSlackText("a & <b>"), "a &amp; &lt;b&gt;");
});

test("a newline survives but the rest of the invisible characters do not", () => {
  const rlo = String.fromCharCode(0x202e);
  const nul = String.fromCharCode(0);
  assert.equal(escapeSlackText("one\ntwo"), "one\ntwo");
  assert.equal(escapeSlackText("one\r\ntwo"), "one\ntwo");
  assert.equal(escapeSlackText("one\ttwo"), "one two");
  assert.equal(escapeSlackText("a" + rlo + "b"), "ab");
  assert.equal(escapeSlackText("a" + nul + "b"), "ab");
});

test("a runaway summary is cut rather than posted whole", () => {
  const long = "x".repeat(MAX_TEXT_CHARS * 2);
  assert.equal(escapeSlackText(long).length, MAX_TEXT_CHARS);
});

test("anything that is not a string is nothing to post", () => {
  for (const value of [null, undefined, 42, {}, ["a"]]) {
    assert.equal(escapeSlackText(value), "");
  }
});

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

test("Slack unconfigured posts nothing and reports it without throwing", async () => {
  const fetch = fakeFetch([{ ok: true, ts: "1.1" }]);
  const slack = createSlack({}, { fetch });
  assert.equal(slack.enabled, false);
  assert.equal(await slack.postParent("started"), null);
  assert.equal(await slack.postReply("1.1", "done"), false);
  assert.equal(fetch.calls.length, 0);
});

test("a parent post returns the timestamp its thread will hang from", async () => {
  const fetch = fakeFetch([{ ok: true, ts: "1700000000.000100" }]);
  const slack = createSlack(CFG, { fetch });
  assert.equal(await slack.postParent("jarvis-1 started"), "1700000000.000100");
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(fetch.calls[0].body, { channel: "C123", text: "jarvis-1 started" });
  assert.equal("thread_ts" in fetch.calls[0].body, false);
});

test("a reply names the thread it belongs to", async () => {
  const fetch = fakeFetch([{ ok: true, ts: "2.2" }]);
  const slack = createSlack(CFG, { fetch });
  assert.equal(await slack.postReply("1.1", "done in 4m"), true);
  assert.equal(fetch.calls[0].body.thread_ts, "1.1");
  assert.equal(fetch.calls[0].body.text, "done in 4m");
});

test("a reply with no thread to land in is not posted to the channel instead", async () => {
  // Posting it at the channel root would scatter one session's events across
  // the channel, which is the exact thing threading is here to prevent.
  const fetch = fakeFetch([{ ok: true, ts: "2.2" }]);
  const slack = createSlack(CFG, { fetch });
  assert.equal(await slack.postReply(null, "done"), false);
  assert.equal(await slack.postReply("", "done"), false);
  assert.equal(fetch.calls.length, 0);
});

test("an empty message is not worth a round trip", async () => {
  const fetch = fakeFetch([{ ok: true, ts: "1.1" }]);
  const slack = createSlack(CFG, { fetch });
  assert.equal(await slack.postParent("   "), null);
  assert.equal(await slack.postParent(null), null);
  assert.equal(fetch.calls.length, 0);
});

test("the token rides in the header and appears nowhere else", async () => {
  // It is a credential: never in a log line, a debug message, or the body.
  const logged = [];
  const fetch = fakeFetch([{ ok: false, error: "channel_not_found" }]);
  const slack = createSlack(CFG, { fetch, log: (...args) => logged.push(args.join(" ")) });
  await slack.postParent("hello");
  assert.equal(fetch.calls[0].init.headers.authorization, `Bearer ${CFG.botToken}`);
  assert.equal(fetch.calls[0].init.body.includes(CFG.botToken), false);
  assert.equal(logged.join(" ").includes(CFG.botToken), false);
  assert.match(logged.join(" "), /channel_not_found/);
});

test("Slack answering ok false is a failed post even though the HTTP call worked", async () => {
  // chat.postMessage returns 200 with {ok:false,error:...} for most failures,
  // so a status check alone would report every one of them as a success.
  const slack = createSlack(CFG, { fetch: fakeFetch([{ ok: false, error: "not_in_channel" }]) });
  assert.equal(await slack.postParent("hello"), null);
});

test("a rate limit or a server error is a failed post, not an exception", async () => {
  const slack = createSlack(CFG, {
    fetch: fakeFetch([() => ({ status: 429, json: async () => ({ ok: false }) })]),
  });
  assert.equal(await slack.postParent("hello"), null);
});

test("a network that is simply down costs a notification, never a turn", async () => {
  const slack = createSlack(CFG, { fetch: fakeFetch([new Error("getaddrinfo ENOTFOUND slack.com")]) });
  assert.equal(await slack.postParent("hello"), null);
  assert.equal(await slack.postReply("1.1", "hello"), false);
});

test("a response that is not JSON at all is a failed post", async () => {
  const slack = createSlack(CFG, {
    fetch: fakeFetch([() => ({ status: 200, json: async () => { throw new Error("Unexpected token <"); } })]),
  });
  assert.equal(await slack.postParent("hello"), null);
});

test("a Slack that never answers gives up rather than holding the caller open", async () => {
  const slack = createSlack(CFG, {
    fetch: () => new Promise(() => {}), // resolves never
    timeoutMs: 20,
  });
  assert.equal(await slack.postParent("hello"), null);
});

test("a parent post with no timestamp back is not a thread anyone can reply to", async () => {
  const slack = createSlack(CFG, { fetch: fakeFetch([{ ok: true }]) });
  assert.equal(await slack.postParent("hello"), null);
});
