# jarvis-demo

Talk to Claude Code out loud. Hold a key, speak, release — your words go to
Claude Code running headless on your machine, and the reply is spoken back in a
cloned voice while an on-screen orb reacts to the audio.

The stack, end to end:

```
Chrome mic → Web Speech API (free STT) → WebSocket → node server
  → claude -p  (headless Claude Code — your existing subscription, NO API key)
  → Fish Audio TTS (cloned voice, mp3)
  → Web Audio playback + audio-reactive canvas orb
```

One npm dependency (`ws`). No frameworks, no build step, no Anthropic API key —
it runs on the Claude subscription you already have.

## What you need

- **Chrome** — the speech-to-text is Chrome's built-in Web Speech API (free;
  needs internet — it runs through Google's servers)
- **Node 20+**
- **Claude Code**, installed and logged in
- **A Fish Audio API key** — the S2.1 Pro API (free for developers through
  July 31, 2026; paid tier after)

Works on macOS and Linux. Windows: use WSL, or note your config path is
`C:\Users\you\.config\fish-audio\speak.json`.

## 1. Get a Fish Audio key

1. Sign up at [fish.audio](https://fish.audio)
2. Open the **API Keys** page (not the playground)
3. Generate a key and copy it

No playground or voice cloning needed — the voice ID below is a Fish Audio
library voice. Swap in any other library voice ID later if you want a
different sound.

## 2. Create the config

Paste this whole block into a terminal, then put your key in:

```bash
mkdir -p ~/.config/fish-audio && cat > ~/.config/fish-audio/speak.json <<'EOF'
{
  "apiKey": "YOUR-FISH-KEY-HERE",
  "voiceId": "e13fa398a7f445a685316a3de6089ce7",
  "model": "s2.1-pro-free",
  "format": "mp3",
  "speed": 1.1,
  "enabled": false
}
EOF
```

(`enabled` is only read by a companion speak-hook from an earlier part of this
series — the app itself ignores it.)

## 3. Prove Claude works headless (30 seconds, saves you an hour)

```bash
claude -p "say hi"
```

If you get a reply, you're done here. If not, fix it now — this exact command
is what the server runs on every turn:

- **`command not found`** → Claude Code isn't on your PATH in this shell
- **an auth/login error** → run `claude` once interactively and log in first

## 4. Run it

```bash
npm install
node server.js
```

Open **http://localhost:3210** in Chrome. Allow the microphone. Hold **Space**
(or the on-screen button), talk, release.

What to expect: the first reply takes several seconds (it's creating the
session). Later turns are faster. A hung turn times out after 30 seconds.
Memory lasts as long as the page — refresh and it starts a fresh conversation.

## 5. Make it yours

Two files are the whole personality:

- **`lib/brain.js` → `PERSONA`** — who it is, how it talks, how long its
  answers are. It ships with a "JARVIS" character keyed to the author's name;
  rewrite it into whatever you want your assistant to be.
- **`~/.config/fish-audio/speak.json`** — any Fish library voice ID, any speed.

## Hotkeys

| Key | Does |
|---|---|
| **Space** (hold) | push-to-talk — page must have focus |
| **d** | debug panel (the live pipeline readout) |
| **t** / **h** | caption / HUD visibility |

If part of the UI "disappears," you toggled it — press the key again.

## When something breaks

| Symptom | Cause → fix |
|---|---|
| `spawn claude ENOENT` in the server log | `claude` isn't on the PATH node sees → launch from a shell where `which claude` works |
| `claude exited 1: …auth…` | never logged in → run `claude` interactively once (step 3 catches this) |
| Error about the model name | your plan/version lacks the pinned model → in `lib/brain.js`, change `MODEL` to `--model haiku` |
| `Cannot read Fish config at …` on startup | no speak.json → redo step 2 |
| `Fish TTS 402/403` | the free window ended (after Jul 31, 2026) or credits out → switch `model` to the paid tier or add credits |
| No transcript AND no mic prompt (macOS) | Chrome lacks *system* mic permission → System Settings → Privacy & Security → Microphone → enable Chrome |
| `stt error: network` in the debug panel | Web Speech needs internet (Google servers) → get online |
| Mic was blocked once, never asks again | Chrome remembers → lock icon in the address bar → re-allow |
| Repeated `claude exited 1` after heavy use | subscription rate limit → wait it out |
| `EADDRINUSE` / port 3210 busy | an old server is still running → kill it first |

## How it's put together

- `server.js` — static file server + WebSocket. One message in (`say`), a few
  out (`state`, `reply_text`, `audio`, `debug`, `error`).
- `lib/brain.js` — **the seam.** One function: `ask(text, sessionId) →
  {reply, sessionId}`. Spawns `claude -p` with a JSON-output contract and
  session resume. Everything else in the app only talks to this function —
  swap this one file to change what the assistant *is*.
- `lib/tts.js` — Fish Audio HTTP TTS. Text in, mp3 buffer out.
- `lib/config.js` — reads `~/.config/fish-audio/speak.json`.
- `public/app.js` — mic capture (Web Speech), WebSocket client, Web Audio
  playback with an analyser driving the canvas orb.

Tests: `npm test` (pure logic only — no network, no keys needed).

## License

MIT
