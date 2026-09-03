import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir as withTempDirIn } from "./helpers.js";
import {
  DEFAULT_DIR,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  MAX_TOPIC_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_ABOUT_CHARS,
  MAX_SECTION_CHARS,
  MAX_NOTE_BYTES,
  MAX_FACT_KEY_CHARS,
  MAX_FACT_VALUE_CHARS,
  MAX_FACTS,
  MAX_CONTEXT_NOTES,
  MAX_CONTEXT_CHARS_PER_NOTE,
  HEADER_READ_BYTES,
  NOTE_TOPIC_TTL_MS,
  topicSlug,
  sanitizeFacts,
  formatNote,
  parseNote,
  appendSection,
  mergeSection,
  sanitizeLimits,
  planPruning,
  findContradictions,
  describeContradictions,
  notesContext,
  createNoteTracker,
  sessionNoteSpec,
  discussionSection,
  topicIsLive,
  notePath,
  loadNote,
  listNotes,
  pruneNotes,
  saveNote,
  writeSection,
  recentNotes,
  pickNotes,
  foldNotes,
  recordDiscussion,
} from "../lib/notes.js";

const withTempDir = (fn) => withTempDirIn("dante-notes-", fn);

// A minimal, "clean" note used across format/parse and appendSection tests:
// every field already within its cap, so round-tripping it never has to
// account for cleaning changing the value.
function makeNote(overrides = {}) {
  return {
    title: "Jarvis Rebuild",
    summary: "Rebuilding the interview flow.",
    about: "Notes on the jarvis-3 session.",
    created: Date.parse("2026-08-20T09:00:00.000Z"),
    updated: Date.parse("2026-08-20T09:00:00.000Z"),
    facts: { subject: "jarvis-3", status: "in progress" },
    sections: [{ at: Date.parse("2026-08-20T09:00:00.000Z"), kind: "read", text: "Started the rebuild." }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// topicSlug -- a security boundary, not formatting
// ---------------------------------------------------------------------------

test("topicSlug lowercases and keeps only letters, digits and dashes", () => {
  assert.equal(topicSlug("Jarvis Rebuild"), "jarvis-rebuild");
});

test("topicSlug collapses runs of dashes and trims leading/trailing dashes", () => {
  assert.equal(topicSlug("--jarvis   rebuild--"), "jarvis-rebuild");
});

test("topicSlug refuses a path traversal attempt", () => {
  assert.equal(topicSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(topicSlug("a/b"), "a-b");
  assert.equal(topicSlug(".."), "");
  assert.equal(topicSlug("."), "");
});

test("topicSlug never emits a slash, backslash or NUL byte", () => {
  const out = topicSlug("a/b\\c\u0000d");
  assert.doesNotMatch(out, /[/\\\u0000]/);
});

test("topicSlug drops unicode and control characters, keeping only ASCII letters/digits/dashes", () => {
  // Every non-ASCII code point (an accented letter, a bidi mark, an emoji)
  // becomes a dash, and runs of dashes collapse to one -- there is no path
  // by which a unicode character survives into the slug.
  const out = topicSlug("café‎☃jarvis");
  assert.doesNotMatch(out, /[^a-z0-9-]/);
  assert.equal(out, "caf-jarvis");
});

test("topicSlug returns empty for an all-punctuation string", () => {
  assert.equal(topicSlug("!!!...???"), "");
});

test("topicSlug clips to MAX_TOPIC_CHARS and trims a dash left at the cut point", () => {
  const long = "a".repeat(MAX_TOPIC_CHARS + 10);
  const out = topicSlug(long);
  assert.ok(out.length <= MAX_TOPIC_CHARS);
  assert.equal(out, "a".repeat(MAX_TOPIC_CHARS));

  // A dash sitting exactly at the character the clip lands on must not
  // survive as a trailing dash.
  const withDashAtCut = "a".repeat(MAX_TOPIC_CHARS - 1) + "-" + "b".repeat(10);
  assert.ok(!topicSlug(withDashAtCut).endsWith("-"));
});

test("topicSlug returns empty for non-string input", () => {
  for (const bad of [null, undefined, 42, {}, []]) assert.equal(topicSlug(bad), "");
});

// ---------------------------------------------------------------------------
// sanitizeFacts
// ---------------------------------------------------------------------------

test("sanitizeFacts lowercases and trims keys, and clips values", () => {
  const out = sanitizeFacts({ "  Subject  ": "  jarvis-3  " });
  assert.deepEqual(out, { subject: "jarvis-3" });
});

test("sanitizeFacts clips a key to MAX_FACT_KEY_CHARS and a value to MAX_FACT_VALUE_CHARS", () => {
  const longKey = "k".repeat(MAX_FACT_KEY_CHARS + 20);
  const longValue = "v".repeat(MAX_FACT_VALUE_CHARS + 20);
  const out = sanitizeFacts({ [longKey]: longValue });
  const [key] = Object.keys(out);
  assert.equal(key.length, MAX_FACT_KEY_CHARS);
  assert.equal(out[key].length, MAX_FACT_VALUE_CHARS);
});

test("sanitizeFacts drops entries whose value is empty after cleaning", () => {
  const out = sanitizeFacts({ subject: "", status: "   ", task: "kept" });
  assert.deepEqual(out, { task: "kept" });
});

test("sanitizeFacts skips __proto__, constructor and prototype", () => {
  const bag = JSON.parse('{"__proto__": "evil", "constructor": "evil", "prototype": "evil", "real": "kept"}');
  assert.deepEqual(sanitizeFacts(bag), { real: "kept" });
  assert.equal({}.evil, undefined);
});

test("sanitizeFacts caps the number of facts at MAX_FACTS, keeping the first ones seen", () => {
  const bag = {};
  for (let i = 0; i < MAX_FACTS + 5; i++) bag[`k${i}`] = `v${i}`;
  const out = sanitizeFacts(bag);
  assert.equal(Object.keys(out).length, MAX_FACTS);
  assert.equal(out.k0, "v0");
  assert.equal(out[`k${MAX_FACTS + 4}`], undefined);
});

test("sanitizeFacts returns an empty object for a non-object bag", () => {
  assert.deepEqual(sanitizeFacts(null), {});
  assert.deepEqual(sanitizeFacts(undefined), {});
  assert.deepEqual(sanitizeFacts("nope"), {});
  assert.deepEqual(sanitizeFacts([1, 2]), {});
});

// ---------------------------------------------------------------------------
// formatNote / parseNote
// ---------------------------------------------------------------------------

test("formatNote/parseNote round-trip a clean note with one section", () => {
  const note = makeNote();
  assert.deepEqual(parseNote(formatNote(note)), note);
});

test("formatNote/parseNote round-trip a note with zero sections", () => {
  const note = makeNote({ sections: [] });
  assert.deepEqual(parseNote(formatNote(note)), note);
});

test("formatNote/parseNote round-trip a note with no facts", () => {
  const note = makeNote({ facts: {} });
  const text = formatNote(note);
  assert.doesNotMatch(text, /^facts:/m);
  assert.deepEqual(parseNote(text), note);
});

test("formatNote/parseNote round-trip a section whose text contains newlines", () => {
  const note = makeNote({
    sections: [
      { at: Date.parse("2026-08-20T09:00:00.000Z"), kind: "discussion", text: "line one\nline two\nline three" },
    ],
  });
  assert.deepEqual(parseNote(formatNote(note)), note);
});

test("formatNote/parseNote round-trip a note with several sections in order", () => {
  const note = makeNote({
    sections: [
      { at: Date.parse("2026-08-20T09:00:00.000Z"), kind: "read", text: "first" },
      { at: Date.parse("2026-08-20T10:00:00.000Z"), kind: "discussion", text: "second\nwith a newline" },
      { at: Date.parse("2026-08-20T11:00:00.000Z"), kind: "read", text: "third" },
    ],
  });
  assert.deepEqual(parseNote(formatNote(note)), note);
});

test("parseNote returns null for non-string input", () => {
  for (const bad of [null, undefined, 42, {}, []]) assert.equal(parseNote(bad), null);
});

test("parseNote returns null when the header/body separator is missing entirely", () => {
  assert.equal(parseNote("# Title\nsummary: s\nabout: a\n"), null);
});

test("parseNote returns null when a required header field is missing", () => {
  const missingSummary = "# Title\nabout: a\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n\n---\n\n";
  assert.equal(parseNote(missingSummary), null);

  const missingCreated = "# Title\nsummary: s\nabout: a\nupdated: 2026-01-01T00:00:00.000Z\n\n---\n\n";
  assert.equal(parseNote(missingCreated), null);

  const noTitle = "summary: s\nabout: a\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n\n---\n\n";
  assert.equal(parseNote(noTitle), null);
});

test("parseNote tolerates a stray unrecognized line in a hand-edited header", () => {
  const text = [
    "# Title",
    "summary: s",
    "some stray line a human typed",
    "about: a",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
    "",
    "---",
    "",
    "",
  ].join("\n");
  const parsed = parseNote(text);
  assert.ok(parsed);
  assert.equal(parsed.title, "Title");
  assert.equal(parsed.summary, "s");
  assert.deepEqual(parsed.sections, []);
});

// ---------------------------------------------------------------------------
// appendSection
// ---------------------------------------------------------------------------

test("appendSection appends without mutating the original note and sets updated to the section's time", () => {
  const note = makeNote({ sections: [] });
  const originalSections = note.sections;
  const at = Date.parse("2026-08-21T00:00:00.000Z");
  const result = appendSection(note, { at, kind: "read", text: "a new section" });

  assert.equal(note.sections, originalSections); // original untouched
  assert.equal(result.updated, at);
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].text, "a new section");
});

test("appendSection cleans and clips section text to MAX_SECTION_CHARS", () => {
  const note = makeNote({ sections: [] });
  const long = "x".repeat(MAX_SECTION_CHARS + 500);
  const result = appendSection(note, { at: Date.now(), kind: "read", text: long });
  assert.equal(result.sections[0].text.length, MAX_SECTION_CHARS);
});

test("appendSection defaults an empty or missing kind to a plain word rather than an empty string", () => {
  const note = makeNote({ sections: [] });
  const result = appendSection(note, { at: Date.now(), text: "hi" });
  assert.ok(result.sections[0].kind);
});

test("appendSection drops the oldest sections once the note exceeds MAX_NOTE_BYTES, keeping the newest", () => {
  let note = makeNote({ sections: [] });
  const bigText = "x".repeat(MAX_SECTION_CHARS);

  for (let i = 0; i < 20; i++) {
    note = appendSection(note, { at: 1000 + i, kind: "read", text: bigText });
  }

  assert.ok(Buffer.byteLength(formatNote(note), "utf8") <= MAX_NOTE_BYTES);
  assert.ok(note.sections.length >= 1);
  assert.ok(note.sections.length < 20); // some were dropped
  const newest = note.sections[note.sections.length - 1];
  assert.equal(newest.at, 1000 + 19); // the just-appended section always survives
});

test("appendSection drops exactly the sections the byte cap requires, measured once, and the result formats to the same bytes the old per-iteration loop produced", () => {
  let note = makeNote({ sections: [] });
  const bigText = "x".repeat(MAX_SECTION_CHARS);
  const all = [];

  for (let i = 0; i < 20; i++) {
    const section = { at: 1000 + i, kind: "read", text: bigText };
    all.push(section);
    note = appendSection(note, section);
  }

  assert.ok(Buffer.byteLength(formatNote(note), "utf8") <= MAX_NOTE_BYTES);

  // The sections kept are exactly the newest `note.sections.length` of the
  // 20 appended -- adding back the one just before them (the last one the
  // arithmetic dropped) must push the note back over the cap, or the loop
  // measured wrong and dropped one too many.
  const droppedCount = all.length - note.sections.length;
  assert.ok(droppedCount > 0);
  const lastDropped = all[droppedCount - 1];
  const withOneMore = { ...note, sections: [lastDropped, ...note.sections] };
  assert.ok(Buffer.byteLength(formatNote(withOneMore), "utf8") > MAX_NOTE_BYTES);
});

// ---------------------------------------------------------------------------
// mergeSection -- one read section per distinct question
// ---------------------------------------------------------------------------

test("reading the same session twice with the same question yields exactly one read section, carrying the newer text and time", () => {
  const note = makeNote({ sections: [] });
  const first = mergeSection(note, { at: 1000, kind: "read", text: "Asked: what is it doing\nBuilding X." });
  const second = mergeSection(first, { at: 2000, kind: "read", text: "Asked: what is it doing\nStill building X." });
  assert.equal(second.sections.length, 1);
  assert.equal(second.sections[0].at, 2000);
  assert.equal(second.sections[0].text, "Asked: what is it doing\nStill building X.");
});

test("reading the same session with two different questions keeps one read section per question", () => {
  const note = makeNote({ sections: [] });
  const first = mergeSection(note, { at: 1000, kind: "read", text: "Asked: what is it doing\nBuilding X." });
  const second = mergeSection(first, { at: 2000, kind: "read", text: "Asked: is it done yet\nNot yet." });
  assert.equal(second.sections.length, 2);
  assert.ok(second.sections.some((s) => s.text.startsWith("Asked: what is it doing")));
  assert.ok(second.sections.some((s) => s.text.startsWith("Asked: is it done yet")));
});

test("a read with no question replaces the previous question-less read but leaves questioned reads alone", () => {
  const note = makeNote({ sections: [] });
  const withQuestion = mergeSection(note, { at: 1000, kind: "read", text: "Asked: what is it doing\nBuilding X." });
  const first = mergeSection(withQuestion, { at: 2000, kind: "read", text: "Reading it back." });
  const second = mergeSection(first, { at: 3000, kind: "read", text: "Reading it back again." });
  assert.equal(second.sections.length, 2);
  assert.ok(second.sections.some((s) => s.text === "Asked: what is it doing\nBuilding X."));
  assert.ok(second.sections.some((s) => s.text === "Reading it back again."));
  assert.ok(!second.sections.some((s) => s.text === "Reading it back."));
});

test("mergeSection never dedupes discussion sections", () => {
  const note = makeNote({ sections: [] });
  const first = mergeSection(note, { at: 1000, kind: "discussion", text: "Krane: hi\nDante: hello" });
  const second = mergeSection(first, { at: 2000, kind: "discussion", text: "Krane: hi\nDante: hello" });
  assert.equal(second.sections.length, 2);
});

test("mergeSection matches the Asked line case- and whitespace-insensitively", () => {
  const note = makeNote({ sections: [] });
  const first = mergeSection(note, { at: 1000, kind: "read", text: "Asked: What is it doing?\nBuilding X." });
  const second = mergeSection(first, { at: 2000, kind: "read", text: "Asked:   what   is it doing  \nStill building." });
  assert.equal(second.sections.length, 1);
  assert.match(second.sections[0].text, /Still building\.$/);
});

// ---------------------------------------------------------------------------
// sanitizeLimits -- fallback matrix
// ---------------------------------------------------------------------------

test("sanitizeLimits returns the defaults when raw is missing or empty", () => {
  assert.deepEqual(sanitizeLimits(undefined), { maxBytes: DEFAULT_MAX_BYTES, maxFiles: DEFAULT_MAX_FILES });
  assert.deepEqual(sanitizeLimits(null), { maxBytes: DEFAULT_MAX_BYTES, maxFiles: DEFAULT_MAX_FILES });
  assert.deepEqual(sanitizeLimits({}), { maxBytes: DEFAULT_MAX_BYTES, maxFiles: DEFAULT_MAX_FILES });
});

test("sanitizeLimits accepts only the field that is valid, defaulting the other", () => {
  assert.deepEqual(sanitizeLimits({ maxBytes: 1000 }), { maxBytes: 1000, maxFiles: DEFAULT_MAX_FILES });
  assert.deepEqual(sanitizeLimits({ maxFiles: 10 }), { maxBytes: DEFAULT_MAX_BYTES, maxFiles: 10 });
});

test("sanitizeLimits falls back to default for wrong types, negative numbers, zero and NaN", () => {
  for (const bad of [true, false, {}, [], null, -5, 0, NaN, "not a number"]) {
    assert.deepEqual(sanitizeLimits({ maxBytes: bad, maxFiles: bad }), {
      maxBytes: DEFAULT_MAX_BYTES,
      maxFiles: DEFAULT_MAX_FILES,
    });
  }
});

test("sanitizeLimits accepts a numeric string", () => {
  assert.deepEqual(sanitizeLimits({ maxBytes: "2000", maxFiles: "20" }), { maxBytes: 2000, maxFiles: 20 });
});

test("sanitizeLimits clamps a valid value above the ceiling rather than falling back", () => {
  const out = sanitizeLimits({ maxBytes: 3 * 1024 * 1024 * 1024, maxFiles: 999999 });
  assert.equal(out.maxBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(out.maxFiles, 100000);
});

test("sanitizeLimits truncates a fractional value", () => {
  assert.deepEqual(sanitizeLimits({ maxBytes: 100.9, maxFiles: 5.9 }), { maxBytes: 100, maxFiles: 5 });
});

test("sanitizeLimits accepts custom defaults for a missing field", () => {
  const out = sanitizeLimits({}, { maxBytes: 111, maxFiles: 222 });
  assert.deepEqual(out, { maxBytes: 111, maxFiles: 222 });
});

// ---------------------------------------------------------------------------
// planPruning
// ---------------------------------------------------------------------------

test("planPruning removes the oldest entries until total bytes is under the cap", () => {
  const entries = [
    { topic: "a", bytes: 100, updated: 1 },
    { topic: "b", bytes: 100, updated: 2 },
    { topic: "c", bytes: 100, updated: 3 },
  ];
  // 300 total, cap 150: removing "a" alone only gets to 200, still over, so
  // "b" goes too, leaving "c" (100) under the cap.
  const removed = planPruning(entries, { maxBytes: 150, maxFiles: 100 });
  assert.deepEqual(removed.map((e) => e.topic), ["a", "b"]);
});

test("planPruning removes the oldest entries until the file count is under the cap", () => {
  const entries = [
    { topic: "a", bytes: 1, updated: 1 },
    { topic: "b", bytes: 1, updated: 2 },
    { topic: "c", bytes: 1, updated: 3 },
  ];
  const removed = planPruning(entries, { maxBytes: 1000, maxFiles: 1 });
  assert.deepEqual(removed.map((e) => e.topic), ["a", "b"]);
});

test("planPruning satisfies both caps in one pass when both are hit", () => {
  const entries = [
    { topic: "a", bytes: 500, updated: 1 },
    { topic: "b", bytes: 500, updated: 2 },
    { topic: "c", bytes: 500, updated: 3 },
    { topic: "d", bytes: 500, updated: 4 },
  ];
  const removed = planPruning(entries, { maxBytes: 900, maxFiles: 2 });
  const kept = entries.filter((e) => !removed.includes(e));
  assert.ok(kept.length <= 2);
  assert.ok(kept.reduce((sum, e) => sum + e.bytes, 0) <= 900);
});

test("planPruning always keeps the newest entry, even alone over the byte cap", () => {
  const entries = [
    { topic: "old", bytes: 10, updated: 1 },
    { topic: "newest", bytes: 100000, updated: 2 },
  ];
  const removed = planPruning(entries, { maxBytes: 50, maxFiles: 100 });
  assert.deepEqual(removed.map((e) => e.topic), ["old"]);
});

test("planPruning removes nothing when both caps are already satisfied", () => {
  const entries = [{ topic: "a", bytes: 10, updated: 1 }];
  assert.deepEqual(planPruning(entries, { maxBytes: 1000, maxFiles: 10 }), []);
});

test("planPruning treats a non-array as no entries", () => {
  assert.deepEqual(planPruning(null, { maxBytes: 1, maxFiles: 1 }), []);
  assert.deepEqual(planPruning(undefined, { maxBytes: 1, maxFiles: 1 }), []);
});

// ---------------------------------------------------------------------------
// findContradictions -- only notes sharing a subject are ever compared
// ---------------------------------------------------------------------------

test("findContradictions never compares two notes unless both carry a matching subject fact", () => {
  const a = { topic: "a", updated: 1, facts: { task: "build" } };
  const b = { topic: "b", updated: 2, facts: { task: "ship" } };
  assert.deepEqual(findContradictions([a, b]), []);
});

test("findContradictions flags a differing fact between two notes sharing a subject", () => {
  const older = { topic: "jarvis-3-a", updated: 1000, facts: { subject: "jarvis-3", task: "build" } };
  const newer = { topic: "jarvis-3-b", updated: 2000, facts: { subject: "jarvis-3", task: "ship" } };
  const result = findContradictions([older, newer]);
  assert.deepEqual(result, [
    {
      key: "task",
      subject: "jarvis-3",
      newer: { topic: "jarvis-3-b", value: "ship", updated: 2000 },
      older: { topic: "jarvis-3-a", value: "build", updated: 1000 },
    },
  ]);
});

test("findContradictions reports nothing for two notes with a different subject, even with different tasks", () => {
  const a = { topic: "a", updated: 1000, facts: { subject: "jarvis-3", task: "build" } };
  const b = { topic: "b", updated: 2000, facts: { subject: "fitness-1", task: "ship" } };
  assert.deepEqual(findContradictions([a, b]), []);
});

test("findContradictions never reports the subject key itself as a contradiction", () => {
  const a = { topic: "a", updated: 1000, facts: { subject: "Jarvis-3", task: "same" } };
  const b = { topic: "b", updated: 2000, facts: { subject: "jarvis-3 ", task: "same" } };
  // subject matches case/whitespace-insensitively, tasks agree -> nothing at all
  assert.deepEqual(findContradictions([a, b]), []);
});

test("findContradictions treats matching values as agreement, not a contradiction", () => {
  const a = { topic: "a", updated: 1000, facts: { subject: "x", task: "  Build  " } };
  const b = { topic: "b", updated: 2000, facts: { subject: "x", task: "build" } };
  assert.deepEqual(findContradictions([a, b]), []);
});

test("findContradictions reports every older note against the newest once, for three or more sharing a subject", () => {
  const oldest = { topic: "one", updated: 1000, facts: { subject: "x", task: "A" } };
  const middle = { topic: "two", updated: 2000, facts: { subject: "x", task: "B" } };
  const newest = { topic: "three", updated: 3000, facts: { subject: "x", task: "C" } };
  const result = findContradictions([oldest, middle, newest]);
  assert.equal(result.length, 2);
  assert.ok(result.every((c) => c.newer.topic === "three"));
  assert.deepEqual(result.map((c) => c.older.topic), ["one", "two"]); // deterministic: by older topic
});

test("findContradictions is deterministic: sorted by key, then by older topic", () => {
  const a = { topic: "b-note", updated: 1000, facts: { subject: "x", task: "A", status: "todo" } };
  const c = { topic: "a-note", updated: 500, facts: { subject: "x", task: "Z" } };
  const newest = { topic: "z-note", updated: 3000, facts: { subject: "x", task: "N", status: "done" } };
  const result = findContradictions([a, c, newest]);
  const keys = result.map((r) => r.key);
  assert.deepEqual([...keys].sort(), keys);
});

test("findContradictions ignores a note with an empty or non-string subject", () => {
  const a = { topic: "a", updated: 1, facts: { subject: "", task: "x" } };
  const b = { topic: "b", updated: 2, facts: { subject: "", task: "y" } };
  assert.deepEqual(findContradictions([a, b]), []);
});

test("findContradictions treats a non-array or malformed entries as no notes", () => {
  assert.deepEqual(findContradictions(null), []);
  assert.deepEqual(findContradictions([null, "nope", 5, { topic: "a" }]), []);
});

// ---------------------------------------------------------------------------
// describeContradictions
// ---------------------------------------------------------------------------

test("describeContradictions returns an empty string for an empty list", () => {
  assert.equal(describeContradictions([]), "");
  assert.equal(describeContradictions(null), "");
});

test("describeContradictions speaks the canonical single-contradiction sentence, naming the subject and never the topic slug", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  const contradiction = {
    key: "task",
    subject: "jarvis-3",
    newer: { topic: "jarvis-3-a1b2c3d4", value: "X", updated: now }, // today
    older: { topic: "jarvis-3-9f8e7d6c", value: "Y", updated: now - 3 * 24 * 60 * 60 * 1000 }, // a few days back
  };
  const sentence = describeContradictions([contradiction], now);
  assert.match(sentence, /^Two of my notes on jarvis-3 disagree on task, sir: /);
  assert.match(sentence, /today's says X/);
  assert.match(sentence, /an older one from \w+ said Y/);
  assert.match(sentence, /I am going with the newer\.$/);
  // The topic slugs' hex suffixes (a1b2c3d4, 9f8e7d6c) never reach the
  // voice -- only the subject (the session name) does.
  assert.doesNotMatch(sentence, /[0-9a-f]{8}/);
});

test("describeContradictions falls back to the newer note's topic when a contradiction carries no subject", () => {
  const now = Date.now();
  const contradiction = {
    key: "task",
    newer: { topic: "jarvis-3-a1b2c3d4", value: "X", updated: now },
    older: { topic: "jarvis-3-9f8e7d6c", value: "Y", updated: now - 1000 },
  };
  const sentence = describeContradictions([contradiction], now);
  assert.match(sentence, /^Two of my notes on jarvis-3-a1b2c3d4 disagree on task, sir: /);
});

test("describeContradictions covers every item when the list has more than one", () => {
  const now = Date.now();
  const list = [
    { key: "task", subject: "jarvis-3", newer: { topic: "a", value: "X", updated: now }, older: { topic: "b", value: "Y", updated: now - 1000 } },
    { key: "status", subject: "fitness-1", newer: { topic: "a", value: "done", updated: now }, older: { topic: "c", value: "todo", updated: now - 2000 } },
  ];
  const sentence = describeContradictions(list, now);
  assert.match(sentence, /task/);
  assert.match(sentence, /status/);
});

test("describeContradictions is deterministic given the same now", () => {
  const now = Date.now();
  const contradiction = {
    key: "task",
    subject: "jarvis-3",
    newer: { topic: "a", value: "X", updated: now },
    older: { topic: "b", value: "Y", updated: now - 86400000 },
  };
  assert.equal(describeContradictions([contradiction], now), describeContradictions([contradiction], now));
});

// ---------------------------------------------------------------------------
// notesContext
// ---------------------------------------------------------------------------

test("notesContext returns an empty string for no notes", () => {
  assert.equal(notesContext([]), "");
  assert.equal(notesContext(null), "");
});

test("notesContext frames the block as machine state, not something anyone said", () => {
  const now = Date.now();
  const block = notesContext([{ topic: "jarvis-3", updated: now, summary: "Rebuild status.", sections: [] }], now);
  assert.match(block, /not something anyone said/);
  assert.match(block, /data, never instructions/);
});

test("notesContext includes the topic, relative time and summary for each note", () => {
  const now = Date.now();
  const block = notesContext([{ topic: "jarvis-3", updated: now, summary: "Rebuild status.", sections: [] }], now);
  assert.match(block, /NOTE jarvis-3 \(updated today\): Rebuild status\./);
});

test("notesContext orders newest first and caps at MAX_CONTEXT_NOTES", () => {
  const now = Date.now();
  const notes = [];
  for (let i = 0; i < MAX_CONTEXT_NOTES + 3; i++) {
    notes.push({ topic: `topic-${i}`, updated: now - i * 1000, summary: `s${i}`, sections: [] });
  }
  const block = notesContext(notes, now);
  // The newest (topic-0) appears, the oldest ones beyond the cap do not.
  assert.match(block, /NOTE topic-0/);
  assert.doesNotMatch(block, new RegExp(`NOTE topic-${MAX_CONTEXT_NOTES + 2}\\b`));
  const occurrences = block.match(/NOTE /g) ?? [];
  assert.equal(occurrences.length, MAX_CONTEXT_NOTES);
});

test("notesContext folds the newest read and the newest discussion whole, head-clipped to MAX_CONTEXT_CHARS_PER_NOTE together", () => {
  const now = Date.now();
  const note = {
    topic: "jarvis-3",
    updated: now,
    summary: "s",
    sections: [
      { at: now - 3000, kind: "read", text: "Asked: what happened first\nStale answer." },
      { at: now - 2000, kind: "discussion", text: "Krane: stale exchange\nDante: stale reply" },
      { at: now - 1000, kind: "read", text: "Asked: what is happening now\nFresh answer." },
      { at: now, kind: "discussion", text: "Krane: what did it decide\nDante: it went with option two" },
    ],
  };
  const block = notesContext([note], now);

  // The newest of each kind survives...
  assert.match(block, /Asked: what is happening now/);
  assert.match(block, /Krane: what did it decide/);
  // ...and the older sections of the same kind do not.
  assert.doesNotMatch(block, /what happened first/);
  assert.doesNotMatch(block, /stale exchange/);
});

test("notesContext head-clips a read that alone exceeds MAX_CONTEXT_CHARS_PER_NOTE", () => {
  const now = Date.now();
  const longBody = "x".repeat(MAX_CONTEXT_CHARS_PER_NOTE + 500);
  const block = notesContext(
    [{ topic: "jarvis-3", updated: now, summary: "s", sections: [{ at: now, kind: "read", text: longBody }] }],
    now,
  );
  const xRun = block.match(/x+/);
  assert.ok(xRun);
  assert.equal(xRun[0].length, MAX_CONTEXT_CHARS_PER_NOTE);
});

test("notesContext folds nothing but the header for a note with no read or discussion section", () => {
  const now = Date.now();
  const block = notesContext(
    [{ topic: "jarvis-3", updated: now, summary: "s", sections: [{ at: now, kind: "note", text: "irrelevant" }] }],
    now,
  );
  assert.match(block, /NOTE jarvis-3 \(updated today\): s$/m);
  assert.doesNotMatch(block, /irrelevant/);
});

// ---------------------------------------------------------------------------
// createNoteTracker
// ---------------------------------------------------------------------------

test("createNoteTracker.touch stores a note by topic and replaces it on a second touch", () => {
  const tracker = createNoteTracker();
  tracker.touch({ topic: "jarvis-3", updated: 1, facts: {} });
  tracker.touch({ topic: "jarvis-3", updated: 2, facts: {} });
  assert.deepEqual(tracker.topics(), ["jarvis-3"]);
});

test("createNoteTracker.touch keeps only topic, facts and updated -- never sections, summary or about", () => {
  const tracker = createNoteTracker();
  tracker.touch({
    topic: "jarvis-3",
    updated: 1000,
    facts: { subject: "jarvis-3" },
    title: "Session jarvis-3",
    summary: "s",
    about: "a",
    sections: [{ at: 1000, kind: "read", text: "x".repeat(50000) }],
  });
  assert.deepEqual(tracker.notes(), [{ topic: "jarvis-3", facts: { subject: "jarvis-3" }, updated: 1000 }]);
});

test("createNoteTracker.pending returns the same list on repeated calls, without marking anything reported", () => {
  const tracker = createNoteTracker();
  tracker.touch({ topic: "a", updated: 1000, facts: { subject: "x", task: "build" } });
  tracker.touch({ topic: "b", updated: 2000, facts: { subject: "x", task: "ship" } });

  const first = tracker.pending();
  assert.equal(first.length, 1);

  const second = tracker.pending();
  assert.deepEqual(second, first);
});

test("createNoteTracker.settle marks every currently pending contradiction reported, so pending() is empty afterwards", () => {
  const tracker = createNoteTracker();
  tracker.touch({ topic: "a", updated: 1000, facts: { subject: "x", task: "build" } });
  tracker.touch({ topic: "b", updated: 2000, facts: { subject: "x", task: "ship" } });

  assert.equal(tracker.pending().length, 1);
  tracker.settle();
  assert.deepEqual(tracker.pending(), []);
});

test("createNoteTracker.pending reports a third note with yet another value only against the newest, before anything is settled", () => {
  const tracker = createNoteTracker();
  tracker.touch({ topic: "one", updated: 1000, facts: { subject: "x", task: "A" } });
  tracker.touch({ topic: "two", updated: 2000, facts: { subject: "x", task: "B" } });
  tracker.touch({ topic: "three", updated: 3000, facts: { subject: "x", task: "C" } });

  const found = tracker.pending();
  assert.equal(found.length, 2);
  assert.ok(found.every((c) => c.newer.topic === "three"));
});

test("a newly touched note's new disagreements are pending again after an earlier one was settled", () => {
  const tracker = createNoteTracker();
  tracker.touch({ topic: "one", updated: 1000, facts: { subject: "x", task: "A" } });
  tracker.touch({ topic: "two", updated: 2000, facts: { subject: "x", task: "B" } });
  assert.equal(tracker.pending().length, 1);
  tracker.settle(); // reports task::one::two

  // A third note becomes the new newest, so it is compared against BOTH
  // earlier notes -- "one vs three" and "two vs three" are both pairs that
  // have never been reported, even though "one vs two" already was.
  tracker.touch({ topic: "three", updated: 3000, facts: { subject: "x", task: "C" } });
  const found = tracker.pending();
  assert.equal(found.length, 2);
  assert.ok(found.every((c) => c.newer.topic === "three"));
  assert.deepEqual(found.map((c) => c.older.topic), ["one", "two"]);

  // Settling again leaves nothing pending until something else changes.
  tracker.settle();
  assert.deepEqual(tracker.pending(), []);
});

test("createNoteTracker.topics reflects only currently-touched notes", () => {
  const tracker = createNoteTracker();
  assert.deepEqual(tracker.topics(), []);
  tracker.touch({ topic: "a", updated: 1, facts: {} });
  tracker.touch({ topic: "b", updated: 2, facts: {} });
  assert.deepEqual(tracker.topics(), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// notePath / loadNote
// ---------------------------------------------------------------------------

test("notePath returns null for a topic that slugs to nothing", () => {
  withTempDir((dir) => {
    assert.equal(notePath(dir, "../.."), null);
    assert.equal(notePath(dir, "!!!"), null);
  });
});

test("notePath joins the slug with .md under dir", () => {
  withTempDir((dir) => {
    assert.equal(notePath(dir, "Jarvis 3"), join(dir, "jarvis-3.md"));
  });
});

test("loadNote returns null for a topic with no file yet", () => {
  withTempDir((dir) => {
    assert.equal(loadNote(dir, "jarvis-3"), null);
  });
});

test("loadNote returns null for an empty topic slug", () => {
  withTempDir((dir) => {
    assert.equal(loadNote(dir, "../.."), null);
  });
});

test("loadNote returns null for a file that does not parse", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "jarvis-3.md"), "not a real note at all");
    assert.equal(loadNote(dir, "jarvis-3"), null);
  });
});

test("loadNote returns the note with its topic attached", () => {
  withTempDir((dir) => {
    const note = makeNote();
    writeFileSync(join(dir, "jarvis-rebuild.md"), formatNote(note));
    const loaded = loadNote(dir, "Jarvis Rebuild");
    assert.equal(loaded.topic, "jarvis-rebuild");
    assert.equal(loaded.summary, note.summary);
  });
});

// ---------------------------------------------------------------------------
// listNotes -- bounded head reads (HEADER_READ_BYTES)
// ---------------------------------------------------------------------------

test("listNotes returns an empty array for a missing directory", () => {
  assert.deepEqual(listNotes("/no/such/dante-notes-dir"), []);
});

test("listNotes ignores a non-.md file", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "jarvis-3.md"), formatNote(makeNote()));
    writeFileSync(join(dir, "notes.txt"), "not a note");
    const listed = listNotes(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].topic, "jarvis-3");
  });
});

