# jarvis-demo

Voice front-end to headless Claude Code. Hold a key, speak, release: Chrome's Web Speech API
transcribes, a WebSocket carries the text to this Node server, `claude -p` answers, and Fish
Audio speaks the reply. Ask it to build something and a second `claude -p` runs with file tools
on, in its own throwaway directory.

**`lib/README.md` is the real README** — architecture, the security model, and the extension
points. Read it before changing anything under `lib/`.

## House rules

These are enforced by the existing code but written down nowhere else:

- **No new dependencies.** `ws` is the only one, and the README advertises that. Everything else
  is a `node:` builtin. No frameworks, no build step, no bundler, no TypeScript.
- **Tests are `node:test` + `node:assert/strict`**, run by `npm test` (`node --test`). No test
  framework, no mocking library. Impure code is tested against real temp directories
  (`mkdtemp`) and real fake CLIs written to disk and passed as `opts.bin` — see the `writeFake`
  helper in `test/builder.test.js`. Reuse the existing fixtures rather than inventing new ones.
- **Note `assert.deepEqual` is strict here** (it comes from `node:assert/strict`), so widening a
  function's return shape breaks every whole-object assertion against it.
- **Test names are full sentences** describing behaviour: `"a non-zero exit is a failed build,
  even with the artifact present"`. No `describe`/`it` nesting.
- **Comments explain why, not what**, in the existing prose voice — full sentences, and usually
  the reason a non-obvious choice was made rather than an obvious one. Several comments in
  `lib/builder.js` and `lib/action.js` document real bugs that were fixed; do not delete or
  paraphrase them away.
- **Pure functions are the test seam.** `denyRules`, `buildSettings`, `buildSpawnArgs`,
  `validatePrimitive`, `describeFailure`, `parseAction` are all side-effect free on purpose, and
  everything impure takes an injectable override (`opts.bin`, `opts.root`, `opts.settings`,
  `opts.home`, `opts.repo`, `loadRegistry(dirUrl)`). Keep new logic on that side of the line.
- **`server.js` has no test file.** That is a known gap, not a licence: put new logic in a
  `lib/` or `public/` module that can be tested, and keep `server.js` to wiring.

## Security-critical

`lib/builder.js` spawns a real Claude Code session with file tools on, under the user's login.
Two deny layers keep it in its lane, and both are load-bearing:

- `REACHES_OUTSIDE` (the `--disallowedTools` floor) — an `allowedTools` list is *not* a sandbox;
  only `--disallowedTools` actually removes a tool.
- `denyRules()` / `deniedDirs()` / `deniedFiles()` — the generated per-build settings file that
  names the paths a build must never write to.

Changes to either are a security review, never a casual edit. `--allowedTools` and
`--disallowedTools` are variadic and swallow every following token until one starts with `-`, so
argument order in `buildSpawnArgs` matters; the trailing `--` is what ends the list.

## Reading this codebase

It is small — roughly 7,000 lines including tests — which makes it cheap to read and expensive
to read *twice*. Two rules:

- **A subagent's output is a read.** When an Explore or Plan agent returns verbatim source, do
  not re-open those files with Read. In one session that duplication cost ~40k tokens for zero
  new information.
- **Do not run `/learn-codebase` after an exploration pass**, or the reverse. They cover the
  same ground. Pick whichever the task needs.

## Shell note

`cat` is aliased to `bat` in this environment, which writes ANSI escape codes into any file you
redirect it into. Use `command cat`, `printf`, or a file-writing tool for heredocs.
