// Cross-session memory: one JSON file, keyed by the directory the server was
// started from. Mirrors lib/builder.js's shape on purpose — pure functions
// that are cheap to unit-test (denyRules, buildSettings there; sanitizePreferences,
// capArtifacts here), impure functions that never throw and degrade to a safe
// default (readSharedSettings there; loadStore/saveStore here).
//
// Mutate-in-place is deliberate, not an oversight: server.js holds one
// long-lived store for the process lifetime. A copy-on-write API would mean
// `memoryStore = touchProject(...)` at every call site, and one forgotten
// reassignment silently drops a preference. touchProject/recordArtifact/
// applyMemoryTag all mutate the store and return it so call sites can chain
// or ignore the return value.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { homedir } from "node:os";
import { KINDS } from "./notify.js";
import { MAX_BRIEF_CHARS, cleanBrief } from "./interview.js";

export const DEFAULT_PATH = join(homedir(), ".config", "dante", "memory.json");

// Preference text and the summary are folded back into a system prompt on
// every future turn (see the persona wiring lib/brain.js will grow in Stage
// 3), which makes this store a persistence surface for prompt injection. The
// caps below are a security boundary, not a tidiness knob — do not loosen
// them without re-reading that sentence.
export const MAX_ARTIFACTS_PER_PROJECT = 10; // "what did we build lately" needs a handful, not a history
export const MAX_PREFERENCE_KEYS = 20; // bounds how much standing prose ends up in every future prompt
export const MAX_KEY_CHARS = 40; // a preference key is a short label, not a sentence
export const MAX_VALUE_CHARS = 120; // long enough for a real preference, short enough to bound the prompt
export const MAX_SUMMARY_CHARS = 600; // a couple of sentences, not a transcript (see the guide, 1.3)
export const MAX_WORKSPACES = 20; // a person orchestrates a handful of repositories, not a filesystem
const MAX_ALIAS_CHARS = 40; // an alias is a word someone says out loud

// A [MEMORY:SET workspace:fitness=/home/you/dev/KraneticFitness] pair names a
// repository rather than states a preference. The prefix is what keeps the two
// apart in one tag namespace: without it, a path would be stored as standing
// prose and folded into every future prompt, and an alias would never become a
// directory anything could run in.
export const WORKSPACE_PREFIX = "workspace:";

// [MEMORY:SET main=fitness] names which known workspace a session starts in
// when nobody says a repository out loud. Same reasoning as WORKSPACE_PREFIX
// above: it is an instruction about a workspace, not a preference, so it must
// never fall through to sanitizePreferences and end up as standing prose.
export const MAIN_KEY = "main";

// A follow-up waiting for a busy session to go idle. Capped and expiring for
// the obvious reason: a sentence said two hours ago must not surprise a session
// tomorrow, and a person who keeps talking at a busy session must not be able
// to queue a hundred instructions it will then run in order.
export const MAX_QUEUED_PER_SESSION = 3;
// MAX_QUEUED_CHARS still caps the chained task text (chainAfter, below) and
// anything else in this file that stores a plain sentence. The queued tell
// itself no longer uses it: queueForSession may now be holding a whole brief
// -- the same text a tell or interrupt hands lib/peer.js -- and this store is
// one JSON file (loadStore/saveStore), so a brief's line breaks are just `\n`
// inside a JSON string, not a hazard to the format. It is cleaned and capped
// with cleanBrief/MAX_BRIEF_CHARS from lib/interview.js instead, the same cap
// and cleaner a peer-channel or cold-resume delivery already applies.
export const MAX_QUEUED_CHARS = 400;
export const QUEUE_TTL_MS = 30 * 60 * 1000;

// Sessions Dante started, kept so a name can be resolved back to what it was
// asked to do after the fact. Their own bucket rather than the artifacts list:
// artifacts answer "what did we build lately", and ten sessions would push
// every build out of that answer within an afternoon.
export const MAX_SESSIONS_REMEMBERED = 20;

// "What happened while I was out." A couple of dozen entries, because this
// answers one spoken paragraph (lib/notify.js's formatRecap), not a history --
// a day busy enough to fill it is a day the recap already has to summarise
// rather than recite.
export const MAX_EVENTS = 24;