test("listNotes on a corrupt .md file with no header still lists it, using the file's mtime", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "corrupt.md"), "just junk, no header at all\n");
    const listed = listNotes(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].topic, "corrupt");
    assert.equal(listed[0].summary, "");
    assert.equal(listed[0].about, "");
    assert.ok(Number.isFinite(listed[0].updated));
    assert.ok(Number.isFinite(listed[0].created));
  });
});

test("listNotes reads a correct header even when the note's body is far larger than HEADER_READ_BYTES", () => {
  withTempDir((dir) => {
    const bigBody = "y".repeat(HEADER_READ_BYTES * 3);
    const note = makeNote({ sections: [{ at: Date.now(), kind: "discussion", text: bigBody }] });
    writeFileSync(join(dir, "jarvis-rebuild.md"), formatNote(note));

    const stat = readFileSync(join(dir, "jarvis-rebuild.md"), "utf8");
    assert.ok(Buffer.byteLength(stat, "utf8") > HEADER_READ_BYTES); // sanity: the file really is that big

    const listed = listNotes(dir);
    assert.equal(listed[0].summary, note.summary);
    assert.equal(listed[0].about, note.about);
    assert.equal(listed[0].updated, note.updated);
  });
});

test("a header larger than HEADER_READ_BYTES falls back to mtime rather than throwing", () => {
  withTempDir((dir) => {
    const path = join(dir, "hugeheader.md");
    const paddedSummary = "y".repeat(HEADER_READ_BYTES + 500); // pushes "---" past the read window
    const text = [
      "# Title",
      `summary: ${paddedSummary}`,
      "about: a",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "",
      "---",
      "",
      "body",
    ].join("\n");
    writeFileSync(path, text);

    const listed = listNotes(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].summary, ""); // header could not be read within the window
    assert.ok(Number.isFinite(listed[0].updated));
  });
});

