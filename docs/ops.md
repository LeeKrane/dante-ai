# Running Dante as a service

The operator's reference for keeping Dante running unattended — as a systemd
service on a machine that stays on, rather than `node server.js` in a
terminal you have to keep open. Assumes you've already done the one-time
setup in the [README](../README.md#setup); it doesn't repeat that.

## 1. Requirements

- **Node 20+** — `package.json`'s `engines.node` (`>=20`). `npm start` and the
  unit below both just run `node server.js`.
- **`claude` on PATH, logged in, as the user the service runs as.** `claude -p
  "say hi"` must work non-interactively under that exact user/environment
  before you wire up a unit — a shell where `which claude` succeeds is not the
  same environment systemd gets by default. See the PATH landmine in §3.
- **Chrome**, on whatever machine you talk to Dante from — the speech-to-text
  is Chrome's Web Speech API, nothing else implements it.

## 2. Environment variables

All configuration is env vars, loaded from `.env` via `dotenv` at startup
(`server.js` top; a real environment variable always wins over `.env`). The
two loaders below **throw at startup** — not at first use — when a required
key is missing, so a bad `.env` fails loudly before the server binds a port.

| Variable | Required | Default | Source |
|---|---|---|---|
| `FISH_API_KEY` | yes | — (throws) | `lib/config.js` `loadFishConfig` |
| `FISH_VOICE_ID` | no | `""` (Fish's default voice) | `lib/config.js` |
| `FISH_MODEL` | no | `s2.1-pro-free` | `lib/config.js` |
| `FISH_FORMAT` | no | `mp3` | `lib/config.js` |
| `FISH_SPEED` | no | `1` | `lib/config.js` |
| `FISH_PITCH` | no | `0` (semitones; applied client-side, not sent to Fish) | `lib/config.js` |
| `FISH_VOLUME` | no | `0` (-20 to 20) | `lib/config.js` |
| `SUPABASE_URL` | yes | — (throws) | `lib/config.js` `loadSupabaseConfig` |
| `SUPABASE_ANON_KEY` | yes | — (throws) | `lib/config.js` |
| `SECURE_COOKIE` | no | unset (cookie not `Secure`) | `lib/config.js`; set `"1"` only behind TLS |
| `PORT` | no | `3210` | `server.js:71` |
| `DANTE_HOST` | no | `127.0.0.1` (loopback only) | `lib/config.js` `serverIdentity` |
| `DANTE_WG_IP` | no | `""` (no VPN access) | `lib/config.js` |
| `DANTE_PORT` | no | `3210` | read by the hooks (`hooks/dante-*.mjs`) to find the server; separate from `PORT` because the hooks are a different process |

`FISH_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` missing means the process
exits immediately with a message naming which one. `.env.example` at the repo
root documents the same table with fuller comments — copy it, don't retype it.

## 3. Running

**Foreground, for development:**

```bash
npm start          # == node server.js
```

**As a systemd service, for a machine that stays on.** There's no unit
shipped in this repo (`server.js` has no opinion about your init system) —
this is a minimal correct one to adapt:

```ini
[Unit]
Description=Dante AI
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/development/jarvis
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=2
# .env is loaded by dotenv either way; EnvironmentFile is an alternative/addition
# for values you want set at the service-manager level (DANTE_HOST, SECURE_COOKIE).
EnvironmentFile=-/home/YOUR_USER/development/jarvis/.env
Environment=PATH=/usr/bin:/bin

[Install]
WantedBy=multi-user.target
```

**The landmine:** never write `Environment=PATH=$PATH` — systemd does not
expand it, the child gets the literal string `$PATH`, `claude` is not found
on it, and every `claude -p` spawn from `lib/brain.js` / `lib/builder.js`
fails with **exit 127**, which looks like an auth or install problem but
isn't. Use a literal path (`which node`, `which claude`, as the service's
`User`) or an `EnvironmentFile=` that sets `PATH` explicitly instead.

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now jarvis
systemctl status jarvis
journalctl -u jarvis -f       # live logs; -n 100 for the last 100 lines
sudo systemctl restart jarvis
```

On startup the process logs the bind address and what it loaded:
`Dante on http://127.0.0.1:3210`, `primitives: <ids, or "none">`,
`session kinds: <ids, or "none">`. `none` when you expected otherwise means
`primitives/*.mjs` or `sessions/*.mjs` failed to load — the actual error is in
the log just above, swallowed by neither loader.

## 4. Network

- **Bind address** — loopback (`127.0.0.1`) unless `DANTE_HOST` says
  otherwise (`lib/config.js` `serverIdentity`). This process runs a model
  with file-writing tools on and then serves what it wrote; reaching further
  than your own machine is opt-in, not a default.
- **WireGuard** — set `DANTE_WG_IP` to the VPN-side address you want allowed
  through; empty/unset disables non-loopback access entirely.
- **Allow-list, not just a bind address** — `allowedHosts` / `allowedOrigins`
  in `lib/config.js` build a strict allow-list from `DANTE_HOST` +
  `DANTE_WG_IP` + loopback, and `server.js` checks every request's `Host`
  header (and every WebSocket upgrade's `Origin`) against it — a
  DNS-rebinding defence, since binding loopback alone doesn't stop a hostile
  page from pointing a hostname it owns at `127.0.0.1`.
- **`/hook` and `/approve` are loopback-only, always, regardless of
  `DANTE_HOST`** — they check `req.socket.remoteAddress` directly, not the
  Host allow-list. So `hooks/dante-*.mjs`, which always POST to `127.0.0.1`,
  stop working the moment `DANTE_HOST` is a specific non-loopback address;
  use `0.0.0.0` or leave `DANTE_HOST` unset if you rely on the hooks.
- **TLS** — this server speaks plain HTTP only; put a reverse proxy (nginx,
  Caddy) in front for TLS, and only then set `SECURE_COOKIE=1`
  (`lib/config.js` / `lib/auth.js`) — a `Secure` cookie is silently never
  sent over `http://`, so setting it without TLS produces a login that
  appears to work and then doesn't hold.

See the README's [Security](../README.md#security) section for the full
threat model — build deny layers, transcript handling, the approval channel.

## 5. Installing the two hooks

**Dante never writes `~/.claude/settings.json` itself** — its own build deny
list (`lib/builder.js`) forbids a build from touching `~/.claude/**`, since a
hook is code that runs on your *next* session and it would be incoherent for
the assistant to exempt itself from a rule it enforces on every build. Paste
these into your own `~/.claude/settings.json` by hand, once.

**Notifications** (`hooks/dante-notify.mjs`) — reports session start/stop and
attention-needed events to the recap log, faster than the roster poller's
five-second sweep and the only way to see a session that's blocked waiting on
you:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/TO/jarvis/hooks/dante-notify.mjs" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/TO/jarvis/hooks/dante-notify.mjs" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/TO/jarvis/hooks/dante-notify.mjs" }] }]
  }
}
```

**Voice approval** (`hooks/dante-approve.mjs`) — blocks a `Write`/`Edit`/
`Bash` call that reaches outside the session's own repo or that publishes
(`git push`, `gh pr create`, `gh release create`, `npm publish`), and asks you
out loud instead of just stalling with nobody at the terminal:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
      "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/TO/jarvis/hooks/dante-approve.mjs", "timeout": 120 }]
    }]
  }
}
```