// Same character class lib/progress.js:38 strips, redeclared here rather than
// imported (progress.js is a client-facing module with its own reasons to
// change independently). Control characters could forge fake structure the
// next time this text is rendered; bidi overrides could reverse how it reads
// on screen. Both are live risks for text that a model — or a user speaking
// through it — ultimately supplies.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Keys that would reach out of the plain object shape and into the prototype
// chain if ever assigned with bracket notation. Checked by both raw and
// cleaned form, since padding or case is an easy way to smuggle one past a
// naive check ("  __PROTO__  " lowercases and trims right back to it).
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function emptyStore() {
  return { version: 1, projects: {}, workspaces: {}, main: null };
}

function stripUnprintable(value) {
  return String(value).replace(UNPRINTABLE, "");
}

// Shared cleanup for anything that ends up back in a prompt: strip control
// characters first (so they can't survive inside a collapsed whitespace run),
// collapse whitespace so a multi-line injection attempt becomes one line,
// trim, then clip to the caller's cap.
function cleanText(value, maxChars) {
  // Strings only. It used to stringify whatever it was handed, which meant a
  // null arrived as the text "null" and was stored as though someone had said
  // it — a preference reading "null", a queued follow-up telling a session the
  // word null.
  if (typeof value !== "string") return "";
  return stripUnprintable(value).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

// Best-effort load: a parse error, a missing file, a non-object top level, or
// a missing/non-object `projects` all degrade to "no memory" rather than
// crashing startup — same posture as readSharedSettings() in lib/builder.js.
// Never throws.
export function loadStore(path = DEFAULT_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.projects &&
      typeof parsed.projects === "object" &&
      !Array.isArray(parsed.projects)
    ) {
      // `main` absent entirely is just a file saved before this field existed
      // and is left alone -- callers read it through getMainRepo, which
      // already treats a missing value as "none". A *present* value is
      // different: it was written by this process at some point, and if it no
      // longer names something getWorkspace itself would accept as a workspace
      // -- renamed away, or a hand-edited entry with no path (`{ jarvis: {} }`)
      // -- keeping it would have every future getMainRepo call report a
      // repository nothing can actually run in. getWorkspace, not a bare key
      // lookup, is what catches both: that gets corrected here, once, rather
      // than at every read site.
      if (parsed.main != null) {
        if (typeof parsed.main !== "string" || !getWorkspace(parsed, parsed.main)) {
          parsed.main = null;
        }
      }
      return parsed;
    }
  } catch {
    // Falls through to the empty store below: absent file, unreadable file,
    // and invalid JSON all land here identically.
  }
  return emptyStore();
}

// Atomic write. The tmp file is a sibling of the target (`${path}.<pid>.tmp`)
// rather than a system tmpdir, because renameSync across filesystems fails
// with EXDEV — a sibling is guaranteed to share a filesystem with the target.
// mode 0o600 because this file can carry standing preferences under the
// user's own $HOME/.config. On any failure the tmp file is removed
// best-effort and the function returns false; it never throws, so a bad
// write never takes the server down mid-turn.
export function saveStore(store, path = DEFAULT_PATH) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Either the write never got far enough to create it, or it's already
      // gone — nothing left to clean up.
    }
    return false;
  }
}

export function getProject(store, cwd) {
  return store?.projects?.[cwd] ?? null;
}

// The interesting, pure logic: turns an arbitrary parsed key/value bag (the
// [MEMORY:SET ...] tag's payload, eventually) into text that is safe to keep
// and safe to re-feed to a model forever. Per-entry only — it has no notion
// of "already present" preferences, so the MAX_PREFERENCE_KEYS cap (which
// needs that context to keep updates to existing keys working) is enforced
// by applyMemoryTag, the one caller that has the project in hand.
export function sanitizePreferences(bag) {
  const out = {};
  if (!bag || typeof bag !== "object") return out;

  for (const rawKey of Object.keys(bag)) {
    if (RESERVED_KEYS.has(rawKey)) continue;

    const key = stripUnprintable(rawKey).toLowerCase().trim().slice(0, MAX_KEY_CHARS);
    if (!key || RESERVED_KEYS.has(key)) continue;
    // A workspace pair is a directory, not a standing preference:
    // applyWorkspaceTag owns it. Left here it would be stored as prose and
    // folded into every future prompt, which is both useless and a path
    // disclosed on every turn.
    if (key.startsWith(WORKSPACE_PREFIX)) continue;
    // Same reasoning, for the same-shaped reason: applyWorkspaceTag owns this
    // key, and left here it would be stored as the standing preference "main"
    // rather than ever reaching setMainRepo.
    if (key === MAIN_KEY) continue;

    // An empty value is a malformed tag far more often than an intent to
    // forget a preference — there is no deletion verb in v1, so silently
    // dropping it is safer than writing an empty string over a real value.
    const value = cleanText(bag[rawKey], MAX_VALUE_CHARS);
    if (!value) continue;

    out[key] = value;
  }
  return out;
}

