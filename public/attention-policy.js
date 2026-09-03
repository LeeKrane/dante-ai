// Pure decisions about a watcher's fired report once it reaches this page --
// whether the wire's `kind` names one, and whether the news it carries is
// worth holding past the ordinary two-minute expiry every other
// announcement gets (public/playback-policy.js's ANNOUNCEMENT_TTL_MS).
//
// No imports, like every other public/*-policy.js module: browser-safe, no
// DOM, testable without a page.

// The three kinds a watcher's own report can carry over the wire -- mirrors
// lib/announcements.js's ANNOUNCE_KINDS minus "other", which is everything
// this page already knew how to handle before watchers existed.
export const WATCH_KINDS = new Set(["watch-blocked", "watch-idle", "watch-gone"]);

// isWatchKind(kind) -> whether the wire's `kind` names a watcher's own
// report. A value this page does not recognise -- missing, or a kind from a
// future version of the wire format -- is never treated as one: an unknown
// kind is exactly as ordinary as "other" is.
export function isWatchKind(kind) {
  return WATCH_KINDS.has(kind);
}

// retainAnnouncement(item, now, ttlMs) -> whether an announcement survives
// past the ordinary hold time.
//
// A blocked report is the one kind of news the generic needs-attention line
// is deliberately suppressed for (server.js's reportAttention) -- a watcher
// covers it instead, and this is the only place that ever will. Riding the
// ordinary TTL, it would silently wedge someone mid-conversation: their own
// session sits on a permission prompt and nothing would ever tell them so.
// Everything else -- a finished or gone report, and every ordinary
// announcement -- keeps the ordinary rule: a session that finished two
// minutes ago is not news, and it already landed in the recap log.
export function retainAnnouncement(item, now, ttlMs) {
  if (item?.kind === "watch-blocked") return true;
  return Number.isFinite(item?.at) && now - item.at < ttlMs;
}