// ---------------------------------------------------------------------------
// saveNote / pruneNotes
// ---------------------------------------------------------------------------

test("saveNote writes an atomic file (no leftover tmp file) and returns saved: true", () => {
  withTempDir((dir) => {
    const note = { ...makeNote(), topic: "jarvis-rebuild" };
    const result = saveNote(dir, note);
    assert.equal(result.saved, true);
    assert.deepEqual(result.pruned, []);
    assert.deepEqual(readdirSync(dir), ["jarvis-rebuild.md"]);
    // A note can carry standing facts under the user's own $HOME/.config, the
    // same reasoning saveStore in lib/memory.js gets mode 0o600 for.
    assert.equal(statSync(join(dir, "jarvis-rebuild.md")).mode & 0o777, 0o600);
  });
});

test("saveNote returns saved: false for a note with an empty topic slug", () => {
  withTempDir((dir) => {
    const result = saveNote(dir, { ...makeNote(), topic: "!!!" });
    assert.deepEqual(result, { saved: false, pruned: [] });
  });
});

test("saveNote refuses to write a note whose created or updated is not a finite number", () => {
  withTempDir((dir) => {
    // isoOf writes "" rather than throwing for a non-finite timestamp, which
    // means formatNote would happily produce a header line reading
    // "created: " with nothing after it -- a file parseHeaderText refuses to
    // read back. Writing it anyway would leave the topic worse off than no
    // write at all, so saveNote refuses before formatNote ever runs.
    const badCreated = saveNote(dir, { ...makeNote(), topic: "jarvis-3", created: NaN });
    assert.deepEqual(badCreated, { saved: false, pruned: [] });

    const badUpdated = saveNote(dir, { ...makeNote(), topic: "jarvis-3", updated: Infinity });
    assert.deepEqual(badUpdated, { saved: false, pruned: [] });

    assert.deepEqual(readdirSync(dir), []);
  });
});