// Keeps only the newest entries. Artifacts are always appended in
// chronological order, so "newest" is just "the tail of the array."
export function capArtifacts(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(-MAX_ARTIFACTS_PER_PROJECT);
}

// Mutates store.projects[cwd]; creates the record with defaults when absent.
// Preferences are merged, never replaced, so a patch that only sets
// `sessionId` can never clobber standing preferences. The summary is clipped
// and stripped here (not in sanitizePreferences, which is preference-shaped)
// because it is the same injection surface: this text also gets read back
// into a system prompt on every future turn.
export function touchProject(store, cwd, patch = {}) {
  const existing = store.projects[cwd] ?? {
    sessionId: null,
    summary: "",
    preferences: {},
    artifacts: [],
  };

  const next = { ...existing, ...patch };
  next.preferences = { ...existing.preferences, ...(patch.preferences ?? {}) };
  if (typeof patch.summary === "string") {
    next.summary = stripUnprintable(patch.summary).slice(0, MAX_SUMMARY_CHARS);
  }
  next.updatedAt = new Date().toISOString();

  store.projects[cwd] = next;
  return store;
}

// Mutates store.projects[cwd].artifacts; creates the project record via
// touchProject when absent so recordArtifact never has to duplicate the
// default-shape logic.
export function recordArtifact(store, cwd, entry) {
  if (!store.projects[cwd]) touchProject(store, cwd, {});
  const project = store.projects[cwd];
  project.artifacts = capArtifacts([
    ...(project.artifacts ?? []),
    { ...entry, at: new Date().toISOString() },
  ]);
  return store;
}

// The seam Stage 2's [MEMORY:SET ...] tag calls. Runs the already-parsed
// key/value bag through sanitizePreferences, then enforces MAX_PREFERENCE_KEYS
// against the project's *existing* preference count: keys already present can
// always be updated (so a standing preference never becomes unstable just
// because the bag happens to arrive after nineteen others), but a new key is
// refused once the cap is reached. Mutates the store via touchProject when
// anything survives. Returns the subset actually saved, or null when nothing
// survived sanitization or the cap — so the caller (eventually brain.js) can
// stay quiet instead of narrating a no-op.
export function applyMemoryTag(store, cwd, memory) {
  const cleaned = sanitizePreferences(memory);
  if (Object.keys(cleaned).length === 0) return null;

  const existing = getProject(store, cwd)?.preferences ?? {};
  let keyCount = Object.keys(existing).length;

  const toSave = {};
  for (const [key, value] of Object.entries(cleaned)) {
    // hasOwnProperty, not `key in existing`: `in` walks the prototype chain,
    // so an inherited name would read as "already present" and slip past the
    // new-key cap.
    const isNew = !Object.prototype.hasOwnProperty.call(existing, key);
    if (isNew) {
      if (keyCount >= MAX_PREFERENCE_KEYS) continue;
      keyCount += 1;
    }
    toSave[key] = value;
  }

  if (Object.keys(toSave).length === 0) return null;

  touchProject(store, cwd, { preferences: toSave });
  return toSave;
}

// ---------------------------------------------------------------------------
// Workspaces: the repositories a session can be started in
// ---------------------------------------------------------------------------
//
// A cwd is not a thing anyone says aloud. A workspace is just one alias —
// "jarvis", "fitness" — bound to one absolute directory. (A session's number,
// unlike its old per-repository counter, is not stored here at all: it is
// computed fresh on every roster tick by lib/agents.js's orderRoster.)
//
// The path check below is a SECURITY BOUNDARY, not tidiness. Everything else
// in this file guards text that ends up back in a prompt; this guards a string
// that becomes the working directory of a real Claude Code session with file
// tools on. It is resolved through the filesystem — symlinks and all — before
// it is compared to $HOME, because a symlink inside the home directory
// pointing at / would otherwise pass a prefix check and then run somewhere
// else entirely.

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Aliases are spoken, so the character set is deliberately narrow: anything
// that is not a letter, a digit or a dash becomes a dash, because a person
// saying "fitness" cannot pronounce the difference between an underscore and a
// space and should not have to.
export function sanitizeAlias(value) {
  // Strings only. cleanText stringifies whatever it is handed, so a null here
  // would come back as the alias "null" and a whole repository would end up
  // filed under it.
  if (typeof value !== "string") return "";

  // Checked before the transformation as well as after: "__PROTO__" survives
  // trimming and casing back to a reserved name, and collapsing punctuation
  // would turn it into the innocuous-looking "proto" rather than refusing it.
  const raw = stripUnprintable(value).toLowerCase().trim();
  if (RESERVED_KEYS.has(raw)) return "";

  const cleaned = cleanText(value, MAX_ALIAS_CHARS * 2)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ALIAS_CHARS);
  if (!cleaned || RESERVED_KEYS.has(cleaned)) return "";
  return cleaned;
}

