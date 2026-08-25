import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  COOKIE,
  clearCookie,
  createAuth,
  decodeJwt,
  isExpired,
  parseCookie,
  sessionCookie,
} from "../lib/auth.js";
import { loadSupabaseConfig } from "../lib/config.js";

// A real-shaped token, signed with nothing. Every test that needs a token needs
// one whose `exp` it controls, and the signature is never checked locally -- it
// is Supabase that verifies, which is what the fake client below stands in for.
function jwt(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.not-a-signature`;
}

// The seam: `auth` is shaped like the Supabase SDK's, and counts its calls so a
// test can assert that a cached token did NOT reach it.
function fakeSupabase({ user = { id: "u1" }, token = jwt({ exp: 4e9 }), signInError = null, acceptAny = false } = {}) {
  const calls = { signIn: 0, getUser: 0 };
  return {
    calls,
    auth: {
      async signInWithPassword() {
        calls.signIn++;
        if (signInError) return { data: null, error: { message: signInError } };
        return { data: { session: { access_token: token, expires_in: 3600 } }, error: null };
      },
      async getUser(given) {
        calls.getUser++;
        if (!acceptAny && given !== token) return { data: null, error: { message: "bad jwt" } };
        return { data: { user }, error: null };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

test("a cookie header splits into its pairs", () => {
  assert.deepEqual(parseCookie("a=1; b=2"), { a: "1", b: "2" });
});

test("a cookie value containing an equals sign survives intact", () => {
  assert.deepEqual(parseCookie("t=ab==cd"), { t: "ab==cd" });
});

test("a bare cookie name with no value is absent rather than empty", () => {
  assert.deepEqual(parseCookie("flag; a=1"), { a: "1" });
});

test("a missing cookie header is an empty set of cookies, not a crash", () => {
  assert.deepEqual(parseCookie(undefined), {});
  assert.deepEqual(parseCookie(null), {});
});

test("the session cookie is HttpOnly and SameSite=Strict", () => {
  const header = sessionCookie("tok", 3600);
  assert.match(header, new RegExp(`^${COOKIE}=tok;`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=3600/);
});

test("the session cookie is not Secure unless asked, because the server speaks http", () => {
  assert.doesNotMatch(sessionCookie("tok", 3600), /Secure/);
  assert.match(sessionCookie("tok", 3600, true), /Secure/);
});

test("a nonsense lifetime falls back to an hour rather than expiring the cookie at once", () => {
  assert.match(sessionCookie("tok", undefined), /Max-Age=3600/);
  assert.match(sessionCookie("tok", -5), /Max-Age=3600/);
  assert.match(sessionCookie("tok", 90.7), /Max-Age=90/);
});

test("clearing the cookie sends an empty value with Max-Age=0", () => {
  const header = clearCookie();
  assert.match(header, new RegExp(`^${COOKIE}=;`));
  assert.match(header, /Max-Age=0/);
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test("a well-formed token yields its claims", () => {
  assert.deepEqual(decodeJwt(jwt({ sub: "u1", exp: 123 })), { sub: "u1", exp: 123 });
});

test("anything that is not three dotted segments decodes to null", () => {
  assert.equal(decodeJwt("a.b"), null);
  assert.equal(decodeJwt("a.b.c.d"), null);
  assert.equal(decodeJwt(""), null);
  assert.equal(decodeJwt(undefined), null);
  assert.equal(decodeJwt(12), null);
});

test("a token whose payload is not JSON decodes to null rather than throwing", () => {
  assert.equal(decodeJwt("aaa.bbb.ccc"), null);
});

test("a token whose payload is a bare JSON value is not a set of claims", () => {
  const part = (s) => Buffer.from(s).toString("base64url");
  assert.equal(decodeJwt(`x.${part("42")}.y`), null);
  assert.equal(decodeJwt(`x.${part("null")}.y`), null);
});

test("expiry is read from exp, in seconds", () => {
  assert.equal(isExpired({ exp: 1000 }, 999_000), false);
  assert.equal(isExpired({ exp: 1000 }, 1_000_000), true);
  assert.equal(isExpired({ exp: 1000 }, 1_000_001), true);
});

test("a token with no exp is treated as expired", () => {
  assert.equal(isExpired({ sub: "u1" }, 0), true);
  assert.equal(isExpired({ exp: "soon" }, 0), true);
  assert.equal(isExpired(null, 0), true);
});

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

test("a correct sign-in returns a token and the cookie to set", async () => {
  const client = fakeSupabase();
  const auth = createAuth({ client });
  const result = await auth.signIn("a@b.c", "hunter2");
  assert.equal(result.ok, true);
  assert.equal(result.expiresIn, 3600);
  assert.match(result.cookie, /HttpOnly/);
});

test("a rejected sign-in says only that the pair was wrong, never which half", async () => {
  const client = fakeSupabase({ signInError: "User not found" });
  const auth = createAuth({ client });
  const result = await auth.signIn("a@b.c", "hunter2");
  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid email or password.");
  // The cause goes to the log, not to the browser.
  assert.equal(result.reason, "User not found");
});

test("a project that cannot be reached is a failed sign-in, not a crash", async () => {
  const client = fakeSupabase();
  client.auth.signInWithPassword = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
  const auth = createAuth({ client });
  const result = await auth.signIn("a@b.c", "hunter2");
  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid email or password."); // the same sentence in the browser
  assert.match(result.reason, /ENOTFOUND/); // and a different one in the log
});

test("a missing email or password never reaches Supabase", async () => {
  const client = fakeSupabase();
  const auth = createAuth({ client });
  assert.equal((await auth.signIn("", "p")).ok, false);
  assert.equal((await auth.signIn("a@b.c", "")).ok, false);
  assert.equal((await auth.signIn(undefined, undefined)).ok, false);
  assert.equal(client.calls.signIn, 0);
});

// ---------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------

test("a token Supabase recognises verifies", async () => {
  const token = jwt({ exp: 4e9 });
  const auth = createAuth({ client: fakeSupabase({ token }) });
  assert.equal(await auth.verify(token), true);
});

test("a token Supabase does not recognise fails, however well-formed it looks", async () => {
  const auth = createAuth({ client: fakeSupabase({ token: jwt({ exp: 4e9, sub: "real" }) }) });
  assert.equal(await auth.verify(jwt({ exp: 4e9, sub: "forged" })), false);
});

test("a malformed or expired token is refused without asking Supabase", async () => {
  const client = fakeSupabase();
  const auth = createAuth({ client, now: () => 2_000_000 });
  assert.equal(await auth.verify("garbage"), false);
  assert.equal(await auth.verify(undefined), false);
  assert.equal(await auth.verify(jwt({ exp: 1000 })), false); // long past
  assert.equal(client.calls.getUser, 0);
});

test("a verified token is not re-checked with Supabase on every request", async () => {
  const token = jwt({ exp: 4e9 });
  const client = fakeSupabase({ token });
  const auth = createAuth({ client });
  assert.equal(await auth.verify(token), true);
  assert.equal(await auth.verify(token), true);
  assert.equal(await auth.verify(token), true);
  assert.equal(client.calls.getUser, 1);
});

test("the cached answer goes stale and is asked again", async () => {
  const token = jwt({ exp: 4e9 });
  const client = fakeSupabase({ token });
  let clock = 1_000_000;
  const auth = createAuth({ client, now: () => clock });
  assert.equal(await auth.verify(token), true);
  clock += 61_000;
  assert.equal(await auth.verify(token), true);
  assert.equal(client.calls.getUser, 2);
});

test("a token that expires while cached stops verifying without a round trip", async () => {
  const token = jwt({ exp: 2000 }); // expires at 2_000_000 ms
  const client = fakeSupabase({ token });
  let clock = 1_000_000;
  const auth = createAuth({ client, now: () => clock });
  assert.equal(await auth.verify(token), true);
  assert.equal(client.calls.getUser, 1);
  clock = 2_000_001;
  assert.equal(await auth.verify(token), false);
  assert.equal(client.calls.getUser, 1);
});

test("signing out forgets the cached answer, so the next check asks again", async () => {
  const token = jwt({ exp: 4e9 });
  const client = fakeSupabase({ token });
  const auth = createAuth({ client });
  assert.equal(await auth.verify(token), true);
  auth.forget(token);
  assert.equal(await auth.verify(token), true);
  assert.equal(client.calls.getUser, 2);
});

test("the verified-token cache evicts rather than growing without bound", async () => {
  // Every one of these is well-formed and unexpired, so each gets past the cheap
  // local check and into the map. The cap is what keeps a stream of them from
  // being a way to grow this process's memory -- and the way to observe the cap
  // is that the oldest entry is gone and has to be asked about again.
  const client = fakeSupabase({ acceptAny: true });
  const auth = createAuth({ client });
  const first = jwt({ exp: 4e9, sub: "first" });
  assert.equal(await auth.verify(first), true);
  assert.equal(client.calls.getUser, 1);

  for (let i = 0; i < 64; i++) await auth.verify(jwt({ exp: 4e9, sub: `u${i}` }));
  assert.equal(await auth.verify(first), true);
  assert.equal(client.calls.getUser, 66); // 1 + 64 + the evicted first, asked again
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("supabase config reads url and anon key from a file", () => {
  const path = fileURLToPath(new URL("./fixtures/supabase.json", import.meta.url));
  const cfg = loadSupabaseConfig(path, {});
  assert.deepEqual(cfg, { url: "https://test.supabase.co", anonKey: "test-anon-key", secure: false });
});

test("the environment wins over the file", () => {
  const path = fileURLToPath(new URL("./fixtures/supabase.json", import.meta.url));
  const cfg = loadSupabaseConfig(path, { SUPABASE_URL: "https://env.supabase.co", SECURE_COOKIE: "1" });
  assert.deepEqual(cfg, { url: "https://env.supabase.co", anonKey: "test-anon-key", secure: true });
});

test("the file is optional when both values are in the environment", () => {
  const cfg = loadSupabaseConfig("/nonexistent/supabase.json", {
    SUPABASE_URL: "https://env.supabase.co",
    SUPABASE_ANON_KEY: "env-key",
  });
  assert.deepEqual(cfg, { url: "https://env.supabase.co", anonKey: "env-key", secure: false });
});

test("a missing url or anon key is a startup error naming what is missing", () => {
  assert.throws(() => loadSupabaseConfig("/nonexistent/supabase.json", {}), /SUPABASE_URL/);
  assert.throws(
    () => loadSupabaseConfig("/nonexistent/supabase.json", { SUPABASE_URL: "https://x.co" }),
    /SUPABASE_ANON_KEY/,
  );
});
