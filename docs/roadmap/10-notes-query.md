# 10. Notes query by voice

**Verdict** SOON. **Size** S to M. **Channel** + (one question, one answer). Read only: this
plan never writes memory.

## Goal

"What do you know about X" finds the notes whose subject matches X across the whole notes store
and speaks the best match, without a model turn and without recording the answer as a new
discussion.

## Why

Only `MAX_CONTEXT_NOTES = 2` notes ride along with each turn (`lib/notes.js:55`), chosen by the
session being discussed. Everything older is invisible unless the model happens to recall it.
The retrieval already exists; what is missing is a way to aim it with a spoken subject.

## Today

- `pickNotes(notes, hint)` in `lib/notes.js:1210-1241` orders notes by `hint = { topic, names }`,
  where `topic` is a session topic key set by `dispatchRead` / `recordDiscussion`, not free text.
- `foldNotes` (`lib/notes.js:1288`) runs every turn from `server.js:2536` with `hint.topic =
  conv.topic` gated by `topicIsLive`, and `hint.names = mentionedSessions(...)`.
- `recordDiscussion` writes a discussion section after turns inside the topic window
  (`server.js:2381`, `:2521`). Notes are treated as an injection surface: everything re-entering
  a prompt goes through the module's cleaning and caps.
- `say(send, text, nextState)` in `server.js:1384-1440` speaks a string straight to the page;
  `MAX_REPLY_CHARS = 700` in `lib/spawn-session.js:36` is the existing spoken-reply cap.

## Design

1. **Pure search.** `searchNotes(notes, query, opts = {})` in `lib/notes.js`: tokenises the
   query the way `slugify` in `lib/sessions.js` does (lowercase, alphanumeric, filler dropped),
   scores each note by token overlap on its subject line and section headings, ties broken by
   recency, returns the best `opts.limit` (default 1) as `{ subject, text, at }`. Reuse the
   existing cleaning helpers for `text`; cap it at `opts.maxChars` (default 600, under
   `MAX_REPLY_CHARS`).
2. **Verb.** `[ACTION:SESSION verb=notes topic=<words>]`. In `dispatchSession`
   (`server.js:1953`) add a `notes` case, unconfirmed like `recap`: load the store, call
   `searchNotes`, speak "On <subject>, sir: <text>" or "I have nothing on <topic>, sir." The
   spoken text goes to TTS only; it does not enter the next prompt.
3. **No echo.** The turn that answers must not call `recordDiscussion` and must not move
   `conv.topic`; guard it the way `dispatchRecap` is guarded. Otherwise the answer becomes a new
   note and the store feeds itself.
4. **Persona.** One clause in `sessionsBlock` in `lib/brain.js`: `verb=notes topic=...` when the
   owner asks what Dante knows or remembers about a subject. Pin in `test/brain.test.js`.

## Files

- `lib/notes.js`: `searchNotes`. `lib/brain.js`: one clause. `server.js`: one case. Docs below.

## Tests

- `test/notes.test.js`: exact subject match beats partial; recency breaks ties; filler-only
  query returns nothing; `maxChars` cap cuts on a sentence boundary if the existing helpers do;
  unprintables in a note never reach the result.
- `test/brain.test.js`: persona pin. `test/action.test.js`: the tag parses with `topic`.

## Docs

- `README.md`, the Notes section: one sentence that notes can be asked for by subject.
- `docs/voice-reference.md`: the phrases.

## Done when

With a note whose subject is "builder deny list", saying "what do you know about the deny list"
speaks that note's text, the store's byte size is unchanged afterwards, and the next ordinary
turn still folds only two notes. `npm test` green.

## Out of scope

Writing or editing notes by voice. Searching session transcripts (rejected council item 27).
