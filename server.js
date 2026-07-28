import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadFishConfig } from "./lib/config.js";
import { ask } from "./lib/brain.js";
import { speak } from "./lib/tts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const PORT = 3210;
const cfg = loadFishConfig(); // throws early if Fish key missing

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const rel = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  // Contain the request inside public/ — reject any path that escapes it
  // (e.g. "/../lib/config.js" or a traversal toward ~/.config secrets).
  const filePath = resolve(PUBLIC, "." + rel);
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + sep)) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("not found"); }
});

const wss = new WebSocketServer({ server });
const sessions = new Map(); // ws -> sessionId

const log = (...a) => console.log(new Date().toISOString(), ...a);

wss.on("connection", (ws) => {
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  log("client connected");
  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== "say" || !msg.text?.trim()) return;
    log("say:", JSON.stringify(msg.text));
    send({ type: "debug", stage: "stt", msg: `heard "${msg.text}"` });
    try {
      send({ type: "state", value: "thinking" });
      const tb = Date.now();
      const { reply, sessionId } = await ask(msg.text, sessions.get(ws));
      const bms = Date.now() - tb;
      sessions.set(ws, sessionId);
      log(`brain ok ${bms}ms session=${sessionId} reply=${JSON.stringify(reply)}`);
      send({ type: "debug", stage: "brain", ms: bms, msg: `claude: "${reply}"` });
      send({ type: "reply_text", text: reply });
      const tt = Date.now();
      const audio = await speak(reply, cfg);
      const tms = Date.now() - tt;
      log(`tts ok ${tms}ms ${audio.length}b`);
      send({ type: "debug", stage: "tts", ms: tms, msg: `fish ${audio.length} bytes` });
      send({ type: "state", value: "speaking" });
      send({ type: "audio", format: cfg.format, data: audio.toString("base64") });
    } catch (e) {
      log("ERROR:", e.message || e);
      send({ type: "debug", stage: "error", msg: String(e.message || e) });
      send({ type: "error", message: String(e.message || e) });
      send({ type: "state", value: "idle" });
    }
  });
  ws.on("close", () => { sessions.delete(ws); log("client disconnected"); });
});

// Bind to loopback only — this is a local single-user app, never a LAN service.
server.listen(PORT, "127.0.0.1", () => console.log(`Jarvis on http://localhost:${PORT}`));
