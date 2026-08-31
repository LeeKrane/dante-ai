// Slack: the durable half of "report back".
//
// Voice is the convenience channel -- it only works when the page is open, the
// floor is free, and someone is in the room. Slack is the one that still holds
// the answer an hour later, on a phone, which is the whole reason a session you
// walked away from is worth starting at all.
//
// Strictly outbound. No Socket Mode, no Events API, no inbound surface of any
// kind: nothing anyone types in Slack can reach this machine. What goes out is
// chat.postMessage rather than an incoming webhook, and that is not a taste
// decision -- a webhook returns only `ok`, and threading needs the message
// timestamp back. One thread per session is the entire point.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "dante", "slack.json");
const API_URL = "https://slack.com/api/chat.postMessage";

// A Slack outage must cost a notification, never a turn, so every call is
// bounded. Five seconds is generous for one small POST and still short enough
// that a stalled Slack cannot pile up timers behind a busy poller.
export const POST_TIMEOUT_MS = 5000;

// Slack's own limit is 40,000 characters. This is far below it on purpose:
// everything posted here is one line about one session, and a runaway summary
// is a symptom, not something to faithfully reproduce.
export const MAX_TEXT_CHARS = 1500;

// The same class as lib/memory.js, with the line feed left out: a threaded
// reply reads better over two lines than one, so a newline is content here
// rather than noise. Everything else invisible goes, because text reaching
// Slack has passed through a model, a transcript, or a hook payload, and none
// of those are trusted to be printable.
const UNPRINTABLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

function cleanText(value, maxChars = MAX_TEXT_CHARS) {
  if (typeof value !== "string") return "";
  // Carriage returns and tabs are folded into the whitespace they stand for
  // BEFORE the strip, because stripping one instead would fuse the two lines it
  // separated into a single word.
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(UNPRINTABLE, "")
    .trim()
    .slice(0, maxChars);
}

// Slack reads <!channel>, <!here> and <@U123> out of ordinary message text, so
// an untrusted string containing one of them notifies a whole workspace. The
// documented fix is to escape the three characters that open those sequences,
// and it is the only escaping Slack asks for.
export function escapeSlackText(value, maxChars = MAX_TEXT_CHARS) {
  return cleanText(value, maxChars)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Unlike loadFishConfig, a missing file is not an error. Slack is an
// enhancement: someone who never configures it should still get a working
// assistant, not a server that refuses to start.
export function loadSlackConfig(path = DEFAULT_CONFIG_PATH, env = process.env) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path, "utf8")); }
  catch { cfg = {}; }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};

  const botToken = String(env.DANTE_SLACK_TOKEN || cfg.botToken || "");
  const channel = String(env.DANTE_SLACK_CHANNEL || cfg.channel || "");
  // Both or neither. A token with no channel has nowhere to post, and a channel
  // with no token cannot post; reporting either as "enabled" would mean every
  // event failing silently for the life of the process.
  return { botToken, channel, enabled: Boolean(botToken && channel) };
}

// Races a promise against a timer rather than relying on the caller's fetch to
// honour a signal. A real fetch does; an injected one in a test need not, and a
// hung fake that hangs the suite is a worse bug than the one it was testing for.
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// createSlack(cfg, opts) -> { enabled, postParent, postReply }
//
// Always returns an object, enabled or not, so callers never branch on whether
// Slack exists. Disabled, postParent returns null and postReply false, which is
// exactly what a failed post returns -- one code path, not two.
//
// The token is a credential. It appears in the Authorization header and nowhere
// else: not in a log line, not in a debug message, not in anything crossing the
// WebSocket to a browser.
export function createSlack(cfg = {}, opts = {}) {
  const { botToken = "", channel = "" } = cfg ?? {};
  const enabled = cfg?.enabled ?? Boolean(botToken && channel);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? (() => {});
  const url = opts.url ?? API_URL;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : POST_TIMEOUT_MS;

  async function post(text, threadTs) {
    const body = { channel, text: escapeSlackText(text) };
    // An empty message is not worth a round trip, and Slack rejects it anyway.
    if (!body.text) return { ok: false, error: "empty text" };
    if (threadTs) body.thread_ts = threadTs;

    let res;
    try {
      res = await withTimeout(
        doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${botToken}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        }),
        timeoutMs,
      );
    } catch (err) {
      // Never rethrown. The caller is a poller tick or a spoken turn, and
      // neither should fail because a network did.
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) };
    }

    if (res?.timedOut) return { ok: false, error: "timeout" };
    if (!res || typeof res.json !== "function") return { ok: false, error: "no response" };
    // Slack answers HTTP 200 with {ok:false,error:"..."} for most failures, so
    // the status line alone says almost nothing. 429 and 5xx are the exceptions.
    if (res.status !== undefined && res.status !== 200) return { ok: false, error: `http ${res.status}` };

    let json;
    try { json = await res.json(); }
    catch (err) { return { ok: false, error: `bad json (${String(err?.message ?? err).slice(0, 100)})` }; }

    if (!json?.ok) return { ok: false, error: String(json?.error ?? "unknown").slice(0, 200) };
    return { ok: true, ts: typeof json.ts === "string" ? json.ts : null };
  }

  return {
    enabled,

    // The parent of a session's thread. Returns the message ts to store beside
    // the session in memory, or null -- and a null is not an error to report,
    // it just means later events for this session have no thread to land in.
    async postParent(text) {
      if (!enabled) return null;
      const result = await post(text, null);
      if (!result.ok) { log("slack: parent post failed:", result.error); return null; }
      return result.ts;
    },

    // Every later event for a session. Without a ts there is no thread to reply
    // in, and posting to the channel root instead would scatter one session's
    // events across the channel -- the exact thing threading is here to stop.
    async postReply(threadTs, text) {
      if (!enabled) return false;
      if (typeof threadTs !== "string" || !threadTs) return false;
      const result = await post(text, threadTs);
      if (!result.ok) log("slack: reply post failed:", result.error);
      return result.ok;
    },
  };
}
