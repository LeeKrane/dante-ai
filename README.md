# dante-demo

Talk to Claude Code out loud. Hold a key, speak, release — your words go to Claude
Code running headless on your machine, and the reply comes back in a cloned voice
while an on-screen orb reacts to the audio.

It remembers across sessions, it can **build** things in its own throwaway folder,
and it knows which Claude Code sessions are running on the machine right now.

```
Chrome mic → Web Speech API (free STT) → WebSocket → node server
  → claude -p              the conversation (tools off, warm, ~800 ms)
  → claude -p              a build          (file tools on, its own folder)
  → claude agents --json   what else is running
  → Fish Audio TTS         the voice
  → canvas orb + build HUD
```

Two npm dependencies (`ws`, `@supabase/supabase-js`). No frameworks, no build
step, no Anthropic API key — it runs on the Claude subscription you already have.

## What you need

- **Chrome** — the speech-to-text is Chrome's Web Speech API (free; runs through
  Google's servers, so it needs internet)
- **Node 20+**
- **Claude Code**, installed and logged in
- **A Fish Audio API key** — the S2.1 API
- **A Supabase project** — the sign-in gate in front of the orb

macOS and Linux. On Windows use WSL.

## Setup

**1. Fish Audio.** Sign up at [fish.audio](https://fish.audio), open the **API
Keys** page, generate a key. The voice ID below is a library voice — swap in any
other one later.

```bash
mkdir -p ~/.config/fish-audio && cat > ~/.config/fish-audio/speak.json <<'EOF'
{
  "apiKey": "YOUR-FISH-KEY-HERE",
  "voiceId": "e13fa398a7f445a685316a3de6089ce7",
  "model": "s2.1-pro-free",
  "format": "mp3",
  "speed": 1.1,
  "volume": 5.0
}
EOF
```

**2. Supabase.** Create a project at [supabase.com](https://supabase.com), then
copy the **Project URL** and the **anon / public** key from *Project Settings →
API*. `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the environment work too, and win
over the file.

```bash
mkdir -p ~/.config/dante && cat > ~/.config/dante/supabase.json <<'EOF'
{
  "url": "https://YOUR-PROJECT.supabase.co",
  "anonKey": "YOUR-ANON-KEY-HERE"
}
EOF
```

**There is no sign-up page, on purpose.** Create the one account you want by hand:
*Authentication → Users → Add user*, with **Auto Confirm User** ticked. Anyone who
can sign in can spawn a Claude Code session with file tools on.

**3. Check Claude works headless** — thirty seconds, saves an hour:

```bash
claude -p "say hi"
```

`command not found` means Claude Code isn't on this shell's PATH. An auth error
means you have never logged in — run `claude` once interactively.

**4. Run it.**

```bash
npm install
node server.js
```

Open **http://localhost:3210** in Chrome, allow the microphone, hold **Space** (or
the on-screen button), talk, release.

## What it does

**Conversation.** One warm `claude -p` per server lifetime, tools off, Haiku —
about 800 ms a turn. Interrupt yourself and the sentences merge rather than
queue; the answer to a superseded turn is never spoken. Audio streams as it
arrives, so the first sound lands well before the sentence is finished.

**Volume.** A speaker button to the left of the record button reveals a
vertical fader on hover (or a tap, on touch) that raises or lowers how loud
replies play on this browser, remembered per browser (`localStorage`) rather
than per server. The label reads 0–200%, with 100% the clip exactly as Fish
sent it; the actual `GainNode` ceiling behind that "200%" is a 4x boost, not
2x — the label names what "as loud as this goes" means rather than the raw
multiplier, so it can be raised for more headroom later without the number on
screen changing what it promises. Separate from the `volume` set in
`speak.json` — that one asks Fish to synthesize a louder clip once for
everyone; this one is local, and it is the only way to go louder than the clip
Fish actually sent.

**Memory** — `~/.config/dante/memory.json`, keyed by the directory the server was
started in. It keeps the resumable session id, a rolling summary written when you
close the page, the last ten artifacts, and standing preferences: say *"I always
want dark palettes"* and the model appends a `[MEMORY:SET palette=dark]` tag that
is stripped before anything is spoken. Everything read back into a prompt is
capped and sanitized — the store is treated as an injection surface.

**Builds.** *"Build me a landing page for a coffee shop called Ember."* It asks a
question or two, then spawns a second Claude Code session with file tools on in a
fresh `builds/<timestamp>/`, streams the work into the HUD around the orb, and
opens the page when it's done. One build at a time; a primitive can declare
`steps: [...]` to run plan → build → verify as a chain in one directory.

**Sessions.** The point of the thing. Every turn carries a line describing the
Claude Code sessions running on this machine — from `claude agents --json`, so
it sees the ones you started in a terminal too — and you can drive them:

- *"What's running?"* — the roster, spoken. Never a uuid, a pid or a path.
- *"Start a session in jarvis to fix the failing builder test"* — spawns
  `claude --bg` in that repo and names it `jarvis-3-fix-failing-builder-test`.
  Five at a time, counted from the roster so terminal sessions count too.
- *"Tell jarvis three to run the tests as well"* — resumes it and speaks the
  answer back. If it's busy the message is **queued** and delivered the moment
  it goes idle, because resuming a working session forks it rather than joining.
- *"Stop jarvis three"* — SIGTERM, never SIGKILL, and confirmed gone before it
  says so.

Repositories get spoken aliases: *"the fitness repo is at
~/development/KraneticFitness"* stores one, and sessions in it are then
`fitness-1`, `fitness-2`. That list is also the **whitelist**: Dante only sees
sessions running inside a repository you named out loud, so another tool's
background sessions — and Dante's own brain and builders — never appear, and
cannot be named, told anything, or stopped.

**It proposes; you decide.** Nothing above runs on the model's say-so. Every
session command and every build is spoken back as one sentence first, built from
the parsed tag rather than from what the model said around it, so what you hear
is what will run:

> *"make me a README summary session"*
> — **"Start a session in jarvis to summarize the README. Shall I, sir?"**
> — *"yes"* → it starts. *"no"* → nothing runs. *"no, the whole repo"* → it
> re-proposes the corrected version.

A proposal expires after two minutes and is then not answerable at all. The
five-session ceiling counts only sessions Dante itself started — your terminals
and other tools' background jobs are not its business.

These sessions run under **your** settings, permissions, hooks and MCP servers —
the same session you'd have started by typing `claude` there. Dante imposes no
deny list, because you asked for an orchestrator and not a sandbox. What it will
never do is pass `--dangerously-skip-permissions` or `--permission-mode
bypassPermissions`, on any path: voice is a lossy channel, and a misheard
sentence must not be able to remove every guardrail.

`sessions/*.mjs` shapes a session the way `primitives/*.mjs` shapes a build —
prompt and model only, no tool scope. Ships `review` and `tests`; copy
`sessions/_template.mjs` to add one.

### It reports back

Start something, walk away, read what came of it on your phone. Slack is the
durable channel; voice only works when the page is open.

One thread per session: a parent when it starts, replies for everything after.
Each report carries a one-sentence summary generated from the session's own
transcript, because "done" on its own is not news.

```bash
mkdir -p ~/.config/dante && cat > ~/.config/dante/slack.json <<'EOF'
{
  "botToken": "xoxb-YOUR-BOT-TOKEN",
  "channel": "C0123456789"
}
EOF
```

A Slack app with the `chat:write` scope, invited to that channel.
`DANTE_SLACK_TOKEN` and `DANTE_SLACK_CHANNEL` work too and win over the file.
Skip this entirely and everything else still works — Slack is an enhancement,
not a dependency, and an outage costs a notification rather than a turn. It is
**outbound only**: no Socket Mode, no Events API, nothing anyone types in Slack
reaches this machine.

The roster poller notices a session ending within five seconds on its own. For
the fast path — and for a session *blocked on you*, which polling can never see
— install the hook. **Dante never writes `~/.claude/` itself**; its own build
deny list forbids exactly that, and a hook is code that runs on your next
session, so paste it yourself:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/TO/jarvis/hooks/dante-notify.mjs" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/TO/jarvis/hooks/dante-notify.mjs" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/TO/jarvis/hooks/dante-notify.mjs" }] }]
  }
}
```

It posts to `127.0.0.1:3210/hook` (`DANTE_PORT` to change it), always exits 0,
prints nothing and gives up after a second — a Dante that is down must cost a
session nothing. Both mechanisms report the same exit; Dante dedupes so the
thread gets one line, not three.

### It asks before the two things worth asking about

Sessions run under your permissions, so one that hits a permission prompt with
nobody at the terminal just stops. A `PreToolUse` hook can block and return a
decision, so Dante asks you out loud instead and you answer from across the
room.

> *"jarvis-1-builder-test-fix wants to push to the remote, sir. Allow?"*
> — *"go ahead"* — *"Allowed, sir."*

**Scoped to two things**: a file write outside the session's own repository, and
a command that publishes (`git push`, `gh pr create`, `gh release create`,
`npm publish`). Everything else falls through to what your terminal would have
done. That is the smallest set with the highest consequence, which is the right
trade for a channel that interrupts you.

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

**No browser open, or no clear answer, means no decision** — never a denial. The
session falls back to its normal behaviour and Slack gets a "waiting on you".
Denying by silence would break every session started while you are away, which
is exactly when you need them working. The answer is read by a strict word list
and **never goes through the model**: routing it through one would let a
prompt-injected tool description argue for its own approval.

`docs/roadmap.md` is where this goes next.

## Make it yours

- **`lib/brain.js` → the `VOICE` constant** — who it is and how it talks. It ships
  as a "DANTE" character and calls you *sir*. It is the only half of the system
  prompt written by hand; what it can build is generated from `primitives/`
  underneath, so rewriting the voice never breaks the builds.
- **`~/.config/fish-audio/speak.json`** — any Fish library voice, any speed, and
  `volume` (-20 to 20, omit for Fish's default).
- **`server.js` → `WG_IP`** — the one non-loopback address allowed to reach the
  server. Set it to your VPN address, or drop it to stay local-only.

### Add a primitive

A **primitive** is one file describing a kind of build: the instructions, the tool
scope, the questions to ask, and how to tell it worked. The registry auto-loads
every `primitives/*.mjs`, so it is one file and zero wiring — the persona's list
of things it can build is generated from the folder.

```bash
cp primitives/_template.mjs primitives/readme-writer.mjs
```

Fill in the commented fields and restart. `allowedTools` is **not** a sandbox:
Claude Code will still use a tool you leave off the list, which is why
`lib/builder.js` applies a deny floor rather than trusting an allowlist.

## Hotkeys

| Key | Does |
|---|---|
| **Space** (hold) | push-to-talk — the page must have focus |
| **d** | diagnostics panel (live pipeline readout; off by default) |
| **t** | the caption line |
| **h** | the rest of the interface |

Toggles are ignored while Space is held, so a stray key mid-sentence can't blank
the screen. If part of the UI "disappeared," press the key again.

## How it's put together

| | |
|---|---|
| `server.js` | static files, WebSocket, dispatch. Wiring only — logic lives in `lib/`. |
| `lib/brain.js` | **the seam.** The warm CLI, the persona, `ask` / `askResilient`. |
| `lib/agents.js` | the session roster: `claude agents --json`, parsed and said out loud. |
| `lib/memory.js` | the store — preferences, summaries, artifacts, workspace aliases. |
| `lib/turns.js` | what one call carries: merged interruptions, the roster, the turn gate. |
| `lib/registry.js` + `primitives/` | what it can build. |
| `lib/sessions.js` + `sessions/` | what kinds of session it can start. |
| `lib/spawn-session.js` | starting, telling and stopping a real session. |
| `lib/builder.js` | spawns the build with file tools on, streams progress, enforces a timeout. |
| `lib/auth.js` + `public/login.html` | the Supabase gate. |
| `lib/action.js`, `outcome.js`, `progress.js`, `tts.js`, `config.js` | tags, success detection, readable progress, speech, config. |
| `claude-settings.json` | small and load-bearing — hooks off, thinking off. A build gets a throwaway copy with path deny rules merged on. |

`npm test` — `node --test`, no network and no keys needed.

## Security

**`POST /hook` and `POST /approve` are loopback only.** That is its entire security model, and it does
not change because the rest of the server is reachable over the VPN. Any local
process can post to it, so nothing a payload carries ever reaches a model
prompt — it reaches the event formatter and Slack, capped and stripped, or it is
dropped in silence.

**The Slack bot token is a credential.** It rides in one Authorization header and
appears in no log line, no debug message, and nothing crossing the WebSocket.
Message text is escaped for the three characters that open Slack's control
sequences, so a summary a model wrote saying `<!channel>` cannot notify a
workspace.

**An approval answer never reaches a model.** `parseYesNo` is a strict
vocabulary, and an unclear answer re-asks once and then decides nothing. No
voice phrase anywhere can pass `--dangerously-skip-permissions` or
`--permission-mode bypassPermissions`.

**A session transcript is untrusted input.** It holds whatever the session read
off disk or off the web, which makes it the most attacker-reachable text here. It
is framed to the summarizer as data rather than instructions, and the result is
capped and stripped either way — framing is a mitigation, never the boundary.

**The gate.** The check that matters is at the WebSocket upgrade, not on the login
page: a UI-only gate is skipped by opening the socket directly. `builds/` is gated
alongside the orb, so pages the model wrote are not readable by anyone who can
reach the port. The Supabase SDK is server-side only — the browser never receives
the anon key or the token, only an `HttpOnly` cookie. The server speaks plain
HTTP, so that cookie is not `Secure` by default; put TLS in front of it and set
`SECURE_COOKIE=1`.

**The network.** The server binds `0.0.0.0` but only serves requests whose `Host`
is localhost or the single VPN address in `WG_IP`, and only accepts sockets from
the matching origins. That is the whole boundary — set `WG_IP` deliberately.

**What a build may do.** A build runs unattended (`--permission-mode acceptEdits`)
in its own `builds/<timestamp>/` with the tools its primitive asked for. Two deny
layers keep it there, and neither is a container:

- **Tools** — `--disallowedTools` removes everything that reaches past the folder
  (`Bash`, `Task`, `WebFetch`, `WebSearch`, …) unless the primitive asked for it.
  Only `--disallowedTools` actually removes a tool.
- **Paths** — removing `Bash` is not enough, because `Write` and `Edit` take
  absolute paths. Each build gets a generated settings file denying `~/.claude/**`
  and `~/.claude.json` (hooks and MCP definitions are code that runs on your next
  session), shell rc files, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`, the dirs
  on your PATH, `/etc`, `**/.git/hooks/**`, and this app's own source.

This is permission scoping, not a sandbox, and a deny list names what is known to
be dangerous rather than allowing only what is known to be safe. A build is real
code execution on your machine, under your Claude login. Read a primitive before
you install it. If you want a hard boundary, run the whole thing in a VM.

## When something breaks

| Symptom | Cause → fix |
|---|---|
| `spawn claude ENOENT` | node can't see `claude` → start the server from a shell where `which claude` works |
| `claude exited 1: …auth…` | never logged in → run `claude` interactively once |
| An error naming the model | your plan or CLI doesn't have the pinned model → in `lib/brain.js` change `MODEL` to `["--model", "haiku"]` |
| `Cannot read Fish config at …` | no speak.json → redo setup step 1 |
| `Fish TTS 402` / `403` | out of credits, or your key's tier doesn't cover the `model` in speak.json |
| `stt error: network` (press **d**) | Web Speech needs internet |
| No mic prompt on macOS | Chrome lacks *system* mic permission → System Settings → Privacy & Security → Microphone |
| Mic blocked once, never asks again | lock icon in the address bar → allow Microphone → reload |
| `EADDRINUSE` | an old server is still running → kill it, or `PORT=3211 node server.js` |
| "The build ran out of time" | it hit the primitive's `timeoutMs` → raise it, or ask for something smaller |
| "The build finished but never wrote index.html" | the model stopped without producing the primitive's `outputContract` → read the log |
| Any build failure, in detail | `builds/<timestamp>/build.log` — the on-screen error prints the full path |

## License

MIT