Both always exit 0 and time out fast (1s / 90s) — a Dante that's down costs a
session nothing, never a hang or a denial — and both POST to
`127.0.0.1:DANTE_PORT` (default `3210`) regardless of where the server binds.

## 6. State on disk

Everything Dante remembers lives under `~/.config/dante/`, plus `builds/`.

| Path | What it is | Back up | Safe to delete |
|---|---|---|---|
| `~/.config/dante/memory.json` | preferences, rolling summary, last 10 artifacts, workspace aliases, main repo, resumable session id (`lib/memory.js` `DEFAULT_PATH`); mode `0600` | yes | deleting loses preferences and aliases, not catastrophic |
| `~/.config/dante/memory/*.md` | one Markdown note per topic — session reads and the discussion that followed (`lib/notes.js` `DEFAULT_DIR`); each file mode `0600` | yes | yes, per-file or all; oldest-updated is pruned automatically anyway |
| `builds/<timestamp>/` (repo root) | every build's output + `build.log`; `MAX_BUILDS = 1` (`server.js`) means only one runs at a time, but old ones are never cleaned up automatically | no (regenerable) | yes — rotate/delete old ones yourself; nothing in the app does it for you |
| `sessions/*.mjs`, `primitives/*.mjs` | your own session-kind and build-primitive definitions — source you wrote, not runtime state | yes (it's config, via your normal git workflow) | no |

Notes capacity defaults to 50 MB or 500 files (`lib/notes.js`
`DEFAULT_MAX_BYTES` / `DEFAULT_MAX_FILES`), whichever is hit first — oldest-
updated is pruned first on every write, newest is never pruned even alone
over the cap. Change the cap by voice ("keep your notes under a hundred
megabytes") rather than editing the file, so it stays consistent with what
`lib/memory.js` has recorded.

## 7. Upgrading the `claude` CLI

Several files depend on `claude` CLI behaviour that is empirically observed,
not a published interface, so a CLI upgrade can silently break them:

- `lib/agents.js` — parses `claude agents --json` into the session roster.
- `lib/transcript.js` — reads the jsonl transcript layout directly off disk.
- `lib/peer.js` — writes to the CLI's own unix domain socket
  (`messagingSocketPath` in `~/.claude/sessions/<pid>.json`, established
  against CLI 2.1.246) to interrupt a live session.
- `lib/spawn-session.js` — parses `claude --bg`'s startup stdout for the new
  session's id.

After any `claude` upgrade, re-check all four against real output before
trusting Dante again — `npm test` won't catch a CLI-shape change, since the
tests run against fake CLIs, not the real one. See
[`docs/known-limitations.md`](known-limitations.md) for what each assumes and
how to verify it still holds.

## 8. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Any spawned `claude` call fails with exit 127 | PATH landmine (§3) — the service's `PATH` doesn't resolve `claude`; fix the unit's `Environment=`/`EnvironmentFile=`, don't touch the app |
| "connection closed — restart the server and refresh" | the server process died or was restarted; `systemctl restart jarvis` (or `node server.js` again) then reload the page — the WebSocket doesn't reconnect itself across a server restart |
| Stuck on the login page / keeps bouncing back to it | cookie not being set or not being sent — check `SECURE_COOKIE` isn't `1` without TLS in front (a `Secure` cookie over plain `http://` is silently dropped), and that the browser's `Host` matches an entry in the allow-list (§4) |
| No audio at all | check `FISH_API_KEY` / `FISH_MODEL` tier first (a `402`/`403` from Fish means credits or plan), then browser autoplay/mic permissions per the README's own troubleshooting table |
| `spawn claude ENOENT` | same family as exit 127 — node can't see `claude` on its `PATH` at all |

For everything client-side (mic permissions, `EADDRINUSE`, build timeouts) see
the README's own [When something breaks](../README.md#when-something-breaks)
table — this one covers only what's specific to running as a service.