// The alias a directory gets when nobody chose one: its own basename.
export function aliasFromPath(path) {
  return typeof path === "string" ? sanitizeAlias(basename(path)) : "";
}

// resolveWorkspacePath(input, opts) -> the real absolute directory, or null.
//
// Null for anything that is not an existing directory genuinely inside $HOME
// once every symlink in it has been followed. `opts.home` is injectable so the
// tests can point a whole fake home at a temp directory, the same seam
// lib/builder.js exposes through opts.root.
export function resolveWorkspacePath(input, opts = {}) {
  if (typeof input !== "string") return null;

  // Refused, not repaired. Everywhere else in this file unprintable characters
  // are stripped, because the text is prose and the goal is to keep the
  // readable part. A path is not prose: stripping a NUL out of one turns a
  // string the filesystem would have rejected into a different, existing
  // directory, which is precisely the substitution not to make silently.
  if (UNPRINTABLE.test(input)) {
    // A /g regex carries lastIndex between calls, so leaving it set here would
    // make the very next path skip its first characters.
    UNPRINTABLE.lastIndex = 0;
    return null;
  }
  UNPRINTABLE.lastIndex = 0;

  const trimmed = input.trim();
  if (!trimmed) return null;

  const home = typeof opts.home === "string" && opts.home !== "" ? opts.home : homedir();

  // "~/development/jarvis" is what a person says and what a model writes down,
  // and no shell is involved anywhere on this path to expand it. Only a leading
  // "~/" (or a bare "~"), so a directory whose name merely contains a tilde is
  // left alone.
  const raw = trimmed === "~" ? home : trimmed.startsWith(`~${sep}`) ? join(home, trimmed.slice(2)) : trimmed;

  let real;
  let realHome;
  try {
    // realpathSync, not resolve(): resolve() is string arithmetic and cannot
    // see a symlink. This is the whole check.
    real = realpathSync(raw);
    realHome = realpathSync(home);
    if (!statSync(real).isDirectory()) return null;
  } catch {
    // Missing, unreadable, a symlink loop, a file rather than a directory —
    // none of them are a workspace, and none are worth throwing over.
    return null;
  }

  // Strictly inside, not equal: $HOME itself is every repository at once, and
  // "start a session in home" is not a request anyone means to make by voice.
  if (!real.startsWith(realHome + sep)) return null;
  return real;
}

export function getWorkspaces(store) {
  return isPlainObject(store?.workspaces) ? store.workspaces : {};
}

// The alias-to-path map lib/agents.js names sessions with. Flattened out of the
// stored records, keeping only the path — a record loaded from an older
// memory.json may still carry a `counter` left over from before session
// numbering moved to orderRoster, and this is where that stray field is
// dropped on the floor rather than propagated anywhere.
export function workspacePaths(store) {
  const out = {};
  for (const [alias, entry] of Object.entries(getWorkspaces(store))) {
    if (isPlainObject(entry) && typeof entry.path === "string" && entry.path) out[alias] = entry.path;
  }
  return out;
}

export function getWorkspace(store, alias) {
  const key = sanitizeAlias(alias);
  const entry = getWorkspaces(store)[key];
  return isPlainObject(entry) && typeof entry.path === "string" ? { alias: key, ...entry } : null;
}

