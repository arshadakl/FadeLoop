import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/auth/vendor/argon2.js", async () => ({ argon2id: (await import("hash-wasm")).argon2id }));
import { hashPassword, normalizeEmail, validPassword, verifyPassword } from "../src/auth/password";
import { digest, getSession, handleSession, timestamp } from "../src/auth/session";
import { handleAuthorize, handleCallback } from "../src/routes/auth";
import worker from "../src/index";
import type { Env } from "../src/types";
import { applyMigration, makeTestDb, makeTestDbWithHandle } from "./helpers/fakeD1";
import { ownerSql } from "../scripts/owner-sql.mjs";

const origin = "https://fadeloop.test";
const password = "a long test password with spaces";
let hash: string;
beforeAll(async () => { hash = await hashPassword(password); });
async function environment(): Promise<Env> {
  const DB = makeTestDb();
  await DB.prepare("INSERT INTO owner_accounts (id, email, password_hash, updated_at) VALUES (1, ?, ?, ?)").bind("owner@example.com", hash, timestamp()).run();
  return { DB, ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher, GRAPH_VERSION: "v23.0", MODE: "polling", POLL_INTERVAL_SECONDS: "60", REDIRECT_URI: origin + "/auth/callback", APP_ID: "app", APP_SECRET: "secret" };
}
function login(over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Request(origin + "/session/login", { method: "POST", headers: { origin, "content-type": "application/json", "cf-connecting-ip": "127.0.0.1", ...headers }, body: JSON.stringify({ email: " OWNER@example.com ", password, ...over }) });
}
async function signIn(env: Env) {
  const response = await handleSession(login(), env, "/session/login");
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
const request = (path: string, cookie: string, init: RequestInit = {}) => new Request(origin + path, { ...init, headers: { cookie, origin, ...init.headers } });

describe("signed-in password changes", () => {
  function change(cookie: string, new_password: unknown = "changed123", headers: Record<string, string> = {}) {
    return request("/session/password", cookie, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ new_password }) });
  }
  it("rotates this session, revokes other devices/OAuth states, and replaces the password without the current password", async () => {
    const env = await environment();
    const first = await signIn(env), second = await signIn(env);
    await handleAuthorize(env, (await getSession(request("/session", first), env.DB))!);
    const response = await handleSession(change(first), env, "/session/password");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax; Max-Age=604800/);
    const next = response.headers.get("set-cookie")!.split(";")[0]!;
    expect(await getSession(request("/session", first), env.DB)).toBeNull();
    expect(await getSession(request("/session", second), env.DB)).toBeNull();
    expect(await getSession(request("/session", next), env.DB)).not.toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM owner_oauth_states").first()).toMatchObject({ n: 0 });
    expect((await handleSession(login(), env, "/session/login")).status).toBe(401);
    expect((await handleSession(login({ password: "changed123" }), env, "/session/login")).status).toBe(200);
  });
  it("rejects anonymous, cross-origin, malformed, oversized, and invalid-length requests", async () => {
    const env = await environment();
    const cookie = await signIn(env);
    expect((await handleSession(change(""), env, "/session/password")).status).toBe(401);
    expect((await handleSession(change(cookie, "changed123", { origin: "https://evil.test" }), env, "/session/password")).status).toBe(403);
    expect((await handleSession(change(cookie, "short"), env, "/session/password")).status).toBe(400);
    expect((await handleSession(change(cookie, "x".repeat(129)), env, "/session/password")).status).toBe(400);
    expect((await handleSession(request("/session/password", cookie, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), env, "/session/password")).status).toBe(400);
    expect((await handleSession(request("/session/password", cookie, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(4097) }), env, "/session/password")).status).toBe(413);
  });
  it("throttles the owner across sessions before hashing", async () => {
    const env = await environment();
    const cookie = await signIn(env);
    for (let i = 0; i < 5; i++) expect((await handleSession(change(cookie, "short"), env, "/session/password")).status).toBe(400);
    const response = await handleSession(change(cookie), env, "/session/password");
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("allows only one concurrent change from the old credential version", async () => {
    const env = await environment();
    const cookie = await signIn(env);
    const responses = await Promise.all([handleSession(change(cookie, "first123"), env, "/session/password"), handleSession(change(cookie, "second123"), env, "/session/password")]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
    const winner = responses[0]!.status === 200 ? "first123" : "second123";
    expect((await handleSession(login({ password: winner }), env, "/session/login")).status).toBe(200);
  });
  it("does not change the password when the initiating session is revoked during hashing", async () => {
    const env = await environment();
    const cookie = await signIn(env);
    const pending = handleSession(change(cookie), env, "/session/password");
    await handleSession(request("/session/logout", cookie, { method: "POST" }), env, "/session/logout");
    expect((await pending).status).toBe(401);
    expect((await handleSession(login(), env, "/session/login")).status).toBe(200);
  });
});

describe("owner passwords and sessions", () => {
  it("operator create/reset SQL prevents takeover and removes revoked sessions", async () => {
    const { raw, db } = makeTestDbWithHandle();
    raw.exec(ownerSql("create", "owner@example.com", hash, timestamp()));
    expect(() => raw.exec(ownerSql("create", "second@example.com", hash, timestamp()))).toThrow();
    const env = { ...await environment(), DB: db };
    const cookie = await signIn(env);
    await handleAuthorize(env, (await getSession(request("/session", cookie), db))!);
    raw.exec(ownerSql("reset", "missing@example.com", "different", timestamp() + 1));
    expect(await getSession(request("/session", cookie), db)).not.toBeNull();
    const replacement = await hashPassword("eight123");
    raw.exec(ownerSql("reset", "owner@example.com", replacement, timestamp() + 2));
    expect(await getSession(request("/session", cookie), db)).toBeNull();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM owner_sessions").get()).toMatchObject({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM owner_oauth_states").get()).toMatchObject({ n: 0 });
    expect((await handleSession(login(), env, "/session/login")).status).toBe(401);
    expect((await handleSession(login({ password: "eight123" }), env, "/session/login")).status).toBe(200);
  });
  it("rejects malformed and oversized login bodies before allocating a large buffer", async () => {
    const env = await environment();
    const options = { method: "POST", headers: { origin, "content-type": "application/json" } };
    expect((await handleSession(new Request(origin + "/session/login", { ...options, body: "{" }), env, "/session/login")).status).toBe(400);
    expect((await handleSession(new Request(origin + "/session/login", { ...options, body: "x".repeat(4097) }), env, "/session/login")).status).toBe(413);
  });
  it("uses salted Argon2id, preserves spaces, and verifies without plaintext storage", async () => {
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hashPassword(password)).not.toBe(hash);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(password.trim() + "x", hash)).toBe(false);
    expect(await verifyPassword(password, hash.replace("m=19456", "m=8"))).toBe(false);
    expect(normalizeEmail(" OWNER@example.com ")).toBe("owner@example.com");
    expect(validPassword("short")).toBe(false);
    expect(validPassword("x".repeat(129))).toBe(false);
    expect(validPassword("x".repeat(7))).toBe(false);
    expect(validPassword("x".repeat(8))).toBe(true);
    expect(validPassword(" xxxxxx ")).toBe(true);
    expect(validPassword("😀".repeat(8))).toBe(true);
  });
  it("creates secure cookies and stores only a session hash", async () => {
    const env = await environment();
    const response = await handleSession(login(), env, "/session/login");
    expect(response.headers.get("set-cookie")).toContain("Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800");
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const session = await getSession(request("/session", cookie), env.DB);
    expect(session?.token_hash).not.toBe(cookie.split("=")[1]);
    const current = await worker.fetch(request("/session", cookie), env);
    expect(Object.keys(await current.json() as object).sort()).toEqual(["email", "expires_at"]);
    expect(current.headers.get("cache-control")).toBe("no-store");
  });
  it("revokes logout and expires seven-day sessions", async () => {
    const env = await environment(); const cookie = await signIn(env);
    const response = await worker.fetch(request("/session/logout", cookie, { method: "POST" }), env);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await getSession(request("/session", cookie), env.DB)).toBeNull();
    const next = await signIn(env);
    await env.DB.prepare("UPDATE owner_sessions SET expires_at = ?").bind(timestamp()).run();
    expect(await getSession(request("/session", next), env.DB)).toBeNull();
  });
  it("rejects duplicate owners and invalidates every old session on reset", async () => {
    const env = await environment(); const one = await signIn(env); const two = await signIn(env);
    await expect(env.DB.prepare("INSERT INTO owner_accounts (id, email, password_hash, updated_at) VALUES (2, 'other@test.com', 'hash', 0)").run()).rejects.toThrow();
    await env.DB.prepare("UPDATE owner_accounts SET credential_version = credential_version + 1, password_hash = ? WHERE id = 1").bind(await hashPassword("replacement password for testing")).run();
    expect(await getSession(request("/session", one), env.DB)).toBeNull();
    expect(await getSession(request("/session", two), env.DB)).toBeNull();
    expect((await handleSession(login(), env, "/session/login")).status).toBe(401);
  });
  it("uses generic errors and limits attempts atomically across concurrent requests", async () => {
    const env = await environment();
    const responses = await Promise.all(Array.from({ length: 8 }, () => handleSession(login({ password: "wrong but long enough password" }), env, "/session/login")));
    expect(responses.filter(r => r.status === 401)).toHaveLength(5);
    expect(responses.filter(r => r.status === 429)).toHaveLength(3);
    expect(responses.find(r => r.status === 429)?.headers.get("retry-after")).toBeTruthy();
    await env.DB.prepare("UPDATE login_throttles SET expires_at = ?").bind(timestamp() - 1).run();
    expect((await handleSession(login({ email: "missing@example.com" }), env, "/session/login")).status).toBe(401);
  });
  it("throttles short wrong passwords and IP buckets across different emails", async () => {
    const env = await environment();
    for (let i = 0; i < 5; i++) expect((await handleSession(login({ email: `unknown${i}@test.com`, password: "short" }), env, "/session/login")).status).toBe(401);
    expect((await handleSession(login(), env, "/session/login")).status).toBe(429);
  });
  it("requires same-origin mutations and rejects every legacy token path", async () => {
    const env = await environment(); const cookie = await signIn(env);
    expect((await worker.fetch(login({}, { origin: "https://attacker.test" }), env)).status).toBe(403);
    expect((await worker.fetch(new Request(origin + "/api/status?token=legacy", { headers: { authorization: "Bearer legacy" } }), env)).status).toBe(401);
      for (const path of ["/api/campaigns", "/api/folders", "/api/folders/move", "/config/import", "/admin/poll", "/auth/disconnect"]) {
      expect((await worker.fetch(request(path, cookie, { method: "POST", headers: { origin: "https://attacker.test" } }), env)).status).toBe(403);
    }
    expect((await worker.fetch(request("/api/status", cookie), env)).status).toBe(200);
    expect((await worker.fetch(new Request(origin + "/auth/authorize", { headers: { cookie } }), env)).status).toBe(403);
    expect((await worker.fetch(request("/auth/authorize", cookie), env)).status).toBe(302);
    expect((await worker.fetch(new Request(origin + "/health"), env)).status).toBe(200);
  });
});

