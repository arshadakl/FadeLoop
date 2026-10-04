import type { Env } from "../types";
import { boundedBody, digest, getSession, sameOrigin, timestamp } from "./session";
import { validPassword, verifyPassword } from "./password";
import { connectionGeneration } from "../connection";
import { json } from "../routes/http";

export async function disconnectInstagram(req: Request, env: Env): Promise<Response> {
  const session = await getSession(req, env.DB);
  if (!session) return json({ error: "Your session has expired. Please sign in again." }, 401);
  if (!sameOrigin(req)) return json({ error: "Forbidden origin" }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) return json({ error: "JSON required" }, 415);
  const text = await boundedBody(req);
  if (text === null) return json({ error: "Request too large" }, 413);
  let body: { password?: unknown; connection_generation?: unknown };
  try { body = JSON.parse(text); } catch { return json({ error: "Invalid request" }, 400); }
  if (!body || !Number.isSafeInteger(body.connection_generation) || Number(body.connection_generation) < 0) return json({ error: "Connection generation is required" }, 400);
  const generation = Number(body.connection_generation);
  const current = timestamp();
  const bucket = await digest("instagram-disconnect:owner:1");
  const reserved = await env.DB.prepare(`INSERT INTO login_throttles (bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at <= ? OR attempts < 5`).bind(bucket, current + 900, current, current, current).run();
  if (!reserved.meta.changes) {
    const row = await env.DB.prepare("SELECT expires_at FROM login_throttles WHERE bucket = ?").bind(bucket).first<{ expires_at: number }>();
    const response = json({ error: "Too many disconnect attempts. Please try again later." }, 429);
    response.headers.set("retry-after", String(Math.max(1, (row?.expires_at ?? current + 900) - current)));
    return response;
  }
  const owner = await env.DB.prepare("SELECT password_hash, credential_version FROM owner_accounts WHERE id = 1").first<{ password_hash: string; credential_version: number }>();
  if (!validPassword(body.password) || !owner || !await verifyPassword(body.password, owner.password_hash)) return json({ error: "Incorrect FadeLoop login password." }, 403);
  if (owner.credential_version !== session.credential_version || !await getSession(req, env.DB)) return json({ error: "Your session has expired. Please sign in again." }, 401);
  const liveGeneration = await connectionGeneration(env.DB);
  const connected = await env.DB.prepare("SELECT id FROM auth WHERE id = 1").first();
  if (!connected && liveGeneration === generation + 1) return json({ disconnected: true, deleted: true });
  if (!connected || liveGeneration !== generation) return json({ error: "Instagram connection changed. Refresh before disconnecting." }, 409);
  try {
    await env.DB.batch([
      // Reject stale sessions and stale connections inside the same transaction as every delete.
      env.DB.prepare(`UPDATE instagram_connection_state SET generation = CASE WHEN generation = ?
        AND EXISTS (SELECT 1 FROM auth WHERE id = 1)
        AND EXISTS (SELECT 1 FROM owner_sessions s JOIN owner_accounts a ON a.id = s.owner_id
          AND a.credential_version = s.credential_version WHERE s.token_hash = ? AND s.credential_version = ?
          AND s.expires_at > CAST(strftime('%s', 'now') AS INTEGER))
        THEN generation + 1 ELSE -1 END WHERE id = 1`).bind(generation, session.token_hash, session.credential_version),
      ...["campaign_folders", "campaign_trigger_activation", "conversations", "events", "processed_comments", "comment_actions", "send_claims", "campaigns", "automation_folders", "owner_oauth_states", "kv", "auth"].map(table => env.DB.prepare(`DELETE FROM ${table}`)),
    ]);
  } catch {
    if (!await getSession(req, env.DB)) return json({ error: "Your session has expired. Please sign in again." }, 401);
    const after = await connectionGeneration(env.DB);
    if (after !== generation) {
      const auth = await env.DB.prepare("SELECT id FROM auth WHERE id = 1").first();
      if (!auth && after === generation + 1) return json({ disconnected: true, deleted: true });
      return json({ error: "Instagram connection changed. Refresh before disconnecting." }, 409);
    }
    return json({ error: "Disconnect could not be completed. Your workspace was preserved. Try again." }, 500);
  }
  return json({ disconnected: true, deleted: true });
}
