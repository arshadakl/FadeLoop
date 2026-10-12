import { ConnectionChangedError, connectionGeneration, guardedConnectionDb } from "./connection";
import { disconnectInstagram } from "./auth/disconnect";
import { budgetDatabase, remainingQueries, WorkBudgetExceeded } from './reliability/budget';
// FadeLoop Worker entry point. `fetch` serves the dashboard, owner sessions and OAuth routes;
// `scheduled` runs the existing polling crons and daily Instagram token refresh.

import type { Env } from "./types";
import { buildRuntime, pollIntervalSeconds } from "./runtime";
import { pollComments } from "./poller/commentPoll";
import { pollMessages } from "./poller/messagePoll";
import { refreshTokenIfDue } from "./auth/refresh";
import { claimPollSlot } from "./db";
import { handleAuthorize, handleCallback, handleStatus } from "./routes/auth";
import { handleConfigExport, handleConfigImport } from "./routes/config";
import { handleWebhookAdmin, handleWebhookEvent, handleWebhookVerify } from "./routes/webhook";
import { handleApi } from "./routes/api";
import { json } from "./routes/http";
import { getSession, handleSession, sameOrigin } from "./auth/session";

const POLL_CRON = "* * * * *";
const REFRESH_CRON = "0 3 * * *";

