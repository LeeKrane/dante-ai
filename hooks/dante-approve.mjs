#!/usr/bin/env node
// Claude Code PreToolUse hook -> Dante. Asks you out loud before the two
// things worth being interrupted for, and waits for the answer.
//
// Unlike hooks/dante-notify.mjs this one BLOCKS -- that is the entire point,
// because a decision that arrives after the tool ran is not a decision. It
// still cannot damage the session it is asking about:
//
//   - It always exits 0. A non-zero exit is a signal to Claude Code, and
//     "Dante is not running" must not become one.
//   - Silence means no decision. Printing nothing lets the session do exactly
//     what it would have done without this hook installed -- ask you in the
//     terminal. It never denies for want of a listener.
//   - It gives up. The server has its own timeout; this one is longer, so the
//     ordinary path is the server answering rather than this script guessing.

import { request } from "node:http";

const PORT = Number(process.env.DANTE_PORT) || 3210;
// Longer than the server's own approval window on purpose, so a timeout here
// means Dante is gone rather than that nobody answered.
const TIMEOUT_MS = 90_000;
const MAX_BODY = 4096;

let finished = false;
function done(decision) {
  if (finished) return;
  finished = true;
  // The only thing this ever writes. An empty decision is written as nothing
  // at all, because a bare "{}" is one more thing for a parser to have an
  // opinion about.
  if (decision) process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
  // A tool input can be a whole file. Nothing that large is a decision anyone
  // can make out loud, and the fields read below are all short.
  if (raw.length > MAX_BODY * 16) raw = raw.slice(0, MAX_BODY * 16);
});

process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { return done(null); }
  if (!payload || typeof payload !== "object") return done(null);

  const body = JSON.stringify({
    session_id: payload.session_id,
    cwd: payload.cwd,
    tool_name: payload.tool_name,
    // Only the three fields the scope check reads. Sending the whole tool input
    // would put file contents on a socket for no reason, and the server has a
    // small body limit besides.
    tool_input: {
      file_path: payload.tool_input?.file_path,
      notebook_path: payload.tool_input?.notebook_path,
      command: typeof payload.tool_input?.command === "string"
        ? payload.tool_input.command.slice(0, 500)
        : undefined,
    },
  });
  if (body.length > MAX_BODY) return done(null);

  const req = request(
    {
      host: "127.0.0.1", // loopback only, matching the endpoint's own rule
      port: PORT,
      path: "/approve",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    },
    (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { out += chunk; if (out.length > MAX_BODY) out = out.slice(0, MAX_BODY); });
      res.on("end", () => {
        try {
          const answer = JSON.parse(out);
          // The server sends the decision already shaped. Anything else --
          // including the "no decision" it sends when nobody is listening --
          // is silence here.
          done(answer?.hookSpecificOutput ? answer : null);
        } catch { done(null); }
      });
    },
  );
  req.on("timeout", () => { req.destroy(); done(null); });
  req.on("error", () => done(null)); // Dante not running is the ordinary case
  req.end(body);
});

process.stdin.on("error", () => done(null));