describe("Instagram authorization state", () => {
  it("preserves OAuth connection and refuses replacement by a different account", async () => {
    const env = await environment(); const cookie = await signIn(env);
    const session = (await getSession(request("/session", cookie), env.DB))!;
    let account = "original-account";
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth/access_token")) return Response.json({ access_token: "short-test-token", user_id: account });
      if (url.pathname === "/access_token") return Response.json({ access_token: "long-test-token", expires_in: 5184000 });
      if (url.pathname.endsWith("/me")) return Response.json({ user_id: account, username: "creator", account_type: "BUSINESS" });
      if (url.pathname.endsWith("/subscribed_apps")) return Response.json({ success: true });
      throw new Error("Unexpected Meta request");
    });
    try {
      const callback = async () => {
        const start = await handleAuthorize(env, session);
        const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
        const url = new URL(`${origin}/auth/callback?code=test-code&state=${state}`);
        return handleCallback(env, url, request(url.pathname, cookie));
      };
      expect((await callback()).status).toBe(200);
      expect(await env.DB.prepare("SELECT ig_user_id FROM auth").first()).toMatchObject({ ig_user_id: account });
      account = "different-account";
      expect((await callback()).status).toBe(409);
      expect(await env.DB.prepare("SELECT ig_user_id FROM auth").first()).toMatchObject({ ig_user_id: "original-account" });
    } finally { mock.mockRestore(); }
  });
  it("is session-bound, single-use, and expires without calling Meta", async () => {
    const env = await environment(); const cookie = await signIn(env); const other = await signIn(env);
    const session = (await getSession(request("/session", cookie), env.DB))!;
    const start = await handleAuthorize(env, session);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = new URL(origin + "/auth/callback?error=access_denied&state=" + state);
    expect((await handleCallback(env, callback, request(callback.pathname, other))).status).toBe(400);
    expect(await env.DB.prepare("SELECT state_hash FROM owner_oauth_states").first()).toMatchObject({ state_hash: await digest(state) });
    const cancelled = await handleCallback(env, callback, request(callback.pathname, cookie));
    expect(await cancelled.text()).toContain("Connection cancelled");
    expect(await env.DB.prepare("SELECT state_hash FROM owner_oauth_states").first()).toBeNull();
    expect((await handleCallback(env, callback, request(callback.pathname, cookie))).status).toBe(400);
    await handleAuthorize(env, session);
    await env.DB.prepare("UPDATE owner_oauth_states SET expires_at = ?").bind(timestamp() - 1).run();
    expect((await handleCallback(env, callback, request(callback.pathname, cookie))).status).toBe(400);
  });
});

it("the owner migration preserves existing automation and Instagram data", () => {
  const { raw } = makeTestDbWithHandle("0005");
  raw.exec("INSERT INTO campaigns (campaign_id,media_id,config_json,updated_at) VALUES ('c','m','{}',1); INSERT INTO conversations (igsid,campaign_id,state,updated_at,created_at) VALUES ('u','c','AWAITING_TAP',1,1); INSERT INTO events (campaign_id,type,created_at) VALUES ('c','opening_sent',1); INSERT INTO auth (id,access_token,expires_at) VALUES (1,'instagram-secret',9999999999);");
  const tables = ["campaigns", "conversations", "events", "auth"];
  const before = tables.map(table => raw.prepare(`SELECT * FROM ${table}`).all());
  applyMigration(raw, "0006_owner_sessions.sql");
  expect(tables.map(table => raw.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
});
