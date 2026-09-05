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

// neverStale(item) -> whether an item must survive past the ordinary hold
// time no matter how long it sits.
//
// A blocked report is the one kind of news the generic needs-attention line
// is deliberately suppressed for (server.js's reportAttention) -- a watcher
// covers it instead, and this is the only place that ever will. Riding the
// ordinary TTL, it would silently wedge someone mid-conversation: their own
// session sits on a permission prompt and nothing would ever tell them so.
//
// A local copy of lib/announcements.js's own neverStale -- public/ is served
// straight off disk with no bundler and cannot import from lib/, the same
// constraint roster-panel.js's MAX_ROWS documents -- so this is a twin, kept
// in step by hand, not an import. A change to one side must be repeated on
// the other.
function neverStale(item) {
  return item?.kind === "watch-blocked";
}

// retainAnnouncement(item, now, ttlMs) -> whether an announcement survives
// past the ordinary hold time. Everything but a never-stale item -- a
// finished or gone report, and every ordinary announcement -- keeps the
// ordinary rule: a session that finished two minutes ago is not news, and it
// already landed in the recap log.
export function retainAnnouncement(item, now, ttlMs) {
  if (neverStale(item)) return true;
  return Number.isFinite(item?.at) && now - item.at < ttlMs;
}

// How long a fired watch's row lingers in the sessions panel after its
// session leaves the roster outright. A local copy of lib/watch.js's own
// GHOST_MS, kept in step by hand for the same reason neverStale above is a
// twin and not an import -- public/ cannot import from lib/.
export const GHOST_MS = 90_000;

// How long one cue has to answer for itself before another is allowed. A
// blocked report that survives a long, dense exchange (retainAnnouncement,
// above) would otherwise ring on every single pump of the queue while that
// exchange runs -- once is a nudge, more than once a minute is noise nobody
// asked for.
export const CUE_COOLDOWN_MS = 60_000;

// owesCue(stale) -> whether a batch just swept out as stale contains a watch
// kind -- the same test cueFor applies to `stale` below, pulled out on its
// own so app.js can ask it of a batch swept while the floor was busy (and
// cueFor had no chance to run at all), not only of one swept on a pump where
// the floor happened to be free.
export function owesCue(stale) {
  const staleList = Array.isArray(stale) ? stale : [];
  return staleList.some((item) => isWatchKind(item?.kind));
}

// cueFor({ speak, stale, owed, lastCueAt, now, audioReady, cooldownMs }) ->
// whether this pump of the queue is worth a sound.
//
// Worth ringing for: the thing about to be spoken is a blocked report (it is
// the one kind of news nothing else on the page will ever say), one of the
// entries just swept out as stale was a watch kind -- a dropped idle or gone
// report still has its tone, because by the time it is dropped the tone is
// all that is left of it; the recap log has the words -- or `owed` is true,
// meaning an earlier pump swept a watch kind while the floor was busy and
// never got to ring for it (see app.js's `cueOwed`). Never played without a
// real AudioContext running (`audioReady` -- see app.js's own comment on why
// three creation sites exist and only one of them is a user gesture), and
// never twice inside `cooldownMs` of the last time, however much is waiting.
export function cueFor({ speak, stale, owed, lastCueAt, now, audioReady, cooldownMs = CUE_COOLDOWN_MS } = {}) {
  if (!audioReady) return false;
  if (Number.isFinite(lastCueAt) && Number.isFinite(now) && now - lastCueAt < cooldownMs) return false;
  return speak?.kind === "watch-blocked" || owesCue(stale) || Boolean(owed);
}

// attentionPending(queue) -> whether anything still queued is a watcher's own
// report. Drives the orb's extra ring and the tab-title dot -- both are about
// a watcher fire specifically, not any announcement whatsoever, so an
// ordinary "session finished" sitting in the same queue must not light either
// one on its own.
export function attentionPending(queue) {
  const list = Array.isArray(queue) ? queue : [];
  return list.some((item) => isWatchKind(item?.kind));
}

// titleFor(base, pending, hidden) -> the document title to show. The dot
// exists for exactly one moment: a watcher fired while nobody was looking at
// the tab at all. Looking away for a MOMENT (hidden) with nothing pending
// says nothing new; a pending fire with the tab in front of someone is
// already visible as the orb's own ring and needs no dot repeating it in the
// chrome above it.
export function titleFor(base, pending, hidden) {
  return pending && hidden ? `• ${base}` : base;
}
