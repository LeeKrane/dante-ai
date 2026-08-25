# jarvis-demo

Talk to Claude Code out loud. Hold a key, speak, release — your words go to Claude
Code running headless on your machine, and the reply comes back in a cloned voice
while an on-screen orb reacts to the audio.

Then ask it to **build** something. It spawns a second Claude Code session with
file tools, shows you the work happening, and tells you out loud when it's done.

```
Chrome mic → Web Speech API (free STT) → WebSocket → node server
  → claude -p            the conversation (tools off, fast)
  → claude -p            the build       (file tools on, its own folder)
  → Fish Audio TTS       the voice
  → canvas orb + build HUD
```

Two npm dependencies (`ws`, `@supabase/supabase-js`). No frameworks, no build
step, no Anthropic API key — it runs on the Claude subscription you already have.

## What you need

- **Chrome** — the speech-to-text is Chrome's built-in Web Speech API (free; needs
  internet — it runs through Google's servers)
- **Node 20+**
- **Claude Code**, installed and logged in
- **A Fish Audio API key** — the S2.1 API
- **A Supabase project** — the sign-in gate in front of the orb

Works on macOS and Linux. Windows: use WSL, or note your config path is
`C:\Users\you\.config\fish-audio\speak.json`.

## 1. Get a Fish Audio key