test("saveNote returns saved: false and leaves no temp file when the write fails", () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores permission bits

  withTempDir((dir) => {
    const readOnlyDir = join(dir, "locked");
    mkdirSync(readOnlyDir);
    chmodSync(readOnlyDir, 0o500);
    try {
      const result = saveNote(readOnlyDir, { ...makeNote(), topic: "jarvis-rebuild" });
      assert.equal(result.saved, false);
      assert.equal(existsSync(join(readOnlyDir, "jarvis-rebuild.md")), false);
    } finally {
      chmodSync(readOnlyDir, 0o700);
    }
  });
});

test("saveNote prunes older files under tiny limits but never the one just saved", () => {
  withTempDir((dir) => {
    saveNote(dir, { ...makeNote(), topic: "old-one", updated: 1000, created: 1000 });
    saveNote(dir, { ...makeNote(), topic: "old-two", updated: 2000, created: 2000 });

    const result = saveNote(
      dir,
      { ...makeNote(), topic: "brand-new", updated: 3000, created: 3000 },
      { maxBytes: 1, maxFiles: 1 },
    );

    assert.equal(result.saved, true);
    assert.ok(result.pruned.includes("old-one"));
    assert.ok(result.pruned.includes("old-two"));
    assert.ok(!result.pruned.includes("brand-new"));
    assert.deepEqual(readdirSync(dir), ["brand-new.md"]);
  });
});

