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
  "volume": 5.0,
  "pitch": 0
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
arrives, so the first sound lands well before the sentence is finished. What is
on screen can be selected and copied — the reply, the build log and the
diagnostics panel — while a drag that starts on the orb or the record button
still does nothing, which is what the page-wide `user-select: none` used to be
buying at the cost of the text.

**Volume.** A speaker button to the left of the record button reveals a
vertical fader on hover (or a tap, on touch) that raises or lowers how loud
replies play on this browser, remembered per browser (`localStorage`) rather
than per server. Clicking the button mutes, and clicking again comes back to
the level it was at rather than to 100% — muting remembers what it interrupted.
On a phone, with no hover to open the fader ahead of the tap, tapping the
speaker instead opens and closes the fader; click-to-mute stays a desktop
affordance, and sliding to 0 is how a phone mutes. There is no separate mute
flag: muted simply *is* a volume of zero, which is
why dragging the fader to the bottom shows the muted icon too, and why the
icon, the fader and what you actually hear can never disagree. The label reads 0–200%, with 100% the clip exactly as Fish
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
capped and sanitized — the store is treated as an injection surface. The same
file also names your repositories (`workspace:<name>=<path>`) and which one is
**main** (`main=<name>`) — the repository a session starts in when you don't
name one; the panel lists it first, starred, and clicking any other
repository's header there makes it the new main.

**Builds.** *"Build me a landing page for a coffee shop called Ember."* It asks a
question or two, then spawns a second Claude Code session with file tools on in a
fresh `builds/<timestamp>/`, streams the work into the HUD around the orb, and
opens the page when it's done. One build at a time; a primitive can declare
`steps: [...]` to run plan → build → verify as a chain in one directory.

Not every primitive produces a page. *"What does this repo do?"* runs
`ask-repo` — `Read`, `Grep` and `Glob` only, no `Write` or `Edit` on its list —
and answers the question in prose instead of building anything.

**Sessions.** The point of the thing. Every turn carries a line describing the
Claude Code sessions running on this machine — from `claude agents --json`, so
it sees the ones you started in a terminal too — and you can drive them:

- *"What's running?"* — the roster, spoken. Never a uuid, a pid or a path.
- The panel numbers every row 1..N, main repository first, oldest session
  first within each repository — the same order and the same numbers the
  model is told. *"Stop session three"* addresses a session by that number
  instead of its name; a number is only ever resolved against the current
  list, and a number said about one that has since stopped is refused rather
  than guessed at.
- *"Start a session in jarvis to fix the failing builder test"* — spawns
  `claude --bg` in that repo and names it `fix-failing-builder-test`, off the
  task alone — no repository or counter baked into the name, since the panel
  already numbers it. Fifteen at a time, counted from the roster so terminal
  sessions count too. Naming no repository at all starts it in your **main**
  repository instead — the one you last named as such, or whichever was
  current when the server first ran with none set.
- *"Tell session three to run the tests as well"* — the message goes into
  that session's own input queue, exactly where a line you typed into its
  terminal would go, and it is picked up when the work in flight finishes.
  (Naming it instead — *"tell fix-failing-builder-test..."* — still works too.)
- *"Interrupt session three and have it use the other branch"* — same
  channel, but it cuts in front of the work in flight. The session drops what
  it was doing, takes the new instruction, and carries on. It is **not** a
  stop: same process, same transcript, same session id.
- *"Stop session three"* — SIGTERM, never SIGKILL, and confirmed gone before
  it says so.
- *"Start a session in jarvis to fix the tests, then run the linter"* — records a
  successor and starts it the moment the first session **finishes**, not when it
  succeeds: a Claude Code session exposes no pass/fail verdict, so there is
  nothing to condition on. A session you stop by voice drops its chain rather
  than starting it. A chained session counts against the fifteen-session cap
  like any other.