1. Sign up at [fish.audio](https://fish.audio)
2. Open the **API Keys** page (not the playground)
3. Generate a key and copy it

No playground or voice cloning needed — the voice ID below is a Fish Audio library
voice. Swap in any other library voice ID later if you want a different sound.

## 2. Create the config

Paste this whole block into a terminal, then put your key in:

```bash
mkdir -p ~/.config/fish-audio && cat > ~/.config/fish-audio/speak.json <<'EOF'
{
  "apiKey": "YOUR-FISH-KEY-HERE",
  "voiceId": "e13fa398a7f445a685316a3de6089ce7",
  "model": "s2.1-pro-free",
  "format": "mp3",
  "speed": 1.1
}
EOF
```

## 2b. Point it at a Supabase project

The orb is behind a sign-in. Create a project at
[supabase.com](https://supabase.com), then copy the **Project URL** and the
**anon / public** key out of *Project Settings → API*:

```bash
mkdir -p ~/.config/jarvis && cat > ~/.config/jarvis/supabase.json <<'EOF'
{
  "url": "https://YOUR-PROJECT.supabase.co",
  "anonKey": "YOUR-ANON-KEY-HERE"
}
EOF
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` in the environment work too, and win over
the file.

**There is no sign-up page, on purpose.** Create the one account you want by
hand: *Authentication → Users → Add user*, with **Auto Confirm User** ticked.
Anyone who can sign in can spawn a Claude Code session with file tools on, so
this is a list you should be able to read in one glance.

Two things worth knowing about the gate:

- The Supabase SDK runs **server-side only**. The browser never receives the anon
  key or the access token — signing in sets an `HttpOnly` cookie, which is also
  why no script on this origin (a build's own page included) can read the
  session.
- The server speaks plain HTTP, so the cookie is not marked `Secure` by default;
  a `Secure` cookie is simply never sent over `http://` and the login would
  appear to succeed and then not hold. Once there is TLS in front of this, set
  `SECURE_COOKIE=1`.

## 3. Prove Claude works headless (30 seconds, saves you an hour)

```bash
claude -p "say hi"
```

If you get a reply, you're done here. If not, fix it now.

This isn't literally the command the server runs — every turn adds
`--output-format json`, a `--settings` file, a `--system-prompt`, a pinned model
and a tool list (all of it in `lib/brain.js`). But the server does shell out to
`claude -p`, so this one line checks the two things that actually break first:

- **`command not found`** → Claude Code isn't on your PATH in this shell
- **an auth/login error** → run `claude` once interactively and log in first

## 4. Run it

```bash
npm install
node server.js
```

Open **http://localhost:3210** in Chrome. Allow the microphone. Hold **Space** (or
the on-screen button), talk, release.

Try: *"What's the weather like on Mars?"* for a chat turn. Then try
*"Build me a landing page for a coffee shop called Ember."*

It will ask you a question, then start building. A build takes a few minutes; the
HUD around the orb shows it working. When it finishes it says so and opens the page.

What to expect: the first reply takes several seconds (it's creating the session).
A build costs real subscription usage and takes minutes, not seconds. Memory lasts
as long as the page — refresh and it starts a fresh conversation.

## 5. Make it yours

Two things are the whole personality:

- **`lib/brain.js` → the `VOICE` constant** — who it is, how it talks, how long its
  answers are. It ships as a "JARVIS" character written around the author's first
  name, and it calls you *sir*; rewrite it into whatever you want your assistant to
  be. `VOICE` is the only half of the system prompt you write by hand — the list of
  things it can build is generated from `primitives/` underneath it, so rewriting
  the voice never breaks the builds.
- **`~/.config/fish-audio/speak.json`** — any Fish library voice ID, any speed.

## Hotkeys

| Key | Does |
|---|---|
| **Space** (hold) | push-to-talk — the page must have focus |
| **d** | diagnostics panel (the live pipeline readout; off by default) |
| **t** | the caption line |
| **h** | the rest of the interface — status, mic button, progress list, build HUD, artifact link |

All three toggles are ignored while Space is held, so a stray key mid-sentence
can't blank the screen. If part of the UI "disappears," you toggled it — press the
key again.

## When something breaks

| Symptom | Cause → fix |
|---|---|
| `spawn claude ENOENT` in the server log | node can't see `claude` on its PATH → start the server from a shell where `which claude` works |
| `claude exited 1: …auth…` | never logged in → run `claude` interactively once (step 3 catches this) |
| An error naming the model | your plan or CLI version doesn't have the pinned model → in `lib/brain.js`, change the `MODEL` constant from `["--model", "claude-haiku-4-5-20251001"]` to `["--model", "haiku"]` |
| `Cannot read Fish config at …` on startup | no speak.json → redo step 2 |
| `Fish TTS 402` / `403` | out of credits, or your key's tier doesn't cover the `model` in speak.json → add credits or switch the model |
| No transcript AND no mic prompt (macOS) | Chrome lacks *system* mic permission → System Settings → Privacy & Security → Microphone → enable Chrome |
| `stt error: network` in the diagnostics panel (**d**) | Web Speech needs internet (Google's servers) → get back online |
| Mic was blocked once, never asks again | Chrome remembered the block → lock icon in the address bar → allow Microphone → reload |
| Repeated `claude exited 1` after heavy use | subscription rate limit → wait it out |
| `EADDRINUSE` / port 3210 busy | an old server is still running → kill it first |
| "The build ran out of time before it finished." | it hit the primitive's `timeoutMs` → raise it in `primitives/<id>.mjs` (landing-page allows ten minutes) or ask for something smaller |
| "The build finished but never wrote index.html" | the model stopped without producing the file named by that primitive's `outputContract` → read the log, then ask again |
| Any build failure, in detail | every build keeps its raw stream at `builds/<timestamp>/build.log`, and the on-screen error line prints the full path |

## How it's put together

- `server.js` — static files + WebSocket. Serves finished builds from `builds/`,
  and binds to 127.0.0.1 only: this process runs a model with file tools on, which
  is not something to put on your local network.
- `lib/brain.js` — **the seam.** `ask(text, sessionId) → {reply, action?}`. Runs the
  conversation with tools OFF. When you ask for something it can build, it appends a
  machine tag that the server parses out before anything is spoken.
- `lib/registry.js` + `primitives/` — **what it can build.** One file per kind of
  build. This is the extension point (see below).
- `lib/builder.js` — spawns the real build with file tools ON in a fresh
  `builds/<timestamp>/`, streams progress, enforces a timeout.
- `lib/action.js`, `lib/outcome.js`, `lib/progress.js` — tag parsing, success
  detection, and turning raw build output into readable lines.
- `lib/auth.js` + `public/login.html` — **the gate.** Supabase sign-in, an
  `HttpOnly` session cookie, and the check at the WebSocket upgrade. The login
  page is a decoration on top of that check, not the check itself: what accepting
  the socket grants is a Claude Code session with file tools on, so refusing it
  has to happen where a refusal is a destroyed socket rather than a hidden
  button.
- `claude-settings.json` — small and load-bearing. The chat turn is passed this
  file directly; a build gets a throwaway copy with per-machine path deny rules
  merged on (see *What a build is allowed to do*), so edit this file to change
  both, but don't expect it to be the exact file a build runs under. It turns
  hooks off, so a speak-hook you installed in your own Claude Code setup doesn't
  narrate over the assistant (hooks fire inside the spawned build too), and it
  turns extended thinking off. Because
  thinking is off here, the build also pins its own effort level rather than
  inheriting yours — the two settings conflict, and inheriting a maximum-effort
  config would fail every build.
- `public/build-hud.js` — the readout that runs during a build.

Tests: `npm test` (pure logic only — no network, no keys needed).

### What a build is allowed to do

A build gets its own fresh `builds/<timestamp>/` as its working directory and the
tools its primitive asked for — `Write`, `Edit`, `Read` for the landing page. It
runs unattended (`--permission-mode acceptEdits`), so nothing stops to ask you to
approve a file write.

Two deny layers keep it in its lane, and it's worth knowing both, because neither
is a container:

**Tools.** `lib/builder.js` passes `--disallowedTools` for everything that could
reach past the build's own folder — `Bash`, `BashOutput`, `KillShell`, `Task`,
`WebFetch`, `WebSearch` — unless the primitive explicitly asked for it. That
genuinely removes them from the session.

**Paths.** Removing `Bash` isn't enough on its own: `Write` and `Edit` accept
absolute paths, so a build that was only told "write a file" can still write
*anywhere you can*. So `lib/builder.js` also generates a throwaway settings file
per build — the shipped `claude-settings.json` with a `permissions.deny` list
merged on — naming the places a build must never touch: `~/.claude/**` and
`~/.claude.json` (hooks and MCP definitions are code that runs on your next
session), shell rc files, `~/.gitconfig`, `~/.ssh`, `~/.gnupg`, `~/.aws`,
`~/.config`, the dirs on your PATH, launch agents, `/etc`, `**/.git/hooks/**`,
and this app's own source. A denied write comes back as
`File is in a directory that is denied by your permission settings.`

It is still **permission scoping, not a sandbox**, and a deny list is a blocklist:
it names what's known to be dangerous rather than allowing only what's known to be
safe. A build is real code execution on your machine, under your Claude login,
spending your subscription. Treat it that way: read a primitive before you install
it, and be deliberate about any tool you add to one. If you want a hard boundary,
run the whole thing in a VM or a container.

---

# This is a demo. Here's what to build on top of it.

The architecture is deliberately small, and these three extensions are where it
wants to grow. Each one bolts onto a seam that already exists.

## 1. Add your own primitive (start here)

A **primitive** is one file describing a kind of build: the instructions, the tool
scope, the questions to ask, and how to tell it worked. The registry auto-loads
every `primitives/*.mjs`, so adding one is a single file and zero wiring.

```bash
cp primitives/_template.mjs primitives/readme-writer.mjs
```

Fill in the fields (they're all commented), restart the server, and the assistant
knows about it — including which spoken requests should trigger it, because the
persona is generated from the registry rather than hand-written.

Ideas that fit the existing shape: a README generator, a SQL schema from a
description, a slide outline, a test suite for a file you name, a one-page resume.

**Important:** `allowedTools` is not a sandbox. Claude Code will still use a tool
you leave off the list — only `--disallowedTools` actually removes one, which is
why `lib/builder.js` applies a deny floor (`Bash`, `WebFetch`, `Task`, …) rather
than trusting the allowlist. If you grant a build more power, do it deliberately.

## 2. Add a memory layer

Right now every conversation starts blank and every build is an orphan. The seam
is `ask(text, sessionId)` in `lib/brain.js` — it already threads a session id, so
the model remembers within a page load and forgets on refresh.

To make it remember across sessions, put a store behind that seam: persist the
session id and a short summary per project, load it on connect, and pass prior
context into the persona. The natural store is a single JSON file or SQLite; the
natural key is the working directory.

What it unlocks: "what did we build yesterday?", preferences that stick ("you
always want dark palettes"), and builds that can reference earlier artifacts
instead of starting from nothing.

## 3. Multi-step orchestration

Today one request spawns one build. The interesting version decomposes: a
primitive that plans, then spawns several sub-builds, then verifies.

The place to grow it is `lib/builder.js`. `run()` already returns a structured
outcome (`ok`, `artifact`, `result`, `log`), which is exactly what a loop needs to
decide whether to continue. A `steps: [...]` field on a primitive, run in sequence
with the previous artifact passed forward, gets you plan → build → verify without
touching the conversation layer at all.

Harder and more interesting: let a build spawn its own sub-builds, and stream a
tree of progress instead of a flat list. The HUD already distinguishes ambient
activity from reported events, so it has somewhere to put the structure.

## License

MIT
