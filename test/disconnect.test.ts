import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/auth/vendor/argon2.js", async () => ({ argon2id: (await import("hash-wasm")).argon2id }));
import { hashPassword } from "../src/auth/password";
import { digest, getSession, timestamp } from "../src/auth/session";
import { disconnectInstagram } from "../src/auth/disconnect";
import { assertConnection, ConnectionChangedError, connectionGeneration, guardedConnectionDb } from "../src/connection";
import { saveAuth, upsertCampaign, kvSet } from "../src/db";
import { SendQueue } from "../src/queue/queue";
import { InstagramApiError } from "../src/api/client";
import { buildRuntime } from "../src/runtime";
import { refreshTokenIfDue } from "../src/auth/refresh";
import { handleAuthorize, handleCallback } from "../src/routes/auth";
import { pollComments } from "../src/poller/commentPoll";
import { handleWebhookEvent } from "../src/routes/webhook";
import { makeTestDbWithHandle, applyMigration } from "./helpers/fakeD1";
import worker from "../src/index";
import type { Campaign, Env } from "../src/types";

const origin = "https://fadeloop.test", password = "disconnect123", token = "a".repeat(64);
let hash: string;
beforeAll(async () => { hash = await hashPassword(password); });
const campaign: Campaign = { campaign_id: "active", media_id: "post", match_mode: "any", keywords: [], reward: { type: "text", value: "Thanks" }, copy: { opening: "Tap", delivery: "Thanks" } };
const deletedTables = ["campaigns", "campaign_folders", "campaign_trigger_activation", "automation_folders", "conversations", "events", "processed_comments", "comment_actions", "send_claims", "auth", "kv", "owner_oauth_states"];
async function fixture() {
  const { db, raw } = makeTestDbWithHandle();
  await db.prepare("INSERT INTO owner_accounts (id,email,password_hash,updated_at) VALUES (1,'owner@example.com',?,0)").bind(hash).run();
  await db.prepare("INSERT INTO owner_sessions (token_hash,owner_id,credential_version,expires_at,created_at) VALUES (?,1,1,?,0)").bind(await digest(token), timestamp() + 3600).run();
  await saveAuth(db, { access_token: "fixture", ig_user_id: "instagram", expires_at: timestamp() + 86400 });
  await db.prepare("INSERT INTO automation_folders (folder_id,name,created_at) VALUES ('folder','Folder',0)").run();
  for (const [id, active, archived] of [["active", true, 0], ["stopped", false, 0], ["archived", false, 1]] as const) {
    await upsertCampaign(db, { ...campaign, campaign_id: id }, active, "folder");
    await db.prepare("UPDATE campaigns SET archived_at = ? WHERE campaign_id = ?").bind(archived || null, id).run();
  }
  await db.prepare("INSERT INTO conversations (igsid,campaign_id,state,created_at,updated_at) VALUES ('person','active','AWAITING_TAP',0,0)").run();
  await db.prepare("INSERT INTO events (campaign_id,igsid,type,created_at) VALUES ('active','person','opening_sent',0)").run();
  await db.prepare("INSERT INTO processed_comments (comment_id,igsid,campaign_id,created_at) VALUES ('comment','person','active',0)").run();
  await db.prepare("INSERT INTO comment_actions (comment_id,action,created_at) VALUES ('comment','reply',0)").run();
  await db.prepare("INSERT INTO send_claims (key,created_at) VALUES ('send',0)").run();
  await db.prepare("INSERT INTO owner_oauth_states (state_hash,session_hash,expires_at) VALUES ('state',?,?)").bind(await digest(token), timestamp() + 600).run();
  await kvSet(db, "last_msg_poll_ts", "123");
  const env = { DB: db, MODE: "polling", GRAPH_VERSION: "v23.0", POLL_INTERVAL_SECONDS: "60", REDIRECT_URI: origin + "/auth/callback", APP_ID: "app", APP_SECRET: "secret", ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher } as Env;
  return { env, db, raw };
}
function request(body: unknown = { password, connection_generation: 0 }, headers: Record<string, string> = {}) {
  return new Request(origin + "/auth/disconnect", { method: "POST", headers: { origin, "content-type": "application/json", cookie: `__Host-fadeloop_session=${token}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
async function count(db: D1Database, table: string) { return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n; }

describe("password-confirmed workspace reset", () => {
  it("deletes every workspace table, preserves owner/session/throttles and increments generation", async () => {
    const { env, db } = await fixture();
    for (const table of deletedTables) expect(await count(db, table)).toBeGreaterThan(0);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ disconnected: true, deleted: true });
    for (const table of deletedTables) expect(await count(db, table)).toBe(0);
    expect(await count(db, "owner_accounts")).toBe(1);
    expect(await count(db, "owner_sessions")).toBe(1);
    expect(await count(db, "login_throttles")).toBe(1);
    expect(await getSession(request(), db)).not.toBeNull();
    expect(await connectionGeneration(db)).toBe(1);
    const status = await worker.fetch(new Request(origin + "/api/status", { headers: request().headers }), env);
    expect(await status.json()).toMatchObject({ connected: false, connection_generation: 1 });
  });
  it("rejects missing/incorrect passwords, passwordless legacy, invalid generations, bad JSON, cross-origin, oversized bodies and expired sessions", async () => {
    const { env, db } = await fixture();
    for (const [body, status] of [[{}, 400], [{ connection_generation: 0 }, 403], [{ password: "incorrect", connection_generation: 0 }, 403], ["{", 400], ["x".repeat(4097), 413], [{ password, connection_generation: -1 }, 400]] as const) expect((await worker.fetch(request(body), env)).status).toBe(status);
    expect((await worker.fetch(request(undefined, { origin: "https://evil.test" }), env)).status).toBe(403);
    expect((await worker.fetch(request(undefined, { "content-type": "text/plain" }), env)).status).toBe(415);
    expect((await worker.fetch(request(undefined, { cookie: "" }), env)).status).toBe(401);
    await db.prepare("UPDATE owner_sessions SET expires_at = 0").run();
    expect((await worker.fetch(request(), env)).status).toBe(401);
    expect(await count(db, "campaigns")).toBe(3);
  });
  it("reserves exactly five attempts atomically across concurrent requests before hashing", async () => {
    const { env } = await fixture();
    const results = await Promise.all(Array.from({ length: 7 }, () => disconnectInstagram(request({ password: "short", connection_generation: 0 }), env)));
    expect(results.filter(r => r.status === 403)).toHaveLength(5);
    expect(results.filter(r => r.status === 429)).toHaveLength(2);
    expect(Number(results.find(r => r.status === 429)!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("rolls back every delete and the connection generation when a later statement fails", async () => {
    const { env, db, raw } = await fixture();
    raw.exec("CREATE TRIGGER refuse_reset BEFORE DELETE ON auth BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect((await disconnectInstagram(request(), env)).status).toBe(500);
    for (const table of deletedTables) expect(await count(db, table)).toBeGreaterThan(0);
    expect(await connectionGeneration(db)).toBe(0);
  });
  for (const action of ["logout", "password reset"]) it(`a concurrent ${action} aborts deletion inside the transaction`, async () => {
    const { env, db } = await fixture();
    const batch = db.batch.bind(db);
    db.batch = async statements => {
      if (action === "logout") await db.prepare("DELETE FROM owner_sessions").run();
      else await db.prepare("UPDATE owner_accounts SET credential_version = credential_version + 1").run();
      return batch(statements);
    };
    expect((await disconnectInstagram(request(), env)).status).toBe(401);
    expect(await count(db, "campaigns")).toBe(3);
    expect(await count(db, "auth")).toBe(1);
    expect(await connectionGeneration(db)).toBe(0);
  });
  it("accepts repeated reset but cannot delete an immediately reconnected account", async () => {
    const { env, db } = await fixture();
    expect((await disconnectInstagram(request(), env)).status).toBe(200);
    expect((await disconnectInstagram(request(), env)).status).toBe(200);
    await saveAuth(db, { access_token: "new", ig_user_id: "new", expires_at: timestamp() + 100 }, { generation: 1, sessionHash: await digest(token), credentialVersion: 1 });
    expect((await disconnectInstagram(request(), env)).status).toBe(409);
    expect(await count(db, "auth")).toBe(1);
    expect(await connectionGeneration(db)).toBe(2);
  });
  it("prevents stale campaign saves, polling cursor writes, token refresh and OAuth replacement after reset/reconnect", async () => {
    const { env, db } = await fixture();
    const stale = guardedConnectionDb(db, 0);
    expect((await disconnectInstagram(request(), env)).status).toBe(200);
    await saveAuth(db, { access_token: "new", expires_at: timestamp() + 100 }, { generation: 1, sessionHash: await digest(token), credentialVersion: 1 });
    await expect(upsertCampaign(stale, campaign, true)).rejects.toBeInstanceOf(ConnectionChangedError);
    await expect(kvSet(stale, "last_msg_poll_ts", "123")).rejects.toBeInstanceOf(ConnectionChangedError);
    await expect(saveAuth(stale, { access_token: "old", expires_at: 9999999999 })).rejects.toBeInstanceOf(ConnectionChangedError);
    await expect(saveAuth(db, { access_token: "old", expires_at: 9999999999 }, { generation: 0, sessionHash: await digest(token), credentialVersion: 1 })).rejects.toThrow();
    expect(await count(db, "campaigns")).toBe(0);
    expect(await count(db, "kv")).toBe(0);
    expect(await db.prepare("SELECT access_token FROM auth").first()).toMatchObject({ access_token: "new" });
  });
  it("checks connection before every rate-limit retry", async () => {
    const { env, db } = await fixture();
    const queue = new SendQueue({ minIntervalMs: 0, baseBackoffMs: 0, beforeAttempt: () => assertConnection(db, 0) });
    let calls = 0;
    await expect(queue.run(async () => {
      calls++;
      expect((await disconnectInstagram(request(), env)).status).toBe(200);
      throw new InstagramApiError("rate limit", 429);
    })).rejects.toBeInstanceOf(ConnectionChangedError);
    expect(calls).toBe(1);
  });
  it("does not recreate contacts or analytics when a submitted send completes after disconnect", async () => {
    const { env, db } = await fixture();
    const runtime = (await buildRuntime(env))!;
    vi.spyOn(runtime.client, "privateReplyWithButtons").mockImplementation(async () => {
      expect((await disconnectInstagram(request(), env)).status).toBe(200);
      return { message_id: "already-submitted" };
    });
    await expect(runtime.engine.handleComment({ kind: "comment", comment_id: "new", igsid: "new", media_id: "post", text: "🙂", timestamp: timestamp() + 1 })).rejects.toBeInstanceOf(ConnectionChangedError);
    for (const table of deletedTables) expect(await count(db, table)).toBe(0);
  });
  it("a campaign request whose body arrives after disconnect/reconnect cannot save into the new connection", async () => {
    const { env, db } = await fixture();
    const req = new Request(origin + "/api/campaigns", { method: "POST", headers: request().headers, body: "{}" });
    vi.spyOn(req, "json").mockImplementation(async () => {
      expect((await disconnectInstagram(request(), env)).status).toBe(200);
      await saveAuth(db, { access_token: "new", expires_at: timestamp() + 100 }, { generation: 1, sessionHash: await digest(token), credentialVersion: 1 });
      return { campaign, active: true };
    });
    expect((await worker.fetch(req, env)).status).toBe(409);
    expect(await count(db, "campaigns")).toBe(0);
  });
  it("polling already in progress cannot restore comment ledgers or polling/error cursors", async () => {
    const { env, db } = await fixture();
    const runtime = (await buildRuntime(env))!;
    vi.spyOn(runtime.client, "getComments").mockImplementation(async () => {
      expect((await disconnectInstagram(request(), env)).status).toBe(200);
      return [{ id: "late", text: "hello", from: { id: "late" }, timestamp: new Date(Date.now() + 1000).toISOString() }];
    });
    await expect(pollComments(runtime, runtime.db)).rejects.toBeInstanceOf(ConnectionChangedError);
    for (const table of deletedTables) expect(await count(db, table)).toBe(0);
  });
  it("a token-refresh HTTP response cannot restore credentials after disconnect", async () => {
    const { env, db } = await fixture();
    await db.prepare("UPDATE auth SET refreshed_at = ?, expires_at = ?").bind(timestamp() - 172800, timestamp() + 86400).run();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect((await disconnectInstagram(request(), env)).status).toBe(200);
      return Response.json({ access_token: "refreshed", expires_in: 5184000 });
    });
    try {
      expect((await refreshTokenIfDue(env)).status).toBe("error");
      expect(await count(db, "auth")).toBe(0);
      expect(await connectionGeneration(db)).toBe(1);
    } finally { fetch.mockRestore(); }
  });
  it("a webhook body started before disconnect is ignored after immediate reconnection", async () => {
    const { env, db } = await fixture();
    const raw = JSON.stringify({ entry: [{ changes: [{ field: "comments", value: { id: "late", text: "hello", media: { id: "post" }, from: { id: "person" }, timestamp: new Date().toISOString() } }] }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const signature = "sha256=" + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
    const req = new Request(origin + "/webhook", { method: "POST", body: raw, headers: { "x-hub-signature-256": signature } });
    vi.spyOn(req, "text").mockImplementation(async () => {
      expect((await disconnectInstagram(request(), env)).status).toBe(200);
      await saveAuth(db, { access_token: "new", expires_at: timestamp() + 100 }, { generation: 1, sessionHash: await digest(token), credentialVersion: 1 });
      return raw;
    });
    expect((await handleWebhookEvent(env, req)).status).toBe(200);
    expect(await count(db, "conversations")).toBe(0);
    expect(await count(db, "events")).toBe(0);
    expect(await count(db, "processed_comments")).toBe(0);
  });
  it("an OAuth exchange already in progress cannot restore credentials after disconnect", async () => {
    const { env, db } = await fixture();
    const session = (await getSession(request(), db))!;
    const start = await handleAuthorize(env, session);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      if (String(input).includes("api.instagram.com/oauth")) {
        expect((await disconnectInstagram(request(), env)).status).toBe(200);
        return Response.json({ access_token: "short", user_id: "instagram" });
      }
      if (String(input).includes("/access_token")) return Response.json({ access_token: "long", expires_in: 5184000 });
      return Response.json({ user_id: "instagram", username: "creator", account_type: "BUSINESS" });
    });
    try {
      const url = new URL(origin + `/auth/callback?code=code&state=${state}`);
      const result = await handleCallback(env, url, new Request(url, { headers: request().headers }));
      expect(result.status).toBe(409);
      expect(await count(db, "auth")).toBe(0);
      expect(await count(db, "owner_oauth_states")).toBe(0);
    } finally { fetch.mockRestore(); }
  });
  it("additive generation migration preserves pre-existing campaigns/auth/contact data", async () => {
    const { db, raw } = makeTestDbWithHandle("0007");
    await upsertCampaign(db, { ...campaign, match_mode: "keywords", keywords: ["link"] }, true);
    await db.prepare("INSERT INTO auth (id,access_token,expires_at) VALUES (1,'existing',123)").run();
    applyMigration(raw, "0008_connection_generation.sql");
    expect(await count(db, "campaigns")).toBe(1);
    expect(await db.prepare("SELECT access_token FROM auth").first()).toMatchObject({ access_token: "existing" });
    expect(await connectionGeneration(db)).toBe(0);
  });
});

