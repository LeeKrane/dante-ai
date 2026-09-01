export function loadFishConfig(env = process.env) {
  const apiKey = env.FISH_API_KEY || "";
  if (!apiKey) throw new Error("No Fish API key (set FISH_API_KEY)");
  return {
    apiKey,
    voiceId: env.FISH_VOICE_ID || "",
    model: env.FISH_MODEL || "s2.1-pro-free",
    format: env.FISH_FORMAT || "mp3",
    speed: env.FISH_SPEED !== "" && Number.isFinite(Number(env.FISH_SPEED)) ? Number(env.FISH_SPEED) : 1,
    // Semitones, 0 is neutral. Fish's prosody object has no pitch field at all
    // (only speed, volume, normalize_loudness), so this never reaches the TTS
    // request -- it is carried through to the browser instead, which applies it
    // by resampling the clip it already has.
    pitch: env.FISH_PITCH !== "" && Number.isFinite(Number(env.FISH_PITCH)) ? Number(env.FISH_PITCH) : 0,
    // A bug fix: volume has been documented in the README and shipped in the
    // setup snippet since it was added, and lib/tts.js has always had a live
    // code path for it, but this loader once dropped the field on the floor --
    // only the tests ever exercised that branch. It has never once reached Fish.
    volume: env.FISH_VOLUME !== "" && Number.isFinite(Number(env.FISH_VOLUME)) ? Number(env.FISH_VOLUME) : 0,
  };
}

// Read at startup for the same reason as loadFishConfig above: a missing key
// should be a startup error naming what is missing, not a login that fails at
// the moment someone first tries to use it. The values themselves come from
// the environment -- a gitignored `.env` in development, or whatever the
// service manager sets in production.
export function loadSupabaseConfig(env = process.env) {
  const url = env.SUPABASE_URL || "";
  const anonKey = env.SUPABASE_ANON_KEY || "";
  if (!url) throw new Error("No Supabase URL (set SUPABASE_URL)");
  if (!anonKey) throw new Error("No Supabase anon key (set SUPABASE_ANON_KEY)");
  // Opt-in rather than inferred: this server speaks plain HTTP, and a Secure
  // cookie is never sent over http:// at all. See sessionCookie in lib/auth.js.
  return { url, anonKey, secure: env.SECURE_COOKIE === "1" };
}

// The bind address and the WireGuard IP are both env-driven so the server
// does not have to be edited to move between a laptop, a machine meant to be
// reachable from the whole LAN, or a WireGuard node. The default is loopback
// -- an unset or empty DANTE_HOST comes up exactly as safe as before either
// of these was configurable at all, and reaching further than that is
// something the person running the server has to choose, not what happens
// when a `.env` line is forgotten.
export function serverIdentity(env = process.env) {
  return {
    host: env.DANTE_HOST || "127.0.0.1",
    wgIp: env.DANTE_WG_IP || "",
  };
}

// IPv6 literals contain ":", which is also the separator in "host:port", so
// "::1" has to become "[::1]:PORT" to stay unambiguous. IPv4 addresses and
// hostnames have no colon and pass through untouched.
function bracket(address) {
  return address.includes(":") ? `[${address}]` : address;
}

// Always reachable regardless of DANTE_HOST: the hook bridge in
// hooks/dante-*.mjs posts to 127.0.0.1 no matter where the server is also
// bound, so that spelling -- and its ::1 and localhost equivalents -- must
// keep working even once DANTE_HOST points somewhere else entirely.
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

// "0.0.0.0" and "::" are wildcard bind addresses, not names a browser would
// ever put in a Host header or an Origin -- they are what make the loopback
// and configured-host entries below reachable from outside, not hostnames of
// their own. Excluding them is also why plain http://0.0.0.0 stops working
// once this became configurable: the allow-list names only real addresses.
function isWildcard(host) {
  return host === "0.0.0.0" || host === "::";
}

// The Host-header allow-list behind hostAllowed() in server.js -- the
// DNS-rebinding defence described there. Kept as tight as the configuration
// allows: every entry is a name the server will actually answer requests
// for, so a wildcard bind address earns no entry, and a host or WireGuard IP
// only gets one when it names something specific.
export function allowedHosts({ host, wgIp, port }) {
  const hosts = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`, // the hook bridge posts here; see LOOPBACK above
    `[::1]:${port}`,
  ]);
  if (host && !isWildcard(host) && !LOOPBACK.has(host)) {
    hosts.add(`${bracket(host)}:${port}`);
  }
  if (wgIp) {
    hosts.add(`${bracket(wgIp)}:${port}`);
  }
  return hosts;
}

// The Origin allow-list behind originAllowed() in server.js, guarding the
// WebSocket upgrade the same way allowedHosts guards the Host header.
// http://127.0.0.1 is included deliberately even though the old hardcoded
// set never had it: it is loopback, and was implicitly reachable before this
// was configurable, so leaving it out here would be a silent regression
// rather than a decision.
export function allowedOrigins({ host, wgIp, port }) {
  const origins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
  if (host && !isWildcard(host) && !LOOPBACK.has(host)) {
    origins.add(`http://${bracket(host)}:${port}`);
  }
  if (wgIp) {
    origins.add(`http://${bracket(wgIp)}:${port}`);
  }
  return origins;
}

// Shared with server.js so the startup log's printed bind address gets the
// same IPv6 bracketing as the allow-lists above, instead of a second copy of
// the same rule drifting from this one.
export function bracketHost(host) {
  return bracket(host);
}
