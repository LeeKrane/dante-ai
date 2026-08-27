# Incomplete work

## I1 — Stage 42 (`ask-repo`) is written and tested but never committed

`primitives/ask-repo.mjs` is untracked; `test/registry.test.js` carries its tests
as an uncommitted modification. `lib/registry.js` scans `primitives/` and loads
every `.mjs` not starting with `_` or `.`, so it needs no manifest entry — it is
already live for anyone running from this working tree, and absent for anyone
who checks the branch out.

Before it is committed, note that its central promise is currently unenforced —
see **S2** in [security.md](security.md).

## I2 — the chain depth cap is unreachable; chains stop after one hop

`server.js:270` (`dispatchChain`), `lib/memory.js:588` (`MAX_CHAIN_DEPTH`)

The chaining machinery is otherwise complete and careful. The gap is one argument:
`dispatchChain` starts the successor with `then: null` hardcoded, so a chained
session can never itself record a chain. `chainAfter` is therefore only ever
reached from the spoken start path, always with `depth: 0`, and its
`if (depth >= MAX_CHAIN_DEPTH) return null;` guard can never fire.

Two consequences:

- `MAX_CHAIN_DEPTH = 3` is dead. Its only exercise is synthetic, in
  `test/memory.test.js:827` and `:830`, which pass `depth` in directly — which is
  why the suite is green.
- A real chain runs exactly one successor. `depth: chain.depth + 1` at
  `server.js:270` threads a value that is always discarded.

Either the multi-hop case was intended and `then` is not being carried through
(in which case a successor's own `then` needs plumbing, and the cap starts
mattering), or one hop is the intended product and the cap plus the `depth`
threading are vestigial. The code does not say which, and — unusually for this
file — `then: null` carries no comment, while the `depth` cap it defeats carries
a long one.

## I3 — untested modules

`public/app.js` (1053 lines) and `public/build-hud.js` (1023 lines) have no test
file. They also account for 5 of the 10 findings in [bugs.md](bugs.md), which is
roughly what you would expect.

`server.js` has no test file either; `CLAUDE.md` already records that as a known
gap, and the house rule ("put new logic in a `lib/` or `public/` module that can
be tested, and keep `server.js` to wiring") is the standing answer. Worth noting
that B1 and B4 are both in `server.js`, and both are wiring-shaped rather than
logic-shaped — i.e. exactly the class the rule accepts as the cost.

## I4 — clean

Checked and found nothing:

- No `TODO`, `FIXME`, `XXX`, `HACK`, "not implemented", "stub" or "placeholder"
  markers anywhere in `lib/`, `public/`, `server.js`, `primitives/` or `hooks/`.
- No config key loaded by `lib/config.js` that is never consumed.
- No genuinely dead exports.