// Mutates store.workspaces. Returns the record actually stored, or null when
// the path is not a workspace anything may be run in, or when the cap is full.
//
// Registering the same path twice is idempotent rather than an error: the
// server registers its own cwd at every startup, and that must not accumulate
// jarvis, jarvis-2, jarvis-3 across restarts.
export function addWorkspace(store, path, alias, opts = {}) {
  if (!isPlainObject(store.workspaces)) store.workspaces = {};

  const real = resolveWorkspacePath(path, opts);
  if (!real) return null;

  const existing = Object.entries(store.workspaces).find(
    ([, entry]) => isPlainObject(entry) && entry.path === real,
  );
  // An explicit alias for a path already known renames nothing: the server
  // registers its own cwd at every startup, and rebinding the alias on every
  // restart would leave every session already named under the old one
  // orphaned from its workspace.
  if (existing) return { alias: existing[0], ...existing[1] };

  const wanted = sanitizeAlias(alias) || aliasFromPath(real);
  if (!wanted) return null;

  if (Object.keys(store.workspaces).length >= MAX_WORKSPACES) return null;

  // Two repositories can share a basename — dev/api and old/api — so a taken
  // alias gets a numbered sibling rather than quietly rebinding the first.
  let key = wanted;
  for (let n = 2; Object.prototype.hasOwnProperty.call(store.workspaces, key); n += 1) {
    if (n > MAX_WORKSPACES) return null;
    key = `${wanted}-${n}`.slice(0, MAX_ALIAS_CHARS);
  }

  store.workspaces[key] = { path: real, addedAt: new Date().toISOString() };
  return { alias: key, ...store.workspaces[key] };
}

// The repository a session starts in when nobody names one. Pure mutation —
// the caller saves — and refused outright for anything that is not already a
// known workspace: a main naming somewhere that does not exist would make
// every unaddressed "start a session" fail with a confusing error instead of
// the plain "which repository, sir?" refuseStart already knows how to ask.
export function setMainRepo(store, alias) {
  // getWorkspace, not a bare key check: it is the one place that already
  // decides whether an entry is a workspace anything can run in (a plain
  // object with a path), and a main that passed a weaker check here could
  // point at an entry getWorkspace itself later refuses.
  const entry = getWorkspace(store, alias);
  if (!entry) return false;
  store.main = entry.alias;
  return true;
}

// The alias set by setMainRepo (or a `main=` tag, or the startup default), or
// null when unset or when it no longer names a workspace. loadStore already
// corrects a stale value read off disk, but this stays defensive rather than
// trusting that every caller went through loadStore -- the same posture
// getWorkspace takes on its own alias argument.
export function getMainRepo(store) {
  const alias = store?.main;
  if (typeof alias !== "string" || !alias) return null;
  return getWorkspace(store, alias) ? alias : null;
}

// The repository a start actually runs in: the one named, or the main one when
// nothing was. Resolved in one place because the confirmation sentence, the
// activity line and the dispatcher must all name the same repository.
export function resolveRepoAlias(store, alias) {
  return typeof alias === "string" && alias.trim() ? alias : getMainRepo(store);
}

// The seam for [MEMORY:SET workspace:fitness=/home/you/dev/KraneticFitness]
// and [MEMORY:SET main=fitness]. Reads the workspace-prefixed pairs out of an
// already-parsed tag bag first, then a `main` key naming which of them (or one
// registered earlier) is the default -- read second so both can arrive in one
// tag and still take effect together.
//
// One quirk worth knowing rather than fixing: [MEMORY:SET
// workspace:api=/new/path main=api] where "api" already names a different
// repository files the new path under "api-2" (addWorkspace's numbered-sibling
// rule) and then sets main to the pre-existing "api" -- the alias in the same
// tag's `main=` value is read literally, not resolved against whatever
// addWorkspace just did with it. Rare enough in practice (it needs a
// collision on the very same alias in the very same tag) that resolving it
// would add a second layer of alias-rewriting for one voice command nobody is
// likely to say.
//
// Returns what was actually registered as a {alias: path} map, `true` when
// only the main repository changed (there is no path to report and returning
// an empty object would look exactly like nothing happened), or null when
// nothing in the bag did anything -- so the caller can stay quiet rather than
// narrate a tag it refused.
export function applyWorkspaceTag(store, memory, opts = {}) {
  if (!memory || typeof memory !== "object") return null;

  const saved = {};
  for (const rawKey of Object.keys(memory)) {
    const key = stripUnprintable(rawKey).toLowerCase().trim();
    if (!key.startsWith(WORKSPACE_PREFIX)) continue;

    const alias = sanitizeAlias(key.slice(WORKSPACE_PREFIX.length));
    // No alias means the tag said "workspace:" and nothing else, which is a
    // garbled tag rather than an instruction to guess.
    if (!alias) continue;

    const added = addWorkspace(store, memory[rawKey], alias, opts);
    if (added) saved[added.alias] = added.path;
  }

  let mainChanged = false;
  for (const rawKey of Object.keys(memory)) {
    const key = stripUnprintable(rawKey).toLowerCase().trim();
    if (key !== MAIN_KEY) continue;
    if (setMainRepo(store, memory[rawKey])) mainChanged = true;
  }

  if (Object.keys(saved).length > 0) return saved;
  return mainChanged ? true : null;
}

