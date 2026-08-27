# Audit findings — 2026-08-27

An orchestrated read-only audit of the tree as it stood on `feat/session-orchestration`,
**including the uncommitted `server.js` chaining work and the untracked
`primitives/ask-repo.mjs`**. Line numbers refer to that working tree, not to `main`.

Baseline before the audit: `npm test` → 712 tests, 712 pass, 0 fail.

| Report | What is in it |
|---|---|
| [security.md](security.md) | 5 findings against the two deny layers and the served artifacts |
| [bugs.md](bugs.md) | 10 verified defects, ranked |
| [incomplete.md](incomplete.md) | Half-finished work and dead ceilings |

## How these were produced, and what that is worth

Six sub-agents ran over the tree; every finding they returned was then re-checked
by hand against the source before it was written down here. That step was not a
formality:

- **Three of the six agents returned findings that were entirely false.** Two
  independently reported that session chaining was unwired — that `chainAfter`
  was never imported and no consumer existed. Both were wrong: the import is at
  `server.js:30`, `takeChain` fires at `server.js:184`, and a full `dispatchChain()`
  consumer sits at `server.js:228`. A third reported three "dead exports" that are
  all default-parameter values used in their own file.
- **The likely cause is tooling, not the models.** `grep` in this environment is
  wrapped and truncates long output with a `+1 more [see remaining: …]` line.
  An agent that greps for a symbol, gets a truncated result, and reads absence
  of a match as absence of the symbol will confidently report a missing import
  that is right there. Re-running the same agents with an explicit warning about
  the wrapper — and an instruction never to claim absence without opening the
  region and reading it — produced accurate reports.

Practical consequence for future passes over this repo: **an agent's absence
claim ("X is never called", "Y is not imported") is not evidence.** Confirm it
by reading the region, or use `rg -n … | cat`.

Findings that were investigated and **dropped as not-bugs** are listed at the
bottom of [bugs.md](bugs.md), so the same ground is not re-covered next time.