export default {
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    env = {...env, DB:budgetDatabase(env.DB, 80)};
    let result: Response;
    try { result = await routeRequest(req, env, ctx); } catch (error) {
      if (String(error).includes('UNIQUE constraint failed: campaigns.media_id')) {
        const rows=await env.DB.prepare('SELECT campaign_id,media_id FROM campaigns WHERE active=1 AND archived_at IS NULL').all();
        return json({error:'Only one automation may be active per post',conflicts:rows.results},409);
      }
      if(error instanceof WorkBudgetExceeded)return json({error:'Work retained; retry request'},503);
      if (!(error instanceof ConnectionChangedError)) throw error;
      result = json({ error: error.message }, 409);
    }
    // Asset fetch responses have immutable headers in workerd.
    const response = new Response(result.body, result);
    const path = new URL(req.url).pathname;
    if (/^\/(api|auth|session|config|admin)(\/|$)/.test(path)) response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    if (!response.headers.has("referrer-policy")) response.headers.set("referrer-policy", "same-origin");
    return response;
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    env = {...env,DB:budgetDatabase(env.DB, 80)};
    if (event.cron === REFRESH_CRON) {
      const result = await refreshTokenIfDue(env);
      console.log(`[FadeLoop] token refresh: ${result.status}`);
      // Nightly maintenance retention sweep: prune old rate limit attempts and completed events
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM send_attempts WHERE dispatched_at < ?").bind(nowSec - 86400),
          env.DB.prepare("DELETE FROM inbound_events WHERE status = 'done' AND created_at < ?").bind(nowSec - 7 * 86400),
          env.DB.prepare("DELETE FROM automation_audit WHERE created_at < ?").bind((nowSec - 30 * 86400) * 1000),
          env.DB.prepare("DELETE FROM conversations WHERE lifecycle IN ('completed', 'closed', 'failed') AND updated_at < ?").bind(nowSec - 90 * 86400),
          env.DB.prepare("DELETE FROM events WHERE created_at < ?").bind(nowSec - 90 * 86400),
        ]);
        console.log("[FadeLoop] nightly retention cleanup completed");
      } catch (err) {
        console.warn(`[FadeLoop] nightly retention cleanup failed: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }
    if (event.cron === POLL_CRON) {
      const interval = pollIntervalSeconds(env);
      await runPoll(env, interval);
    }
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    // --- public routes ---
    if (pathname === "/health") return json({ ok: true, mode: env.MODE });
    if (pathname === "/session" || pathname.startsWith("/session/")) return handleSession(req, env, pathname);

    // OAuth callback is publicly routable. The browser supplies its owner session cookie;
    // handleCallback verifies session-bound state and protects the existing Instagram account.
    if (pathname === "/auth/callback" && method === "GET") return handleCallback(env, url, req);

    // Webhooks ingest in both modes; MODE only controls reconciliation polling.
    if (pathname === "/webhook" && method === "GET") return handleWebhookVerify(env, url);
    if (pathname === "/webhook" && method === "POST") return handleWebhookEvent(env, req, ctx);

    // --- owner-only API + admin routes ---
    if (pathname.startsWith("/api/")) {
      if (!await getSession(req, env.DB)) return json({ error: "unauthorized" }, 401);
      if (!["GET", "HEAD"].includes(method) && !sameOrigin(req)) return json({ error: "Forbidden origin" }, 403);
      const scoped = ["GET", "HEAD"].includes(method) ? env : { ...env, DB: guardedConnectionDb(env.DB, await connectionGeneration(env.DB)) };
      return handleApi(scoped, req, url);
    }
    const ownerRoutes = new Set([
      "/auth/authorize",
      "/auth/status",
      "/auth/disconnect",
      "/config/import",
      "/config/export",
      "/admin/poll",
      "/admin/webhook",
    ]);
    if (ownerRoutes.has(pathname)) {
      const session = await getSession(req, env.DB);
      if (!session) return json({ error: "unauthorized" }, 401);
      if ((!["GET", "HEAD"].includes(method) || pathname === "/auth/authorize") && !sameOrigin(req, pathname === "/auth/authorize")) return json({ error: "Forbidden origin" }, 403);
      if (pathname === "/auth/authorize" && method === "GET") return handleAuthorize(env, session);
      if (pathname === "/auth/status" && method === "GET") return handleStatus(env);
      if (pathname === "/auth/disconnect" && method === "POST") return disconnectInstagram(req, env);
      if (pathname === "/config/import" && method === "POST") return handleConfigImport({ ...env, DB: guardedConnectionDb(env.DB, await connectionGeneration(env.DB)) }, req);
      if (pathname === "/config/export" && method === "GET") return handleConfigExport(env);
      // Manual poll trigger for testing without waiting for cron.
      if (pathname === "/admin/poll" && method === "POST") {
        await runPoll(env, pollIntervalSeconds(env) ?? 30);
        return json({ ok: true, ran: "poll" });
      }
      // Webhook subscription status / retry (see handleWebhookAdmin).
      if (pathname === "/admin/webhook" && (method === "GET" || method === "POST")) {
        return handleWebhookAdmin(env, method);
      }
      return json({ error: "method not allowed" }, 405);
    }

    // --- web UI (static assets + SPA fallback) ---
    // Matched static files are served by the assets binding automatically; this handles
    // client-side routes by returning index.html for navigations.
    const assetRes = await env.ASSETS.fetch(req);
    if (assetRes.status !== 404) return assetRes;
    if (method === "GET") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), req));
    }
    return json({ error: "not found" }, 404);
}

/**
 * Run comment + message polls, honoring the caller's poll interval (>= cron granularity).
 * claimPollSlot is an atomic claim, not a plain check-then-act read/write — see its doc comment
 * in db.ts for why that distinction matters: it's what stops an overlapping cron tick or a
 * /admin/poll call racing the cron from both polling at once and double-sending a real DM.
 */
async function runPoll(env: Env, interval: number | null): Promise<void> {
  const rt = await buildRuntime(env,true);
  if (!rt) return;
  if(rt.auth.expires_at<=Math.floor(Date.now()/1000)){await rt.engine.drain();return;}
  if(interval===null){await rt.engine.drain();return;}
  try { if (!await claimPollSlot(rt.db, interval)) { await rt.engine.drain(); return; } } catch (e) {
    if (e instanceof ConnectionChangedError) return;
    throw e;
  }

  // Drain pending outbox jobs before polling
  await rt.engine.drain();
  if(remainingQueries(env.DB)<10)return;
  // Isolated so one poll can never starve the other. pollComments used to run first with no
  // guard, which meant a throw there silently skipped the message poll for that whole tick.
  try {
    await pollComments(rt, rt.db);
  } catch (e) {
    console.warn(`[FadeLoop] pollComments failed: ${e instanceof Error ? e.message : e}`);
  }
  try {
    if(remainingQueries(env.DB)>=10)await pollMessages(rt, rt.db);
  } catch (e) {
    console.warn(`[FadeLoop] pollMessages failed: ${e instanceof Error ? e.message : e}`);
  }
  await rt.engine.drain();
}