// { alias, main } for every workspace, main first and the rest in alphabetical
// alias order -- the same order the session panel groups its rows in, so
// "here is what is running" and "here is where it can run" read the same way.
// No path: this goes straight over the wire to every connected page the way
// rosterForClient's roster does in server.js, and that comment is explicit
// about why an absolute filesystem path never rides along with an alias --
// a repository is called "jarvis" out loud, and a page has no business being
// told where it lives on disk.
export function workspacesForClient(store) {
  const main = getMainRepo(store);
  const entries = Object.entries(getWorkspaces(store))
    .filter(([, entry]) => isPlainObject(entry) && typeof entry.path === "string" && entry.path)
    .map(([alias]) => ({ alias, main: alias === main }));

  entries.sort((a, b) => {
    if (a.main !== b.main) return a.main ? -1 : 1;
    return a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0;
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Follow-ups waiting for a session to go idle
// ---------------------------------------------------------------------------
//
// Resuming a session that is currently working is not a join: two processes on
// one session id is a race, and a worse one across processes than inside one.
// So a follow-up to a busy session waits here, and the roster poller delivers
// it on the first tick that sees the session idle — including the first tick
// after a restart, since the queue is loaded from disk before the poller
// starts and that tick sees the session idle without ever seeing it become so.

function getQueues(store) {
  return isPlainObject(store?.queued) ? store.queued : {};
}

// Entries newer than the TTL, newest last, at most the cap. Shared by both
// sides so a queue can never be read in a shape it could not be written in.
function liveEntries(list, now) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (entry) =>
        isPlainObject(entry) &&
        typeof entry.text === "string" &&
        entry.text !== "" &&
        Number.isFinite(entry.at) &&
        now - entry.at < QUEUE_TTL_MS,
    )
    .slice(-MAX_QUEUED_PER_SESSION);
}

// Mutates store.queued. Returns the text actually queued, or null when nothing
// survived cleaning or the queue for that session is full — so the caller can
// say "queued, sir" only when something really is.
//
// cleanBrief, not cleanText: a busy session's queued follow-up may itself be a
// brief (server.js's dispatchTell falls back to this queue when the peer
// channel has no address for the target), and a brief's line breaks are its
// structure -- see the comment on MAX_QUEUED_CHARS above for why the store
// underneath this is safe to hold them.
export function queueForSession(store, sessionId, text, now = Date.now()) {
  const id = cleanText(sessionId, 100);
  const line = cleanBrief(text, MAX_BRIEF_CHARS);
  if (!id || !line) return null;

  if (!isPlainObject(store.queued)) store.queued = {};
  const existing = liveEntries(store.queued[id], now);
  // Refuse rather than evict: dropping the oldest would silently discard
  // something already promised, and "queued, sir" is a promise.
  if (existing.length >= MAX_QUEUED_PER_SESSION) return null;

  store.queued[id] = [...existing, { text: line, at: now }];
  return line;
}

// What is waiting for a session, without taking it.
export function peekQueued(store, sessionId, now = Date.now()) {
  return liveEntries(getQueues(store)[cleanText(sessionId, 100)], now).map((entry) => entry.text);
}

// Mutates store.queued: returns what was waiting and removes it, oldest first.
// Taking rather than reading is deliberate — a follow-up delivered twice is a
// session told to do the same thing twice, and the poller ticks every few
// seconds.
export function takeQueued(store, sessionId, now = Date.now()) {
  const id = cleanText(sessionId, 100);
  if (!id || !isPlainObject(store.queued)) return [];

  const waiting = liveEntries(store.queued[id], now).map((entry) => entry.text);
  delete store.queued[id];
  return waiting;
}

// Everything queued against sessions that are no longer running. The poller
// calls this when a session leaves the roster: a queue for a session that ended
// is a promise that can never be kept, and leaving it there means the id being
// reused would deliver it to a stranger.
export function dropQueuesExcept(store, liveSessionIds) {
  if (!isPlainObject(store.queued)) return 0;
  const live = new Set(Array.isArray(liveSessionIds) ? liveSessionIds : []);
  let dropped = 0;
  for (const id of Object.keys(store.queued)) {
    if (!live.has(id)) {
      delete store.queued[id];
      dropped += 1;
    }
  }
  return dropped;
}

// The ids with something live waiting for them, for the poller to re-check
// against idle on every tick rather than only the tick a session becomes idle.
export function queuedSessionIds(store, now = Date.now()) {
  const queues = getQueues(store);
  const ids = new Set();
  for (const id of Object.keys(queues)) {
    if (liveEntries(queues[id], now).length > 0) ids.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Sessions Dante started
// ---------------------------------------------------------------------------

export function getSessions(store) {
  return isPlainObject(store?.sessions) ? store.sessions : {};
}

export function getSessionRecord(store, sessionId) {
  const entry = getSessions(store)[cleanText(sessionId, 100)];
  return isPlainObject(entry) ? entry : null;
}

// Mutates store.sessions. Merges into an existing record rather than replacing
// it, so a later patch (a stopped timestamp, an outcome) cannot wipe what the
// start recorded. Returns the stored record.
export function rememberSession(store, sessionId, patch = {}, now = Date.now()) {
  const id = cleanText(sessionId, 100);
  if (!id) return null;
  if (!isPlainObject(store.sessions)) store.sessions = {};

  const existing = getSessionRecord(store, id) ?? { at: now };
  store.sessions[id] = { ...existing, ...patch, at: existing.at ?? now };

  // Oldest out first. Insertion order is not reliable across a save and a load,
  // so the timestamp is what decides.
  const ids = Object.keys(store.sessions);
  if (ids.length > MAX_SESSIONS_REMEMBERED) {
    const byAge = ids.sort(
      (a, b) => (store.sessions[a]?.at ?? 0) - (store.sessions[b]?.at ?? 0),
    );
    for (const stale of byAge.slice(0, ids.length - MAX_SESSIONS_REMEMBERED)) {
      delete store.sessions[stale];
    }
  }

  return store.sessions[id];
}

// ---------------------------------------------------------------------------
// Chains: a successor task, named for when this session ends
// ---------------------------------------------------------------------------
//
// "Start a session in jarvis to fix the tests, then run the linter" names a
// chain. The roadmap once called this "chain on success", which is not what
// gets built here: a Claude Code session exposes no pass/fail verdict to
// condition on. The roster poller that notices a session end only ever sees it
// go `idle` or `gone`, and reportComplete has a transcript summary to read, not
// a verdict to check. So a chain here fires on completion, full stop -- with
// exactly one carve-out, applied in server.js rather than here: a session
// stopped from Dante itself (`stoppedAt` set on its remembered record) drops
// its chain instead of running it, because ending something on purpose is not
// the same as it finishing the work it was asked to do. Do not "fix" this back
// to success-gating; there is no signal here to gate on.
export const MAX_CHAIN_DEPTH = 3; // a chain is not a workflow engine
// Generous next to QUEUE_TTL_MS on purpose: a queued follow-up waits for a
// session to go idle, which is minutes; a chain waits for one to actually
// finish a real task, which can be much longer. A chain that expired mid-run
// would look exactly like a bug that ate the second half of a request.
export const CHAIN_TTL_MS = 3 * 60 * 60 * 1000;
export const MAX_CHAINS = 20; // bounds the table the way MAX_SESSIONS_REMEMBERED bounds sessions
// How long a chain is protected from roster-based cleanup. Comfortably longer
// than the five-second poll interval: the cost of holding a dead chain a minute
// too long is nothing (takeChain is the only thing that acts on one, and only
// for a session that actually ended), while dropping a live one too early loses
// half of what someone asked for.
export const CHAIN_GRACE_MS = 60 * 1000;

// Mutates store.chains. Returns the record actually stored, or null when the
// depth cap already refuses it or nothing survived cleaning -- so the caller
// (beginSession) can stay quiet about a chain that was never recorded rather
// than promise a successor that will not run.
export function chainAfter(store, sessionId, spec = {}, now = Date.now()) {
  const depth = Number.isInteger(spec.depth) && spec.depth >= 0 ? spec.depth : 0;
  if (depth >= MAX_CHAIN_DEPTH) return null;

  const id = cleanText(sessionId, 100);
  // Same cap and cleaning the queue uses for a follow-up: this text reaches a
  // real session's command line exactly the way a queued one does, and it
  // comes from the same untrusted place -- a model-authored tag.
  const task = cleanText(spec.task, MAX_QUEUED_CHARS);
  const alias = sanitizeAlias(spec.alias);
  if (!id || !task || !alias) return null;

  if (!isPlainObject(store.chains)) store.chains = {};
  store.chains[id] = { task, alias, depth, at: now };

  // Oldest out first, the same rule rememberSession applies to store.sessions.
  const ids = Object.keys(store.chains);
  if (ids.length > MAX_CHAINS) {
    const byAge = ids.sort((a, b) => (store.chains[a]?.at ?? 0) - (store.chains[b]?.at ?? 0));
    for (const stale of byAge.slice(0, ids.length - MAX_CHAINS)) delete store.chains[stale];
  }

  // Rare, but possible if a caller passes a `now` older than what is already in
  // the table: the entry just written can itself be the oldest and get evicted
  // above. Read it back rather than assume it survived.
  return store.chains[id] ?? null;
}

// Mutates store.chains: returns the spec waiting for a session and removes it.
// Taking rather than reading is deliberate, the same reason takeQueued is --
// a chain started twice is a session started twice.
export function takeChain(store, sessionId, now = Date.now()) {
  const id = cleanText(sessionId, 100);
  if (!id || !isPlainObject(store.chains)) return null;

  const entry = store.chains[id];
  delete store.chains[id];
  if (!isPlainObject(entry) || typeof entry.task !== "string" || !entry.task) return null;
  if (!Number.isFinite(entry.at) || now - entry.at >= CHAIN_TTL_MS) return null;

  return { task: entry.task, alias: entry.alias, depth: Number.isInteger(entry.depth) ? entry.depth : 0 };
}

// Everything chained against sessions that are no longer running. Mirrors
// dropQueuesExcept for the same reason: a chain for a session that ended
// without ever going through takeChain is a promise that can never be kept,
// and leaving it there means a reused session id would inherit a stranger's
// chain.
export function dropChainsExcept(store, liveSessionIds, now = Date.now()) {
  if (!isPlainObject(store.chains)) return 0;
  const live = new Set(Array.isArray(liveSessionIds) ? liveSessionIds : []);
  let dropped = 0;
  for (const id of Object.keys(store.chains)) {
    if (live.has(id)) continue;
    // A chain is recorded the instant its session is spawned, which is up to a
    // full poll interval before any roster has ever seen that session. Without
    // this window, one unrelated session ending in that gap would delete the
    // brand new chain, and the successor would simply never run -- silently,
    // because nothing downstream ever knew to expect it.
    const at = store.chains[id]?.at;
    if (Number.isFinite(at) && now - at < CHAIN_GRACE_MS) continue;
    delete store.chains[id];
    dropped += 1;
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// The event log: what happened while you were away
// ---------------------------------------------------------------------------
//
// Modelled on capArtifacts/recordArtifact above: a bounded array, newest at the
// tail. What goes in here is a name off a roster, a task a model wrote down,
// and a Haiku transcript summary -- none of it trusted to be short or safe to
// fold into a spoken sentence, so every string is capped and cleaned the way
// every other untrusted string in this file is.
//
// This log survives a restart, because it lives in the store rather than in
// memory -- walking away can mean closing the laptop lid, and the whole point
// is that the answer is still here when the lid opens again. That is also why
// nothing here is timestamp-checked for staleness the way a queued follow-up
// is: an event from a week ago is still true, it is just old, and formatRecap
// is where "old" gets said out loud rather than silently dropped.
export const MAX_EVENT_NAME_CHARS = 60;
export const MAX_EVENT_DETAIL_CHARS = 300;

// Mutates store.events. Returns the entry actually recorded, or null when the
// kind is not one of lib/notify.js's KINDS -- the same set formatEvent itself
// refuses to format, so a garbled kind never gets further than either half of
// the notification.
export function recordEvent(store, entry, now = Date.now()) {
  const kind = KINDS.has(entry?.kind) ? entry.kind : null;
  if (!kind) return null;

  if (!Array.isArray(store.events)) store.events = [];
  const recorded = {
    kind,
    name: cleanText(entry.name, MAX_EVENT_NAME_CHARS),
    detail: cleanText(entry.detail, MAX_EVENT_DETAIL_CHARS),
    at: now,
  };
  // Oldest out first, the same rule capArtifacts applies to a project's
  // artifacts -- events are always appended in order, so the tail is always
  // the newest.
  store.events = [...store.events, recorded].slice(-MAX_EVENTS);
  return recorded;
}

export function getEvents(store) {
  return Array.isArray(store?.events) ? store.events : [];
}

// A recap just said all of this out loud; leaving it in the log would answer
// the next "what happened while I was out" with news that already was.
export function clearEvents(store) {
  if (!isPlainObject(store)) return;
  store.events = [];
}
