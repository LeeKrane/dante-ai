// The fast path for "something happened in a session".
//
// The roster poller is the floor: it notices a session ending within five
// seconds and works for sessions started before Dante existed. Hooks are the
// fast path on top of it -- they fire the moment it happens and they carry the
// one thing polling can never see, which is a session waiting on a person.
//
// They only fire for sessions whose settings had them at startup, so neither
// mechanism replaces the other and both report the same event. Deduplication
// is therefore not a nicety here; it is the difference between one recap entry
// and two saying the same thing.
//
// SECURITY. The endpoint this feeds is loopback-only, and that is its entire
// security model. Any process on this machine can reach it, so nothing it
// carries may become an instruction: a payload reaches lib/notify.js and the
// speaker, and never a model prompt. Everything is capped and stripped here.

export const MAX_DETAIL_CHARS = 200;

// Sized by the thing it actually has to catch: SessionEnd and Stop both fire
// as a session exits, and the roster poller notices the same exit up to a tick
// (five seconds) later. Thirty seconds covers all three reporting one exit. It
// is deliberately not longer -- a session that genuinely finishes twice,
// because something was queued for it, is news both times.
export const DEDUPE_MS = 30_000;

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g;

// Verified against the installed CLI (2.1.245) rather than assumed: these are
// the three whose names appear in the binary and whose meanings are stable.
//
// Stop is the useful one. It fires when a session stops responding, which for
// a background session is the moment its task is done -- minutes before the
// poller notices it leave the roster, if it ever does.
const KIND_BY_EVENT = new Map([
  ["Stop", "complete"],
  ["SessionEnd", "complete"],
  ["Notification", "needs-attention"],
]);

// A session id from a hook payload names a transcript file and a memory record.
// The same alphabet lib/transcript.js insists on, for the same reason.
const SAFE_ID = /^[0-9a-zA-Z_-]{8,80}$/;

function cleanText(value, maxChars) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").replace(UNPRINTABLE, "").trim().slice(0, maxChars);
}

// Loopback is the whole security model of the endpoint, so it is a function
// with tests rather than a comparison written inline once.
//
// IPv4-mapped IPv6 is the form Node reports on a dual-stack listener, and it
// is a real loopback address; anything else, including a hostname or an empty
// string, is not.
export function isLoopback(address) {
  if (typeof address !== "string") return false;
  const addr = address.trim().toLowerCase();
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// parseHookEvent(payload) -> { kind, event, sessionId, cwd, detail } | null
//
// `event` is the CLI's own name for it, kept beside the kind because two of
// them fold into one kind and are not the same moment: Stop is when the work
// ended, SessionEnd is when the process went, which can be an hour later. The
// completion report needs to know which it is holding to say how long the
// session took.
//
// null for anything unrecognised, and deliberately without an error: any local
// process can post here, and a loud failure is a way to make Dante say things.
// Unknown event names are dropped rather than guessed at.
export function parseHookEvent(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const kind = KIND_BY_EVENT.get(payload.hook_event_name);
  if (!kind) return null;

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  // Without an id there is no session to attribute this to, and an
  // unattributable event is one Dante has no business reporting.
  if (!SAFE_ID.test(sessionId)) return null;

  return {
    kind,
    event: payload.hook_event_name,
    sessionId,
    cwd: cleanText(payload.cwd, 300),
    // A Notification carries the reason it is asking; SessionEnd carries how
    // it ended. Both are written by something other than Dante.
    detail: cleanText(payload.message ?? payload.reason ?? "", MAX_DETAIL_CHARS),
  };
}

// One event can arrive twice: a hook firing on retry, or two hooks configured
// for the same thing. Keyed by session and kind, with a short memory.
//
// Bounded on purpose. This is fed by an endpoint any local process can post to,
// so a map that only ever grows is a way to spend this server's memory.
export function createDeduper(opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEDUPE_MS;
  const maxKeys = Number.isFinite(opts.maxKeys) ? opts.maxKeys : 200;
  const seen = new Map();

  return {
    // true when this event is new (and should be acted on), false when it is a
    // repeat of one seen inside the window.
    accept(key, now = Date.now()) {
      if (typeof key !== "string" || !key) return false;

      for (const [k, at] of seen) {
        if (now - at >= windowMs) seen.delete(k);
      }
      const last = seen.get(key);
      if (last !== undefined && now - last < windowMs) return false;

      seen.set(key, now);
      // Oldest first, and only ever by a handful: the sweep above keeps this
      // rare, and the cap is what makes it impossible for it not to be.
      while (seen.size > maxKeys) seen.delete(seen.keys().next().value);
      return true;
    },
    get size() { return seen.size; },
  };
}