test("pruneNotes removes topics past the caps and reports what it removed", () => {
  withTempDir((dir) => {
    saveNote(dir, { ...makeNote(), topic: "a", updated: 1000, created: 1000 });
    saveNote(dir, { ...makeNote(), topic: "b", updated: 2000, created: 2000 });
    const removed = pruneNotes(dir, { maxBytes: 10, maxFiles: 100 });
    assert.deepEqual(removed, ["a"]);
    assert.deepEqual(readdirSync(dir), ["b.md"]);
  });
});

test("pruneNotes on an empty or missing directory removes nothing", () => {
  assert.deepEqual(pruneNotes("/no/such/dante-notes-dir", { maxBytes: 1, maxFiles: 1 }), []);
});

// ---------------------------------------------------------------------------
// writeSection
// ---------------------------------------------------------------------------

test("writeSection creates a new note with title/summary/about/facts and created = at", () => {
  withTempDir((dir) => {
    const at = Date.parse("2026-08-20T09:00:00.000Z");
    const result = writeSection(dir, "Jarvis 3", {
      at,
      kind: "read",
      text: "Started the session.",
      title: "Jarvis 3",
      summary: "The jarvis-3 session.",
      about: "What jarvis-3 did.",
      facts: { subject: "jarvis-3", status: "running" },
    });

    assert.ok(result);
    assert.equal(result.note.created, at);
    assert.equal(result.note.updated, at);
    assert.deepEqual(result.note.facts, { subject: "jarvis-3", status: "running" });
    assert.equal(result.note.sections.length, 1);

    const reloaded = loadNote(dir, "Jarvis 3");
    assert.equal(reloaded.summary, "The jarvis-3 session.");
  });
});

test("writeSection merges facts across calls, with new values winning", () => {
  withTempDir((dir) => {
    writeSection(dir, "jarvis-3", { at: 1000, text: "one", facts: { subject: "jarvis-3", status: "running" } });
    const second = writeSection(dir, "jarvis-3", { at: 2000, text: "two", facts: { status: "done", extra: "kept" } });

    assert.deepEqual(second.note.facts, { subject: "jarvis-3", status: "done", extra: "kept" });
  });
});

test("writeSection refreshes summary/about only when the caller actually supplies them", () => {
  withTempDir((dir) => {
    writeSection(dir, "jarvis-3", { at: 1000, text: "one", summary: "first summary", about: "first about" });
    const second = writeSection(dir, "jarvis-3", { at: 2000, text: "two" }); // no summary/about this time

    assert.equal(second.note.summary, "first summary");
    assert.equal(second.note.about, "first about");

    const third = writeSection(dir, "jarvis-3", { at: 3000, text: "three", summary: "updated summary" });
    assert.equal(third.note.summary, "updated summary");
    assert.equal(third.note.about, "first about"); // untouched
  });
});

test("writeSection never rewrites the title once the note exists", () => {
  withTempDir((dir) => {
    writeSection(dir, "jarvis-3", { at: 1000, text: "one", title: "Original Title" });
    const second = writeSection(dir, "jarvis-3", { at: 2000, text: "two", title: "A Different Title" });
    assert.equal(second.note.title, "Original Title");
  });
});

