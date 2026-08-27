// The gate in front of the orb.
//
// The socket this guards spawns a Claude Code session with file tools on, under
// the user's login, so the check that matters is the one at the WebSocket
// upgrade -- a login screen in the browser is decoration on top of it. Anything
// here that returns false must end with a closed socket or a 401, never with a
// page that merely hides its buttons.
//
// Supabase does the actual authentication. This module is the seam: pure cookie
// and token helpers that can be tested without a network, and one factory whose
// client is injectable so the tests never reach Supabase at all.

import { createClient } from "@supabase/supabase-js";

// The name is deliberately not "sb-access-token" or any other spelling the
// Supabase browser SDK uses for its own storage. Nothing in public/ ever reads
// this cookie -- it is HttpOnly precisely so it cannot -- and a name of our own
// keeps that boundary visible.
export const COOKIE = "dante_session";

// A verified token is trusted for this long before Supabase is asked again.
// Every static file on the page is a request, so verifying each one over the
// network would put a round trip in front of every asset.
const VERIFY_TTL_MS = 60_000;

// The cache exists to spare Supabase repeat questions about the same token, not
// to hold a session table. One person signed in on a few tabs is a handful of
// entries; the cap is only here so that a caller who somehow reaches it with a
// stream of distinct tokens cannot grow the map without bound.
const VERIFY_MAX = 32;

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

// Cookie headers are a `;`-separated list, and a value may itself contain `=`,
// so each pair splits at its FIRST `=` only. A bare name with no `=` is skipped
// rather than recorded as an empty string, because "present but empty" and
// "absent" lead to different answers upstream and only one of them is true.
export function parseCookie(header) {
  const out = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

// `HttpOnly` is what keeps the token out of reach of script on the page, which
// matters more here than usual: this server also serves model-written HTML out
// of builds/, and one XSS in a build would otherwise be one fetch away from the
// session. `SameSite=Strict` is the other half -- a build page that tried to
// call back into this origin would not carry the cookie.
//
// `Secure` is opt-in rather than always-on because the server speaks plain HTTP.
// A Secure cookie is simply never sent over http://, so setting it by default
// would produce a login that appears to succeed and then silently fails to hold.
// Turn it on the moment there is TLS in front of this.
export function sessionCookie(token, maxAgeSeconds, secure = false) {
  const age = Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0 ? Math.floor(maxAgeSeconds) : 3600;
  const parts = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${age}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// Max-Age=0 rather than a past Expires date: both work, but only one of them is
// unambiguous in a header a human is reading.
export function clearCookie(secure = false) {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// Reads the claims out of a JWT WITHOUT checking its signature. This is not a
// verification and must never be used as one -- anyone can write a token whose
// payload says whatever they like. Its only job is to throw out the obviously
// dead ones (malformed, or past their own expiry) before we spend a network
// round trip asking Supabase about them. Supabase is what actually verifies.
export function decodeJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(json);
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null; // not base64url, or not JSON
  }
}

// A token with no `exp` is treated as expired. Supabase always issues one, so
// its absence means this is not the kind of token we think it is, and the safe
// reading of an unrecognised token is "no".
export function isExpired(claims, now = Date.now()) {
  if (!claims || typeof claims.exp !== "number") return true;
  return claims.exp * 1000 <= now;
}

// ---------------------------------------------------------------------------
// Impure
// ---------------------------------------------------------------------------

// `client` is the test seam, the same way `opts.bin` is in builder.js: pass a
// stand-in with an `auth` shaped like the SDK's and nothing here touches the
// network. `now` is injectable for the same reason -- expiry is a behaviour
// worth asserting on, and waiting an hour is not a test.
export function createAuth({ url, anonKey, client, secure = false, now = Date.now } = {}) {
  const supabase =
    client ??
    createClient(url, anonKey, {
      // This client is one process serving many people, not one browser holding
      // one person's session. Persisting or refreshing a session inside it would
      // mean the server quietly adopting whoever signed in last.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

  const verified = new Map(); // token -> timestamp it was verified at

  async function signIn(email, password) {
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
      return { ok: false, error: "Email and password are required.", reason: "empty field" };
    }
    let data, error;
    try {
      ({ data, error } = await supabase.auth.signInWithPassword({ email, password }));
    } catch (e) {
      // The SDK throws rather than returning an error when it cannot reach the
      // project at all, and a misconfigured URL failing in the same silent way
      // as a mistyped password is an hour of looking in the wrong place.
      error = e;
    }
    if (error || !data?.session?.access_token) {
      // Two audiences, two answers. Supabase distinguishes "no such user" from
      // "wrong password", which would tell an unauthenticated caller which half
      // they got right, so `error` is one flat sentence for every failure.
      // `reason` carries the real cause to the server's log, where the person
      // running this is the only one who can read it.
      return { ok: false, error: "Invalid email or password.", reason: error?.message || "no session returned" };
    }
    const token = data.session.access_token;
    remember(token);
    return { ok: true, token, expiresIn: data.session.expires_in, cookie: sessionCookie(token, data.session.expires_in, secure) };
  }

  async function verify(token) {
    const claims = decodeJwt(token);
    // Rejected here, a forged or stale token costs nothing. Rejected only by
    // Supabase, every one of them would have turned an unauthenticated request
    // into an outbound HTTP call this server pays for.
    if (!claims || isExpired(claims, now())) {
      verified.delete(token);
      return false;
    }
    const at = verified.get(token);
    if (at !== undefined && now() - at < VERIFY_TTL_MS) return true;

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      verified.delete(token);
      return false;
    }
    remember(token);
    return true;
  }

  function remember(token) {
    // Map iterates in insertion order, so the first key is the oldest. Deleting
    // before setting keeps a re-verified token from being evicted as though it
    // were stale.
    verified.delete(token);
    if (verified.size >= VERIFY_MAX) verified.delete(verified.keys().next().value);
    verified.set(token, now());
  }

  function forget(token) {
    verified.delete(token);
  }

  return { signIn, verify, forget };
}
