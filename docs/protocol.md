# Wire protocol

This is the reference for talking to the Dante server from something other than
`public/app.js` — a second client, a test harness, or a debugger watching the
socket. Everything here was read off the code at the line numbers cited, not
recalled, so a mismatch means the code moved and this file did not; re-derive
from the cited line rather than trust the prose over it.

The control channel is one WebSocket, opened on the same port the HTTP server
listens on (`server.on("upgrade")`, `server.js:2059`). The upgrade is gated
twice before the socket is accepted: the `Origin` header must be a page this
server actually serves (`originAllowed`, `server.js:2048`), and the session
cookie must verify with Supabase (`auth.verify(sessionToken(req))`,
`server.js:2073`) — the same check `public/login.html` is a decoration on top
of, not a substitute for. One socket is one conversation: the server keeps a
single `conv` object per connection (`server.js:2101`) holding the pending
question, the build proposal, the interview state, and the turn count, and a
second tab is a second, independent conversation rather than a second view of
the first. Every frame in both directions is a single JSON object with a
`type` field naming what it is; there is no framing beyond "one WebSocket
message is one JSON value" (`ws.send(JSON.stringify(o))`, `server.js:2085`;
`JSON.parse(ev.data)`, `public/app.js:428`).

## Client → server frames

Sent by `public/app.js`, read by the `ws.on("message", ...)` handler at
`server.js:2122`.

| `type` | Fields | Sent when | Server does |
|---|---|---|---|
| `say` | `text: string` | The push-to-talk key is released and speech recognition produced a transcript (`public/app.js:820`). | Routed through a chain of "is this an answer to something already pending" checks — a live approval (`answerApproval`), a build proposal (`answerProposal`), a held read-back (`answerHeld`), then a build question (`conv.pending`) — before falling through to a new conversational turn (`server.js:2149`–`2173`). A new turn calls the brain (`askResilient`) and may reply, ask a follow-up, or dispatch a build. |
| `announce_ready` | `id: string` | The client's playback floor comes free (mic not held, nothing playing, no question outstanding) and it is willing to speak one of the announcements the server had queued (`public/app.js:759`). | Looks `id` up in the server's pending-announcement map and, if it hasn't expired, speaks it with `say()` (`speakAnnouncement`, `server.js:604`, dispatched at `server.js:2127`). An unknown or expired id is ignored in silence — the client is entitled to ask late. |
| `set_main` | `alias: string` | Someone clicks a repository header in the sessions panel to make it the default workspace (`public/app.js:596`). | `setMainRepo` on the memory store; on success it saves, re-broadcasts `workspaces` to every connected page, and renumbers the roster. Silently logged and dropped on an unknown alias (`server.js:2135`–`2144`). |

Any other `type`, or a `say` with no non-empty `text`, is dropped without a
reply (`server.js:2146`).

## Server → client frames

Every server-originated frame goes through the same `send = (o) => ws.send(...)`
closure per connection (`server.js:2085`); `voice` (`server.js:402`) points it
at whichever page connected most recently, so a question or an announcement
always reaches the newest tab.

