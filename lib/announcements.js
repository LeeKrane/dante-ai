// A shared, pure store for lines nobody asked for: something is offered the
// moment there is news, held until either a page asks for it or it goes
// stale, and forgotten either way. Pulled out of server.js's own
// pendingAnnouncements Map because the never-stale rule a blocked watcher's
// report needs (see `retain`, below) has two places to apply it -- the sweep
// that runs whenever something new is offered, and the re-check a page's
// late "I'll take that one" makes -- and a rule duplicated in two places is a
// rule that drifts the first time only one of them is touched.

// createPending({ ttlMs, max, retain, now }) -> { offer, take, live, clear }
//
// `ttlMs` is the ordinary hold time; `max` (default 10) is how many entries
// this may ever hold at once, oldest evicted first -- without a default,
// `entries.size > undefined` is always false and a caller that omits `max`
// gets an unbounded store instead of the cap this comment promises.
// `retain(entry, at)` is the injected
// staleness override: true keeps an entry alive past ttlMs entirely (a
// blocked report -- nothing else will ever say it), false falls through to
// the ordinary ttlMs rule. Retained is NOT the same as unbounded, though:
// `max` newer offers still evict a retained entry oldest-first the same as
// any other -- retain buys immunity from going stale, not from running out
// of room. `now` is an injectable clock (defaults to Date.now), consulted by
// `offer` for its own timestamp and used as the default for `take`/`live`
// when a caller does not already have "now" in hand from elsewhere in the
// same tick.
export function createPending({ ttlMs, max = 10, retain = () => false, now = Date.now } = {}) {
  const entries = new Map();
  let seq = 0;

  function isLive(entry, at) {
    return retain(entry, at) || at - entry.at < ttlMs;
  }

  function sweep(at) {
    for (const [id, entry] of entries) {
      if (!isLive(entry, at)) entries.delete(id);
    }
  }

  return {
    // offer(text, meta) -> { id, entry } | null. Refuses empty text outright
    // -- nothing to hold, nothing to offer. `meta` rides along on the entry
    // unchanged (server.js uses it for `kind` and `sessionId`).
    offer(text, meta = {}) {
      const line = typeof text === "string" ? text.trim() : "";
      if (!line) return null;

      const at = now();
      // Swept before inserting, not after: a page that never asks for
      // anything must not make this grow for the life of the process, and
      // the entry being added right now is never itself stale.
      sweep(at);

      const id = `announce-${++seq}`;
      // meta spread first, id last: a meta carrying its own `id` field (a
      // caller passing through some other object's shape, say) must not be
      // able to displace the generated key everything else here is keyed by.
      const entry = { ...meta, id, text: line, at };
      entries.set(id, entry);

      // Oldest out first, the eviction rule `retain` does not override.
      while (entries.size > max) {
        entries.delete(entries.keys().next().value);
      }

      return { id, entry };
    },

    // take(id, at) -> entry | null. Removes it either way -- an id that
    // resolves to a since-gone-stale entry is not re-offered by asking again.
    take(id, at = now()) {
      const entry = entries.get(id);
      entries.delete(id);
      if (!entry) return null;
      // Re-checked here, not only at offer time: a page can ask for an entry
      // long after it was offered, well past whatever the sweep in offer()
      // saw at that earlier moment.
      return isLive(entry, at) ? entry : null;
    },

    // live(at) -> every entry still worth having, oldest first -- for a page
    // that just (re)connected to be offered everything it missed.
    live(at = now()) {
      sweep(at);
      return [...entries.values()];
    },

    // clear() -> how many were cleared. A recap just said all of this out
    // loud, so none of it should be offered again.
    clear() {
      const n = entries.size;
      entries.clear();
      return n;
    },
  };
}

// The kinds an announcement can carry over the wire. "other" is every
// generic line this store knew how to hold before watchers existed (a
// session finished, a session needs you); the three watch-* kinds exist so a
// page can single out a watcher's own report -- specifically watch-blocked,
// the one kind that must never go stale -- without ever having to inspect a
// spoken sentence to guess what kind of news it is.
export const ANNOUNCE_KINDS = new Set(["watch-blocked", "watch-idle", "watch-gone", "other"]);

// normalizeKind(kind) -> a value ANNOUNCE_KINDS actually has. Anything else
// -- missing, garbled, a value from a future version of this wire format --
// is "other": an unrecognised kind is ordinary, never never-stale, because
// the never-stale rule is a promise this module keeps for one specific kind
// of news and no other.
export function normalizeKind(kind) {
  return ANNOUNCE_KINDS.has(kind) ? kind : "other";
}

// neverStale(entry) -> whether an entry must survive past the ordinary TTL
// no matter how long it sits. A watcher's blocked report is the one kind of
// news the generic needs-attention line is deliberately suppressed for
// (server.js's reportAttention) -- a watcher covers it instead, and this is
// the only place server-side that ever will, so it cannot be allowed to
// silently expire. server.js passes this straight through as createPending's
// own `retain`. public/attention-policy.js keeps its own copy of this exact
// rule (retainAnnouncement) -- public/ is served straight off disk with no
// bundler and cannot import from here, the same constraint roster-panel.js's
// MAX_ROWS documents -- so a change here must be repeated there by hand.
export function neverStale(entry) {
  return entry?.kind === "watch-blocked";
}
