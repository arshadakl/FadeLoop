import type { Env } from "../types";
import { json } from "../routes/http";
import { hashPassword, normalizeEmail, validPassword, verifyPassword } from "./password";

const COOKIE = "__Host-fadeloop_session";
const LIFETIME = 7 * 86400;
const WINDOW = 15 * 60;
export const timestamp = () => Math.floor(Date.now() / 1000);
export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
export async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
export interface OwnerSession { email: string; expires_at: number; token_hash: string; credential_version: number }

export async function getSession(req: Request, db: D1Database): Promise<OwnerSession | null> {
  const token = (req.headers.get("cookie") ?? "").split(";").map(p => p.trim()).find(p => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare(`SELECT a.email, s.expires_at, s.token_hash, s.credential_version FROM owner_sessions s
    JOIN owner_accounts a ON a.id = s.owner_id AND a.credential_version = s.credential_version
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await digest(token), timestamp()).first<OwnerSession>();
}

// Cookie credentials alone are insufficient for mutations. CLI clients send Origin explicitly.
export function sameOrigin(req: Request, navigation = false): boolean {
  const origin = new URL(req.url).origin;
  const supplied = req.headers.get("origin");
  if (supplied) return supplied === origin;
  if (!navigation) return false;
  if (req.headers.get("sec-fetch-site") === "same-origin") return true;
  try { return new URL(req.headers.get("referer") ?? "").origin === origin; } catch { return false; }
}

function cookie(token: string, age: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
}
function sessionResponse(body: unknown, token: string, age: number): Response {
  const response = json(body);
  response.headers.set("set-cookie", cookie(token, age));
  response.headers.set("cache-control", "no-store");
  return response;
}
function throttled(expires: number): Response {
  const response = json({ error: "Too many sign-in attempts. Please try again later." }, 429);
  response.headers.set("retry-after", String(Math.max(1, expires - timestamp())));
  return response;
}

export async function boundedBody(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length")) > 4096) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function handleSession(req: Request, env: Env, pathname: string): Promise<Response> {
  const method = req.method.toUpperCase();
  if (pathname === "/session" && method === "GET") {
    const session = await getSession(req, env.DB);
    return json(session ? { email: session.email, expires_at: session.expires_at } : { error: "unauthorized" }, session ? 200 : 401);
  }
  if (method !== "POST" || !["/session/login", "/session/logout", "/session/password"].includes(pathname)) return json({ error: "method not allowed" }, 405);
  if (!sameOrigin(req)) return json({ error: "Forbidden origin" }, 403);
  if (pathname === "/session/logout") {
    const session = await getSession(req, env.DB);
    if (session) await env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash = ?").bind(session.token_hash).run();
    return sessionResponse({ ok: true }, "", 0);
  }
  if (pathname === "/session/password") return changePassword(req, env);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) return json({ error: "JSON required" }, 415);
  const text = await boundedBody(req);
  if (text === null) return json({ error: "Request too large" }, 413);
  let body: { email?: unknown; password?: unknown };
  try { body = JSON.parse(text); } catch { return json({ error: "Invalid request" }, 400); }
  if (!body || typeof body.email !== "string" || body.email.length > 254) return json({ error: "Invalid email or password" }, 401);
  const email = normalizeEmail(body.email);
  const current = timestamp();
  const buckets = [await digest(`email:${email}`), await digest(`ip:${req.headers.get("cf-connecting-ip") ?? "local"}`)];
  // Reserve a slot before hashing, atomically. Concurrent requests cannot bypass the limit.
  const reservations = await env.DB.batch(buckets.map(bucket => env.DB.prepare(`INSERT INTO login_throttles (bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at <= ? OR attempts < 5`).bind(bucket, current + WINDOW, current, current, current)));
  if (reservations.some(r => r.meta.changes === 0)) {
    const blocked = await env.DB.prepare("SELECT MAX(expires_at) AS expires FROM login_throttles WHERE bucket IN (?, ?)").bind(...buckets).first<{ expires: number }>();
    return throttled(blocked?.expires ?? current + WINDOW);
  }
  if (!validPassword(body.password)) return json({ error: "Invalid email or password" }, 401);
  const owner = await env.DB.prepare("SELECT email, password_hash, credential_version FROM owner_accounts WHERE id = 1").first<{ email: string; password_hash: string; credential_version: number }>();
  // Same expensive work for unknown emails; use the real hash but do not grant access.
  const verified = owner ? await verifyPassword(body.password, owner.password_hash) : false;
  if (!owner || !verified || owner.email !== email) return json({ error: "Invalid email or password" }, 401);
  const token = randomToken();
  const expires = current + LIFETIME;
  // A concurrent operator reset cannot issue a valid session for the old credentials.
  const inserted = await env.DB.prepare(`INSERT INTO owner_sessions (token_hash, owner_id, credential_version, expires_at, created_at)
    SELECT ?, id, credential_version, ?, ? FROM owner_accounts WHERE id = 1 AND credential_version = ?`).bind(await digest(token), expires, current, owner.credential_version).run();
  if (!inserted.meta.changes) return json({ error: "Invalid email or password" }, 401);
  await env.DB.batch([
    ...buckets.map(bucket => env.DB.prepare("UPDATE login_throttles SET attempts = MAX(0, attempts - 1) WHERE bucket = ?").bind(bucket)),
    env.DB.prepare("DELETE FROM owner_sessions WHERE expires_at <= ?").bind(current),
    env.DB.prepare("DELETE FROM owner_oauth_states WHERE expires_at <= ?").bind(current),
    env.DB.prepare("DELETE FROM login_throttles WHERE expires_at <= ?").bind(current),
  ]);
  return sessionResponse({ email: owner.email, expires_at: expires }, token, LIFETIME);
}

async function changePassword(req: Request, env: Env): Promise<Response> {
  const session = await getSession(req, env.DB);
  if (!session) return json({ error: "Your session has expired. Please sign in again." }, 401);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) return json({ error: "JSON required" }, 415);
  const text = await boundedBody(req);
  if (text === null) return json({ error: "Request too large" }, 413);
  let body: { new_password?: unknown };
  try { body = JSON.parse(text); } catch { return json({ error: "Invalid request" }, 400); }
  const current = timestamp();
  const bucket = await digest("password-change:owner:1");
  const reservation = await env.DB.prepare(`INSERT INTO login_throttles (bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at <= ? OR attempts < 5`).bind(bucket, current + WINDOW, current, current, current).run();
  if (!reservation.meta.changes) {
    const blocked = await env.DB.prepare("SELECT expires_at FROM login_throttles WHERE bucket = ?").bind(bucket).first<{ expires_at: number }>();
    const response = json({ error: "Too many password-change attempts. Please try again later." }, 429);
    response.headers.set("retry-after", String(Math.max(1, (blocked?.expires_at ?? current + WINDOW) - current)));
    return response;
  }
  if (!body || !validPassword(body.new_password)) return json({ error: "Password must contain 8–128 characters." }, 400);
  const hash = await hashPassword(body.new_password);
  const mutationAt = timestamp();
  const token = randomToken();
  const tokenHash = await digest(token);
  const expires = mutationAt + LIFETIME;
  // D1 batch is transactional. All effects are conditional on this live session/version.
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE owner_accounts SET password_hash = ?, credential_version = credential_version + 1, updated_at = ?
      WHERE id = 1 AND credential_version = ? AND EXISTS (SELECT 1 FROM owner_sessions WHERE token_hash = ? AND expires_at > ?)`)
      .bind(hash, mutationAt, session.credential_version, session.token_hash, mutationAt),
    env.DB.prepare(`INSERT INTO owner_sessions (token_hash, owner_id, credential_version, expires_at, created_at)
      SELECT ?, id, credential_version, ?, ? FROM owner_accounts WHERE id = 1 AND credential_version = ?
      AND EXISTS (SELECT 1 FROM owner_sessions WHERE token_hash = ? AND expires_at > ?)`)
      .bind(tokenHash, expires, mutationAt, session.credential_version + 1, session.token_hash, mutationAt),
    env.DB.prepare("DELETE FROM owner_oauth_states WHERE EXISTS (SELECT 1 FROM owner_sessions WHERE token_hash = ?)").bind(tokenHash),
    env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash != ? AND EXISTS (SELECT 1 FROM owner_sessions WHERE token_hash = ?)").bind(tokenHash, tokenHash),
  ]);
  if (!result[0]?.meta.changes || !result[1]?.meta.changes) return json({ error: "Your session has expired. Please sign in again." }, 401);
  return sessionResponse({ email: session.email, expires_at: expires }, token, LIFETIME);
}
