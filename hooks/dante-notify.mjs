#!/usr/bin/env node
// Claude Code hook -> Dante. Reads one hook event on stdin, posts it to the
// local Dante server, exits.
//
// You install this yourself; Dante never writes ~/.claude/. Its own build deny
// list forbids exactly that, on the grounds that a hook is code that runs on
// your next session, and it would be incoherent for the assistant to make an
// exception for itself. The README carries the snippet.
//
// Three rules govern everything below, and they are all the same rule: a
// notifier must never be able to damage the session it is notifying about.
//
//   - It always exits 0. A non-zero exit from a hook is a signal to Claude
//     Code, and "Dante is not running" is not a thing a session should be
//     told about, let alone blocked by.
//   - It prints nothing. Hook stdout can be fed back into the session.
//   - It gives up fast. A Dante that is down or wedged must cost a session
//     a second, not a stall.

import { request } from "node:http";

const PORT = Number(process.env.DANTE_PORT) || 3210;
const TIMEOUT_MS = 1000;
const MAX_BODY = 4096;

function done() { process.exit(0); }

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
  // A transcript path is in every payload but the transcript is not. Anything
  // this large is not a hook event, and forwarding it would only be refused.
  if (raw.length > MAX_BODY * 4) raw = raw.slice(0, MAX_BODY * 4);
});

process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { return done(); }
  if (!payload || typeof payload !== "object") return done();

  // Only the fields Dante reads. The transcript path, the tool input and
  // everything else stays on this side: the server has a small body limit, and
  // sending what nothing reads is how a limit gets raised later for no reason.
  const body = JSON.stringify({
    hook_event_name: payload.hook_event_name,
    session_id: payload.session_id,
    cwd: payload.cwd,
    message: typeof payload.message === "string" ? payload.message.slice(0, 300) : undefined,
    reason: typeof payload.reason === "string" ? payload.reason.slice(0, 300) : undefined,
  });
  if (body.length > MAX_BODY) return done();

  const req = request(
    {
      host: "127.0.0.1", // loopback only, matching the endpoint's own rule
      port: PORT,
      path: "/hook",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    },
    (res) => { res.resume(); res.on("end", done); },
  );
  req.on("timeout", () => { req.destroy(); done(); });
  req.on("error", done); // Dante not running is the ordinary case, not an error
  req.end(body);
});

process.stdin.on("error", done);
// A hook with no stdin at all must not hang the session that spawned it.
setTimeout(done, TIMEOUT_MS * 3).unref();