- *"What did session three come up with?"* — reads that session's transcript
  and speaks the answer. Works on a session still working (*"it's still
  working, sir. So far…"*) and on one that has finished — though a finished
  session has fallen off the panel and lost its number by then, so it has to
  be named instead — and takes a real question: *"did its tests pass?"*,
  *"which files did it touch?"*

Reading is the one command that is **not** proposed first. The other three
reach a live process, so a misheard sentence must not be able to move one;
reading touches nothing, and putting a *"Shall I, sir?"* in front of every
question about your own work would be a spoken round trip for nothing.

**It reads the session, not a copy of it.** The source is the transcript Claude
Code itself keeps — the same thing you would see by opening that session in a
terminal and scrolling back. Nothing is summarized ahead of time and nothing is
cached: delete a session and it stops being readable that instant, with nothing
left behind to answer in its place. The one-line summary posted to Slack when a
session ends is kept only in the short recap log — cleared the first time you
ask what you missed — and reading a session never consults it.

The difference between *tell* and *interrupt* is timing and nothing else, and
when it isn't clear which you meant, it picks *tell*. Neither one forks the
session or waits for it to go idle — both used to, and the machinery that did
is still there as the fallback for a Claude Code that doesn't offer the
channel. What Dante can promise either way is that the session **has** the
message, never that it has acted on it: nothing acknowledges a delivered line,
so "has it" is the strongest thing it will say.

Repositories get spoken aliases: *"the fitness repo is at
~/development/KraneticFitness"* stores one, and every session started there
appears in the panel under it. That list is also the **whitelist**: Dante
only sees sessions running inside a repository you named out loud, so
another tool's background sessions — and Dante's own brain and builders —
never appear, and cannot be named, told anything, or stopped.

**It proposes; you decide.** Nothing above runs on the model's say-so. Every
session command and every build is spoken back as one sentence first, built from
the parsed tag rather than from what the model said around it, so what you hear
is what will run:

> *"make me a README summary session"*
> — **"Start a session in jarvis to summarize the README. Shall I, sir?"**
> — *"yes"* → it starts. *"no"* → nothing runs. *"no, the whole repo"* → it
> re-proposes the corrected version.

A session command naming something Dante cannot see is refused **before** it
is proposed, rather than after you have said yes to it — and the proposal
names the session the way it appears on the roster, not necessarily the way
you said it. A command missing a detail — a *tell* with nothing to say, a
*stop* with nothing to stop — is asked about rather than run: nothing in
start, tell, interrupt or stop ever runs unconfirmed.

A proposal expires after two minutes and is then not answerable at all. The
fifteen-session ceiling counts only sessions Dante itself started — your
terminals and other tools' background jobs are not its business.

**It asks first.** A one-line spoken request is rarely a brief a session can work from. When a start — or a tell or interrupt — is missing what a good brief needs (the goal, where, what must not be touched, what done looks like), Dante interviews you, **one question per turn**, most important first, until it is confident it has all four ([docs/interview.md](docs/interview.md)) or you say to stop asking or to just start it. When it is confident it proposes as usual, but the spoken sentence is a summary while the **full brief is shown centred over the orb** — above the other panels, never over the hold-to-talk button — and is what the session actually receives — a structured document (Goal / Where / Constraints / Done when) that loses nothing you said. A request that is already specific gets no interview. Below the state label, a line shows what Dante is doing right now (*interviewing*, *awaiting your yes*, *starting jarvis*, *telling fix-tests*, *reading readme-summary*, *building landing page*), and goes blank when nothing is.

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

*"Catch me up"* is the voice half of walking away. It comes back as one spoken
paragraph rather than a list — anything still needing you leads, and is never
crowded out. It's built from an event log that survives a server restart, so
it can still tell you what happened even if you closed the lid in between.
Speaking it clears the log and any queued announcements, so nothing gets said
twice.

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

> *"fix-failing-builder-test wants to push to the remote, sir. Allow?"*
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
- **`~/.config/fish-audio/speak.json`** — any Fish library voice, any speed,
  `volume` (-20 to 20, omit for Fish's default), and `pitch` (-12 to 12
  semitones, 0 for the voice as Fish recorded it). Pitch is the odd one out:
  Fish's API has no pitch parameter at all, so the server forwards the number to
  the browser and the clip is resampled there. Resampling moves tempo with
  pitch — a deeper voice also reads slower, a higher one faster. That is the
  trade-off, not a bug; there is no way to shift the pitch of a clip that was
  already synthesized at a fixed rate without it.
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
| **s** | sessions panel (grouped by repository, main starred first; what is running, where, for how long; on by default) |
| **t** | the caption line |
| **h** | the rest of the interface |

Toggles are ignored while Space is held, so a stray key mid-sentence can't blank
the screen. If part of the UI "disappeared," press the key again. All four are
also on screen as switches under the controls, lit while on -- on a phone,
where there are no keys, tapping those is how the panels are toggled.

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
| `lib/peer.js` | writing a line into a session that is already running — the interrupt. |
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

**The interrupt channel is undocumented, and reads a credential.** Claude Code
keeps a unix socket per live session — `messagingSocketPath` in
`~/.claude/sessions/<pid>.json` — and authenticates writes to it with a token
from the matching `<pid>.<hash>.key`. That is how one session messages another,
and it is the only way to reach a session that is already running rather than
around it. None of it is a published interface: it was established empirically
against CLI 2.1.246 and a future version may change or withdraw it, which is
why every failure falls back to the old resume-and-queue path rather than
breaking the verb.

Three things follow, and all three are in `lib/peer.js`. The socket path is
**vetted, not trusted** — it is read out of a file this process does not own,
and an unvetted path would point the write at any socket on the machine, so
only the CLI's own naming shape (`cc-socks/<pid>.sock`) is accepted. The
roster's pid and the state file's session id must **agree** before anything is
written, because pids are recycled and the cost of being wrong is a stranger's
session taking dictation. And the peer token is a **credential**: it takes the
posture the Slack bot token takes — never logged, never across the WebSocket,
never in an error string, and never in a prompt.

Dante still writes nothing under `~/.claude/`. It reads two files there that
describe sessions it can already see in the roster, and that roster is already
narrowed to the repositories you named out loud.

**A session transcript is untrusted input.** It holds whatever the session read
off disk or off the web, which makes it the most attacker-reachable text here. It
is framed to the summarizer as data rather than instructions, and the result is
capped and stripped either way — framing is a mitigation, never the boundary.
Reading one back out loud is the same text through the same framing, with the
question repeated *after* the transcript as well as before it, so the last thing
in the prompt is your request rather than four thousand characters of somebody
else's session. The reader is also told it may come up empty: a model asked
something its source cannot answer will answer anyway unless told not to, and a
confident wrong account of what a session did is worse than *"it does not say"*
precisely because you have not read it yourself.

**What can be read is bounded by the whitelist and by disk.** A transcript is
reachable only for a session inside a repository you named out loud, and only
while the file is there. The session id is checked against a strict alphabet
before it names a file, because it arrives from a roster listing and from
model-authored tags and neither is trusted to be a uuid.

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

**`ask-repo`'s read-only claim is carried by the prompt, not by either deny
layer.** `allowedTools` naming only `Read`, `Grep` and `Glob` is a request, not
a restriction — `Write` and `Edit` are not on the `--disallowedTools` floor for
any primitive, and `denyRules()` names credentials, shell startup files and
this app's own source, never the repository a build was pointed at. So "does
not write to the repo it reads" is enforced by the system prompt alone, which
is exactly the layer `lib/builder.js` is explicit is not the one that refuses.

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