| `type` | Fields | Meaning |
|---|---|---|
| `state` | `value: "idle" \| "thinking" \| "working" \| "speaking"` | The orb's state machine. The server only ever sends these four (`server.js:1214,1986,2188,2548` etc.); `"listening"` is a fifth value the *client* sets itself the moment the mic key goes down (`public/app.js:846`) and the server never needs to know about. |
| `activity` | `value: "interviewing" \| "proposing" \| "starting" \| "telling" \| "interrupting" \| "stopping" \| "reading" \| "building" \| null`, `subject?`, `brief?` | What Dante is doing right now, for the label under the orb. `null` clears it. `subject` names the session/repo/primitive involved; `brief` rides only with `"proposing"`, since the spoken line only summarizes it (`activity()`, `server.js:1254`). |
| `ask` | `text: string` | A build is missing one parameter and needs it before it can start. Sent alongside (not instead of) a spoken `say()` of the same question (`advance()`, `server.js:1892`–`1897`); the client's next `say` frame answers it. |
| `reply_text` | `text: string` | The caption for whatever `say()` is about to speak — sent before synthesis starts, so the caption appears even if TTS is slow (`server.js:1190`). |
| `debug` | `stage: string`, `msg: string`, `ms?: number` | Free-form diagnostics (`stt`, `brain`, `tts`, `ask`, `session`, `error` stages) shown in the on-page debug panel. Not meant to be parsed by a client; treat it as a log line (`server.js:1213` and others). |
| `audio_start` / `audio_chunk` / `audio_end` | see below | One spoken clip, framed as a header, zero or more chunks, and a trailer. |
| `progress` | `line: string` | One line of output from a running build, forwarded live from the build's own progress callback (`server.js:1929`). |
| `open` | `url: string` | A build finished successfully; `url` is the `/builds/...` path to the artifact it wrote, URL-encoded because a primitive's output filename may contain spaces (`server.js:1957`). |
| `error` | `message: string` | Something failed — a build (with the log path appended when there is one, `server.js:1985`) or an uncaught turn error (`server.js:2547`). The client also treats this as an implicit "go back to idle." |
| `announce` | `id: string`, `text: string` | A line nobody asked for — a session finished, a session needs attention — offered to the client rather than spoken immediately (`announce()`, `server.js:579`). The client queues it and replies with `announce_ready` once its floor is free (`playback-policy.js`, wired at `public/app.js:728`). |
| `clear_announcements` | *(no fields)* | A recap just spoke every queued announcement out loud in one paragraph; the client discards its own queue so nothing in it is repeated later (`clearPendingAnnouncements()`, `server.js:618`–`625`). |
| `roster` | `sessions: Array<{sessionId, name, alias, number, state, status, startedAt}>` | The Claude Code sessions Dante knows about right now, sent on connect and on every change (`sendRoster`, `server.js:524`). No filesystem path travels here on purpose — a repository is named out loud, never located on disk, for a browser (`server.js:493`–`495`). |
| `workspaces` | `list: Array<{alias, main}>` | The registered repositories and which one is the default, sent on connect and whenever a workspace or the main repo changes (`sendWorkspaces`, `server.js:539`). |

### Audio framing

TTS audio is Fish Audio's streamed mp3, relayed as it arrives rather than
buffered whole (`say()`, `server.js:1189`). `audio_start` carries `id`
(a per-clip sequence number, `server.js:1192`), `format` (currently always
`"mp3"`), `pitch`, and `nextState` — the state the orb should land in once
this clip finishes, used so a build confirmation can hand off to `"working"`
without racing playback (`server.js:1215`). Each `audio_chunk` carries the
same `id` and `data`, a base64-encoded slice of the mp3 byte stream
(`server.js:1223`; decoded client-side with `atob`, `public/app.js:1101`).
`audio_end` carries just `id` and closes the clip (`server.js:1230,1243`). A
chunk or end whose `id` does not match the clip currently being received is
dropped: the server commits to a clip the instant its first byte is sent, so a
superseded clip's tail keeps arriving after the replacing clip has already
started (`public/app.js:1097`–`1100`). The client feeds `mp3` chunks straight
into a `MediaSource`/`SourceBuffer` when the browser supports
`audio/mpeg` there, for genuinely progressive playback
(`public/app.js:1004`,`1034`); otherwise it buffers every chunk and decodes
the whole clip at `audio_end` with `decodeAudioData` (`playBuffered`,
`public/app.js:1117`).

## HTTP endpoints

`server.js:1004` is the one `http.createServer` handler for everything below;
every path also passes a `Host`-header check (`hostAllowed`, `server.js:958`)
before any routing, because 127.0.0.1 keeps other machines out but not other
DNS names pointed at it.

- **`POST /auth/login`** (`server.js:1082`) — body `{ email, password }`,
  forwarded to Supabase. `200 { ok: true }` with a `Set-Cookie` session cookie
  on success; `401 { error }` on failure. The email is never logged, so a bad
  attempt only tells you the *reason* it failed, not what was typed.
- **`POST /auth/logout`** (`server.js:1101`) — no body. Forgets the token
  server-side and clears the cookie. Always `200 { ok: true }`.
- **`POST /hook`** (`server.js:1023`) — the fast path for "something happened
  in a Claude Code session," posted by `hooks/dante-notify.mjs`. **Loopback
  only** (`isLoopback`, `lib/hooks.js:56`, checked against `req.socket
  .remoteAddress`): any local process can reach it, so nothing it carries is
  ever treated as an instruction — a payload only ever reaches the recap log
  and the spoken notifier, never a model prompt. Requires
  `Content-Type: application/json` and a declared `Content-Length` under
  4096 bytes (`MAX_BODY`, `server.js:980`). The response is sent immediately,
  `200 { ok: true }`, *before* the event is acted on — a hook blocks the
  session that spawned it, and a summary can take seconds to speak, so making
  that session wait on Dante would be backwards. The body itself is
  `{ hook_event_name, session_id, cwd, message?, reason? }`; unrecognized
  event names or an unsafe `session_id` are parsed to `null` and dropped in
  silence (`parseHookEvent`, `lib/hooks.js:67`).