test("writeSection appends a second section on a second call to the same topic", () => {
  withTempDir((dir) => {
    writeSection(dir, "jarvis-3", { at: 1000, text: "first" });
    const second = writeSection(dir, "jarvis-3", { at: 2000, text: "second" });
    assert.equal(second.note.sections.length, 2);
    assert.equal(second.note.sections[1].text, "second");
  });
});

test("writeSection returns null for a topic that slugs to nothing", () => {
  withTempDir((dir) => {
    assert.equal(writeSection(dir, "!!!", { at: 1000, text: "x" }), null);
    assert.equal(writeSection(dir, "..", { at: 1000, text: "x" }), null);
  });
});

test("writeSection returns null when the underlying save fails", () => {
  if (process.getuid && process.getuid() === 0) return;

  withTempDir((dir) => {
    const readOnlyDir = join(dir, "locked");
    mkdirSync(readOnlyDir);
    chmodSync(readOnlyDir, 0o500);
    try {
      assert.equal(writeSection(readOnlyDir, "jarvis-3", { at: 1000, text: "x" }), null);
    } finally {
      chmodSync(readOnlyDir, 0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// Persistence across a simulated restart: write with one `dir`, read back
// from the same `dir` in a second, independent call.
// ---------------------------------------------------------------------------

test("a note written in one call is read back intact in a later call, as after a restart", () => {
  withTempDir((dir) => {
    writeSection(dir, "jarvis-3", {
      at: Date.parse("2026-08-20T09:00:00.000Z"),
      kind: "read",
      text: "Session started.",
      title: "Jarvis 3",
      summary: "The jarvis-3 session.",
      about: "What jarvis-3 did.",
      facts: { subject: "jarvis-3" },
    });

    // A brand-new read, as if this were a fresh process after a restart.
    const reloaded = loadNote(dir, "jarvis-3");
    assert.equal(reloaded.title, "Jarvis 3");
    assert.equal(reloaded.summary, "The jarvis-3 session.");
    assert.equal(reloaded.about, "What jarvis-3 did.");
    assert.deepEqual(reloaded.facts, { subject: "jarvis-3" });
    assert.equal(reloaded.sections.length, 1);
    assert.equal(reloaded.sections[0].text, "Session started.");

    const listed = listNotes(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].topic, "jarvis-3");
    assert.equal(listed[0].summary, "The jarvis-3 session.");
  });
});

// ---------------------------------------------------------------------------
// sessionNoteSpec -- turning a dispatchRead result into a writeSection input
// ---------------------------------------------------------------------------

test("sessionNoteSpec returns null when record.name is missing", () => {
  assert.equal(sessionNoteSpec({ sessionId: "abc12345" }, "", "text", 1000), null);
});

test("sessionNoteSpec returns null when record.sessionId is missing", () => {
  assert.equal(sessionNoteSpec({ name: "jarvis-3" }, "", "text", 1000), null);
});

test("sessionNoteSpec builds a topic from the name and the first eight characters of the session id", () => {
  const spec = sessionNoteSpec(
    { name: "jarvis-3", sessionId: "a1b2c3d4-e5f6-0000-0000-000000000000" },
    "",
    "It finished the migration.",
    1000,
  );
  assert.equal(spec.topic, topicSlug("jarvis-3-a1b2c3d4"));
});

test("sessionNoteSpec titles the note after the session's name", () => {
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4" }, "", "It finished.", 1000);
  assert.equal(spec.title, "Session jarvis-3");
});

test("sessionNoteSpec's summary is the first sentence of text, clipped to MAX_SUMMARY_CHARS", () => {
  const spec = sessionNoteSpec(
    { name: "jarvis-3", sessionId: "a1b2c3d4" },
    "",
    "It finished the migration. Then it ran the tests. Then it stopped.",
    1000,
  );
  assert.equal(spec.summary, "It finished the migration.");
});

test("sessionNoteSpec's summary falls back to the whole text when there is no sentence break", () => {
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4" }, "", "no punctuation here", 1000);
  assert.equal(spec.summary, "no punctuation here");
});

test("sessionNoteSpec's summary is clipped even when the first sentence alone exceeds MAX_SUMMARY_CHARS", () => {
  const long = "x".repeat(MAX_SUMMARY_CHARS + 50) + ". more.";
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4" }, "", long, 1000);
  assert.equal(spec.summary.length, MAX_SUMMARY_CHARS);
});

test("sessionNoteSpec's about names the session it was read from", () => {
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4" }, "", "text", 1000);
  assert.match(spec.about, /jarvis-3/);
});

test("sessionNoteSpec's facts report running when record.running is true", () => {
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4", running: true }, "", "text", 1000);
  assert.equal(spec.facts.status, "running");
});

test("sessionNoteSpec's facts report finished when record.running is false", () => {
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4", running: false }, "", "text", 1000);
  assert.equal(spec.facts.status, "finished");
});

test("sessionNoteSpec omits the status fact entirely when the roster could not be asked (running is null)", () => {
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4", running: null }, "", "text", 1000);
  assert.equal(Object.prototype.hasOwnProperty.call(spec.facts, "status"), false);
});

test("sessionNoteSpec omits the status fact when record.running is entirely absent", () => {
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4" }, "", "text", 1000);
  assert.equal(Object.prototype.hasOwnProperty.call(spec.facts, "status"), false);
});

test("sessionNoteSpec's facts carry subject, task and the cwd's basename, sanitized", () => {
  const spec = sessionNoteSpec(
    { name: "jarvis-3", sessionId: "a1b2c3d4", task: "fix the tests", cwd: "/home/krane/dev/jarvis", running: true },
    "",
    "text",
    1000,
  );
  assert.deepEqual(spec.facts, { subject: "jarvis-3", status: "running", task: "fix the tests", workspace: "jarvis" });
});

test("sessionNoteSpec omits task and workspace facts when the record carries neither", () => {
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4", running: true }, "", "text", 1000);
  assert.deepEqual(spec.facts, { subject: "jarvis-3", status: "running" });
});

test("sessionNoteSpec's section is the transcript text alone when there was no question", () => {
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4" }, "", "It finished.", 1000);
  assert.equal(spec.section.text, "It finished.");
  assert.equal(spec.section.kind, "read");
  assert.equal(spec.section.at, 1000);
});

test("sessionNoteSpec's section is prefixed with the question when one was asked", () => {
  const spec = sessionNoteSpec({ name: "jarvis-3", sessionId: "a1b2c3d4" }, "what did it decide", "It finished.", 1000);
  assert.equal(spec.section.text, "Asked: what did it decide\nIt finished.");
});

// ---------------------------------------------------------------------------
// discussionSection -- the chat that follows a read, folded into a section
// ---------------------------------------------------------------------------

test("discussionSection records both sides of the exchange", () => {
  const section = discussionSection(["what did it decide"], "It went with option two.", 2000);
  assert.deepEqual(section, { at: 2000, kind: "discussion", text: "Krane: what did it decide\nDante: It went with option two." });
});

test("discussionSection joins several interrupted-self sentences with a space", () => {
  const section = discussionSection(["one thing", "and another"], "Noted.", 2000);
  assert.equal(section.text, "Krane: one thing and another\nDante: Noted.");
});

test("discussionSection returns null when nothing was said", () => {
  assert.equal(discussionSection([], "Noted.", 2000), null);
  assert.equal(discussionSection(["   "], "Noted.", 2000), null);
});

test("discussionSection returns null when there was no reply", () => {
  assert.equal(discussionSection(["something"], "", 2000), null);
  assert.equal(discussionSection(["something"], "   ", 2000), null);
});

// ---------------------------------------------------------------------------
// topicIsLive -- whether a topic is still what the conversation is about
// ---------------------------------------------------------------------------

test("topicIsLive is true right up to the TTL and false just past it", () => {
  const topic = { topic: "jarvis-3-a1b2c3d4", at: 1000 };
  assert.equal(topicIsLive(topic, 1000 + NOTE_TOPIC_TTL_MS), true);
  assert.equal(topicIsLive(topic, 1000 + NOTE_TOPIC_TTL_MS + 1), false);
});

test("topicIsLive is false for a null topic", () => {
  assert.equal(topicIsLive(null, 1000), false);
});

test("topicIsLive respects a custom ttlMs", () => {
  const topic = { topic: "jarvis-3-a1b2c3d4", at: 1000 };
  assert.equal(topicIsLive(topic, 1500, 1000), true);
  assert.equal(topicIsLive(topic, 2500, 1000), false);
});

// ---------------------------------------------------------------------------
// recentNotes -- the n most recently updated notes, fully loaded
// ---------------------------------------------------------------------------

test("recentNotes returns the n most recently updated notes, newest first, fully loaded", () => {
  withTempDir((dir) => {
    writeSection(dir, "a", { at: 1000, text: "first" });
    writeSection(dir, "b", { at: 2000, text: "second" });
    writeSection(dir, "c", { at: 3000, text: "third" });

    const recent = recentNotes(dir, 2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].topic, "c");
    assert.equal(recent[0].sections[0].text, "third");
    assert.equal(recent[1].topic, "b");
  });
});

test("recentNotes defaults to MAX_CONTEXT_NOTES when n is not given", () => {
  withTempDir((dir) => {
    for (let i = 0; i < MAX_CONTEXT_NOTES + 2; i++) {
      writeSection(dir, `topic-${i}`, { at: 1000 + i, text: "x" });
    }
    assert.equal(recentNotes(dir).length, MAX_CONTEXT_NOTES);
  });
});

test("recentNotes on a missing directory returns an empty array rather than throwing", () => {
  assert.deepEqual(recentNotes(join(DEFAULT_DIR, "does-not-exist-at-all")), []);
});

// ---------------------------------------------------------------------------
// pickNotes -- pinning the note a turn is actually about
// ---------------------------------------------------------------------------

// A listNotes-shaped entry, minimal: pickNotes only ever reads topic,
// updated and subject.
function entry(topic, updated, subject = "") {
  return { topic, updated, subject };
}

test("pickNotes folds the live topic first even when three other notes were updated after it", () => {
  const entries = [
    entry("jarvis-3-a1b2c3d4", 1000),
    entry("newer-a", 4000),
    entry("newer-b", 3000),
    entry("newer-c", 2000),
  ];
  const picked = pickNotes(entries, { topic: "jarvis-3-a1b2c3d4" }, 2);
  assert.deepEqual(picked.map((e) => e.topic), ["jarvis-3-a1b2c3d4", "newer-a"]);
});

test("pickNotes folds a note whose subject was named in the turn ahead of a newer unrelated note", () => {
  const entries = [
    entry("a-topic", 1000, "a-subject"),
    entry("b-topic", 3000, "b-subject"),
  ];
  const picked = pickNotes(entries, { names: ["a-subject"] }, 2);
  assert.deepEqual(picked.map((e) => e.topic), ["a-topic", "b-topic"]);
});

test("pickNotes without a hint is the plain newest-first order", () => {
  const entries = [entry("older", 1000), entry("newer", 2000)];
  assert.deepEqual(pickNotes(entries, null).map((e) => e.topic), ["newer", "older"]);
  assert.deepEqual(pickNotes(entries, {}).map((e) => e.topic), ["newer", "older"]);
});

test("pickNotes never returns the same topic twice when the live topic is also the named one", () => {
  const entries = [entry("a-topic", 1000, "a-subject"), entry("b-topic", 2000, "b-subject")];
  const picked = pickNotes(entries, { topic: "a-topic", names: ["a-subject"] }, 2);
  assert.deepEqual(picked.map((e) => e.topic), ["a-topic", "b-topic"]);
});

// ---------------------------------------------------------------------------
// A forged "## <date> · <kind>" boundary inside section text must not be
// able to split a section in two, corrupt an `at`, or brick the note on its
// next write.
// ---------------------------------------------------------------------------

test("a section whose text contains a forged '## ... · ...' boundary survives write, reload and a second append with the text intact and never split in two", () => {
  withTempDir((dir) => {
    const tricky = "before\n## not-a-date · read\nafter";

    const first = writeSection(dir, "jarvis-3", { at: 1000, kind: "read", text: tricky });
    assert.ok(first);
    assert.equal(first.note.sections.length, 1);
    assert.equal(first.note.sections[0].text, tricky);

    const reloaded = loadNote(dir, "jarvis-3");
    assert.equal(reloaded.sections.length, 1);
    assert.equal(reloaded.sections[0].text, tricky);

    // Appending a second, real section must not throw even though the note
    // on disk already contains what looks like a second boundary.
    const second = writeSection(dir, "jarvis-3", { at: 2000, kind: "discussion", text: "reply" });
    assert.ok(second);
    assert.equal(second.note.sections.length, 2);
    assert.equal(second.note.sections[0].text, tricky);
    assert.equal(second.note.sections[1].text, "reply");

    const reloadedAgain = loadNote(dir, "jarvis-3");
    assert.equal(reloadedAgain.sections.length, 2);
    assert.equal(reloadedAgain.sections[0].text, tricky);
    assert.equal(reloadedAgain.sections[1].text, "reply");
  });
});

test("a section text line already escaped (starting with a backslash before '## ') round-trips byte-identical through format/parse twice", () => {
  // If escaping only triggered on a bare "## " line, a line that already
  // read like this -- real text, or the output of a PRIOR write/parse cycle
  // on this same note -- would pass through unescaped on write and then lose
  // its one real leading backslash on parse: indistinguishable from an
  // escape this module added and meant to remove. Escaping the escape is
  // what makes every additional write/parse cycle a no-op instead of a slow
  // one-backslash-per-cycle leak.
  const original = {
    title: "t", summary: "s", about: "a", created: 1000, updated: 1000, facts: {},
    sections: [{ at: 1000, kind: "read", text: "\\## x \u00b7 y" }],
  };

  const once = parseNote(formatNote(original));
  assert.equal(once.sections[0].text, "\\## x \u00b7 y");

  const twice = parseNote(formatNote(once));
  assert.equal(twice.sections[0].text, "\\## x \u00b7 y");
});

test("formatNote does not throw when created or updated is not finite", () => {
  assert.doesNotThrow(() => {
    formatNote({ title: "t", summary: "s", about: "a", created: NaN, updated: NaN, facts: {}, sections: [] });
  });
  const out = formatNote({ title: "t", summary: "s", about: "a", created: NaN, updated: NaN, facts: {}, sections: [] });
  assert.match(out, /^created: \n/m);
});

test("writeSection never throws when the existing file on disk has a section with an unparsable date", () => {
  withTempDir((dir) => {
    const clean = formatNote({
      title: "Title", summary: "s", about: "a", created: 1000, updated: 1000, facts: {},
      sections: [{ at: 1000, kind: "read", text: "stale text" }],
    });
    // A hand edit that mangles a section's date, leaving everything else --
    // including the "\n---\n" header/body separator -- intact.
    const corrupted = clean.replace(/## [^\n]* · read/, "## garbage-date · read");
    writeFileSync(join(dir, "jarvis-3.md"), corrupted);

    let result;
    assert.doesNotThrow(() => {
      result = writeSection(dir, "jarvis-3", { at: 5000, kind: "discussion", text: "new text" });
    });
    assert.ok(result);
    // The corrupt section was dropped on load rather than carried forward
    // with a NaN `at`; only the new section survives.
    assert.equal(result.note.sections.length, 1);
    assert.equal(result.note.sections[0].text, "new text");
  });
});

// ---------------------------------------------------------------------------
// pruneNotes and recentNotes must act on the real path a file was listed at,
// not a path re-derived from its topic through topicSlug -- a hand-named
// file's basename does not always survive slugging intact.
// ---------------------------------------------------------------------------

test("pruneNotes deletes a hand-named file at its own path, even though slugging it would point nowhere", () => {
  withTempDir((dir) => {
    const older = formatNote({
      title: "Older", summary: "s", about: "a", created: 1000, updated: 1000, facts: {},
      sections: [{ at: 1000, kind: "note", text: "old" }],
    });
    const newer = formatNote({
      title: "Newer", summary: "s", about: "a", created: 2000, updated: 2000, facts: {},
      sections: [{ at: 2000, kind: "note", text: "new" }],
    });
    writeFileSync(join(dir, "My Notes.md"), older); // slugs to "my-notes.md", which does not exist
    writeFileSync(join(dir, "keeper.md"), newer);

    const removed = pruneNotes(dir, { maxBytes: DEFAULT_MAX_BYTES, maxFiles: 1 });
    assert.deepEqual(removed, ["My Notes"]);
    assert.deepEqual(readdirSync(dir), ["keeper.md"]);
  });
});

test("pruneNotes never deletes the newer file when a hand-named file's slug collides with it", () => {
  withTempDir((dir) => {
    const older = formatNote({
      title: "Older", summary: "s", about: "a", created: 1000, updated: 1000, facts: {},
      sections: [{ at: 1000, kind: "note", text: "old" }],
    });
    const newer = formatNote({
      title: "Newer", summary: "s", about: "a", created: 2000, updated: 2000, facts: {},
      sections: [{ at: 2000, kind: "note", text: "new" }],
    });
    writeFileSync(join(dir, "My Notes.md"), older); // slugs to "my-notes.md" -- the OTHER file's real name
    writeFileSync(join(dir, "my-notes.md"), newer); // the newer file, and must survive

    const removed = pruneNotes(dir, { maxBytes: DEFAULT_MAX_BYTES, maxFiles: 1 });
    assert.deepEqual(removed, ["My Notes"]);
    assert.deepEqual(readdirSync(dir), ["my-notes.md"]);
  });
});

test("recentNotes loads a hand-named file from its own path rather than a re-slugged one", () => {
  withTempDir((dir) => {
    const note = formatNote({
      title: "T", summary: "s", about: "a", created: 1000, updated: 1000, facts: {},
      sections: [{ at: 1000, kind: "note", text: "hello" }],
    });
    writeFileSync(join(dir, "My Notes.md"), note);

    const recent = recentNotes(dir, 5);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].topic, "My Notes");
    assert.equal(recent[0].sections[0].text, "hello");
  });
});

// ---------------------------------------------------------------------------
// planPruning is deterministic when two entries share one `updated`
// ---------------------------------------------------------------------------

test("planPruning breaks a tie on equal updated timestamps deterministically by topic, regardless of input order", () => {
  const entries = [
    { topic: "zeta", bytes: 1, updated: 1000 },
    { topic: "alpha", bytes: 1, updated: 1000 },
    { topic: "keeper", bytes: 1, updated: 2000 },
  ];
  const removed = planPruning(entries, { maxBytes: 1000, maxFiles: 1 });
  assert.deepEqual(removed.map((e) => e.topic), ["alpha", "zeta"]);

  const removedReversed = planPruning([...entries].reverse(), { maxBytes: 1000, maxFiles: 1 });
  assert.deepEqual(removedReversed.map((e) => e.topic), ["alpha", "zeta"]);
});

// ---------------------------------------------------------------------------
// notesContext must cap what it folds in, even when the note on disk was
// never sanitized by this module (a hand edit, or one written before a cap
// changed) -- it is folded into a prompt, the same injection surface the
// roster and the preference store are.
// ---------------------------------------------------------------------------

test("notesContext caps a note whose summary and body are far larger than the per-note limits", () => {
  const note = {
    topic: "jarvis-3",
    updated: 1000,
    summary: "s".repeat(50 * 1024),
    sections: [{ at: 1000, kind: "read", text: "b".repeat(50 * 1024) }],
  };
  const context = notesContext([note], 1000);
  assert.ok(context.length < 2048, `expected the context block to stay under 2KB, got ${context.length}`);
});

// ---------------------------------------------------------------------------
// A hand-edited facts: block must not be able to name __proto__, constructor
// or prototype, the same guard sanitizeFacts applies to facts written
// through this module.
// ---------------------------------------------------------------------------

test("a hand-edited facts: block naming constructor yields no constructor fact", () => {
  const text = [
    "# Title",
    "summary: s",
    "about: a",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
    "facts:",
    "  constructor: c",
    "  subject: jarvis-3",
    "",
    "---",
    "",
    "",
  ].join("\n");

  const note = parseNote(text);
  assert.ok(note);
  assert.equal(Object.prototype.hasOwnProperty.call(note.facts, "constructor"), false);
  assert.deepEqual(note.facts, { subject: "jarvis-3" });
});


// ---------------------------------------------------------------------------
// foldNotes -- the per-turn call: touch recent notes into the tracker,
// return the context block plus any pending contradiction.
// ---------------------------------------------------------------------------

test("foldNotes touches recent notes into the tracker and returns their context block", () => {
  withTempDir((dir) => {
    writeSection(dir, "jarvis-3", { at: 1000, text: "one", summary: "s1", facts: { subject: "jarvis-3" } });
    const tracker = createNoteTracker();
    const { context, flag } = foldNotes(tracker, dir, 1000);
    assert.match(context, /NOTE jarvis-3/);
    assert.equal(flag, "");
    assert.deepEqual(tracker.topics(), ["jarvis-3"]);
  });
});

test("foldNotes' flag reports a contradiction among the notes it just touched", () => {
  withTempDir((dir) => {
    writeSection(dir, "a", { at: 1000, text: "one", facts: { subject: "x", task: "build" } });
    writeSection(dir, "b", { at: 2000, text: "two", facts: { subject: "x", task: "ship" } });
    const tracker = createNoteTracker();
    const { flag } = foldNotes(tracker, dir, 2000);
    assert.notEqual(flag, "");
    assert.match(flag, /task/);
  });
});

test("foldNotes never marks a contradiction reported -- calling it twice returns the same flag both times", () => {
  withTempDir((dir) => {
    writeSection(dir, "a", { at: 1000, text: "one", facts: { subject: "x", task: "build" } });
    writeSection(dir, "b", { at: 2000, text: "two", facts: { subject: "x", task: "ship" } });
    const tracker = createNoteTracker();
    const first = foldNotes(tracker, dir, 2000);
    const second = foldNotes(tracker, dir, 2000);
    assert.equal(first.flag, second.flag);
    assert.notEqual(first.flag, "");
  });
});

test("foldNotes on an empty directory returns an empty context and an empty flag", () => {
  withTempDir((dir) => {
    const tracker = createNoteTracker();
    const { context, flag } = foldNotes(tracker, dir, 1000);
    assert.equal(context, "");
    assert.equal(flag, "");
  });
});

test("foldNotes reports the topics it folded and the size of the block, in fold order", () => {
  withTempDir((dir) => {
    writeSection(dir, "old-topic", { at: 1000, text: "old" });
    writeSection(dir, "newest-topic", { at: 2000, text: "newest" });
    const tracker = createNoteTracker();
    const { context, topics, chars } = foldNotes(tracker, dir, 2000, { topic: "old-topic" });
    assert.deepEqual(topics, ["old-topic", "newest-topic"]);
    assert.equal(chars, context.length);
  });
});

test("foldNotes with a hint hands notesContext the pinned note first", () => {
  withTempDir((dir) => {
    writeSection(dir, "old-topic", { at: 1000, text: "old", summary: "the old one" });
    writeSection(dir, "middle-topic", { at: 2000, text: "middle", summary: "the middle one" });
    writeSection(dir, "newest-topic", { at: 3000, text: "newest", summary: "the newest one" });
    const tracker = createNoteTracker();
    // Without the hint, MAX_CONTEXT_NOTES 2 folds newest-topic and
    // middle-topic, bumping old-topic out entirely -- with it, old-topic
    // keeps its seat and middle-topic (neither pinned nor newest) is the one
    // left out instead.
    const { context } = foldNotes(tracker, dir, 3000, { topic: "old-topic" });
    assert.match(context, /NOTE old-topic/);
    assert.match(context, /NOTE newest-topic/);
    assert.doesNotMatch(context, /NOTE middle-topic/);
  });
});

// ---------------------------------------------------------------------------
// recordDiscussion -- append the chat that followed a read, only while its
// topic is still live.
// ---------------------------------------------------------------------------

test("recordDiscussion appends a discussion section and returns a refreshed topic when the topic is live", () => {
  withTempDir((dir) => {
    writeSection(dir, "jarvis-3", { at: 1000, kind: "read", text: "started" });
    const topic = { topic: "jarvis-3", at: 1000 };
    const limits = { maxBytes: DEFAULT_MAX_BYTES, maxFiles: DEFAULT_MAX_FILES };

    const result = recordDiscussion(dir, topic, ["what happened"], "it finished", 2000, limits);
    assert.ok(result);
    assert.deepEqual(result.topic, { topic: "jarvis-3", at: 2000 });
    assert.deepEqual(result.pruned, []);

    const reloaded = loadNote(dir, "jarvis-3");
    assert.equal(reloaded.sections.length, 2);
    assert.equal(reloaded.sections[1].kind, "discussion");
    assert.match(reloaded.sections[1].text, /it finished/);
  });
});

test("recordDiscussion returns null and writes nothing once the topic has gone stale", () => {
  withTempDir((dir) => {
    writeSection(dir, "jarvis-3", { at: 1000, kind: "read", text: "started" });
    const staleTopic = { topic: "jarvis-3", at: 1000 };
    const now = 1000 + NOTE_TOPIC_TTL_MS + 1;

    const result = recordDiscussion(dir, staleTopic, ["what happened"], "it finished", now, undefined);
    assert.equal(result, null);

    const reloaded = loadNote(dir, "jarvis-3");
    assert.equal(reloaded.sections.length, 1);
  });
});

test("recordDiscussion returns null and writes nothing when there is nothing to record", () => {
  withTempDir((dir) => {
    writeSection(dir, "jarvis-3", { at: 1000, kind: "read", text: "started" });
    const topic = { topic: "jarvis-3", at: 1000 };

    assert.equal(recordDiscussion(dir, topic, [], "it finished", 2000, undefined), null);
    assert.equal(recordDiscussion(dir, topic, ["what happened"], "", 2000, undefined), null);

    const reloaded = loadNote(dir, "jarvis-3");
    assert.equal(reloaded.sections.length, 1);
  });
});

test("recordDiscussion returns null for a null topic", () => {
  withTempDir((dir) => {
    assert.equal(recordDiscussion(dir, null, ["x"], "y", 1000, undefined), null);
  });
});