- **`POST /approve`** (`server.js:1059`) — posted by `hooks/dante-approve.mjs`
  as a Claude Code `PreToolUse` hook, for exactly two things worth
  interrupting a session for: a file write outside its own repo, or a
  publishing git/gh/npm command (`inApprovalScope`, `lib/approval.js:61`).
  **Loopback only**, same reasoning as `/hook`. Unlike `/hook` this one
  **holds the response open** — a decision that arrives after the tool
  already ran is not a decision — until one of three things happens: the
  connected page hears "yes, sir" or "no, sir" spoken and parsed by the
  strict word list in `parseYesNo` (`lib/approval.js:120`, never routed
  through the model, so a prompt-injected tool description cannot argue for
  its own approval); nobody is listening or another approval is already in
  flight, in which case it resolves immediately; or the 60-second window
  (`APPROVAL_WINDOW_MS`, `server.js:397`) elapses. Body:
  `{ session_id, cwd, tool_name, tool_input: { file_path?, notebook_path?,
  command? } }`. Response is always `200`, with either `{}` — "no decision,
  fall through to whatever the terminal would have done" — or
  `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision:
  "allow" | "deny", permissionDecisionReason } }` (`buildDecision`,
  `lib/approval.js:146`). `{}` is never a denial; it is the answer to almost
  everything, including "away from the keyboard."
- **`/builds/...`** (`server.js:1125`) — static files a build wrote,
  served read-only. Gated by the *same* cookie check as every other page
  under `public/`, except `/login.html` itself (`PUBLIC_PATHS`,
  `server.js:971`): gating the orb but leaving `builds/` open would make
  every page a model ever wrote readable by anyone who can reach the port.
  Served with `Content-Security-Policy: sandbox allow-scripts`
  (`server.js:1154`) so a build's own inline script can run but cannot reach
  back into this origin to open the control socket or read another build's
  output.

## Turn and ordering semantics a client must respect

- **One floor, whoever spoke last holds it.** If a `say` arrives while a
  previous turn's brain call is still in flight, the server aborts that call
  (`conv.abort.abort()`, `server.js:2182`) rather than answering a question
  that has been overtaken by a newer one.
- **A turn gate drops stale replies.** Each turn takes a token from
  `gate.begin()` and checks `gate.isCurrent(token)` after the (possibly slow)
  brain call returns (`lib/turns.js:175`, used at `server.js:2184,2317`). A
  call that resolves after being superseded still updates the session id and
  any memory it produced — that exchange really happened — but it is never
  spoken and never dispatches a build. A client does not see this directly;
  it shows up as some turns producing no `reply_text`/audio at all.
- **A spoken clip can itself be overtaken mid-synthesis.** `say()`'s
  `stillCurrent` check (`server.js:1207`) is re-run at the first audio byte,
  because Fish takes ~450 ms to start streaming; if the turn has been
  superseded by then, the clip is aborted before `audio_start` is ever sent,
  and nothing but a `debug` line marks it.
- **Announcements only speak when the floor is genuinely free**, and only
  when the client says so. The server never pushes an announcement's audio
  unprompted — it sends `announce` to offer the text, and waits for
  `announce_ready` before calling `say()` on it (`server.js:2127`). The floor
  being free (mic not held, nothing playing, no question pending) is a
  client-side fact the server cannot observe, which is why the client, not
  the server, decides when to send `announce_ready`.
- **A `clear_announcements` frame invalidates the client's own queue**, not
  just the server's — a recap that just spoke every pending line would
  otherwise be followed by the same lines read again the next time the floor
  opens.
- **A `state` of `"idle"` is not always sent explicitly** at the end of a
  successful build or reply: `say()` returns once audio has been *sent*, not
  once it has been *heard*, so ending a turn with an explicit `idle` would
  race the clip still playing and cut the orb dead mid-sentence. The client
  is expected to return to idle itself once its own clip finishes
  (`clipEnded()`, `public/app.js:958`).

## Verification

`grep -o 'type: *"[a-z_]*"' public/app.js server.js | sort -u` was run against
this worktree and every literal it found — `activity`, `announce`,
`announce_ready`, `ask`, `audio_chunk`, `audio_end`, `audio_start`,
`clear_announcements`, `debug`, `error`, `open`, `progress`, `reply_text`,
`roster`, `say`, `set_main`, `state`, `workspaces` — is documented above. None
were left unclassified.
