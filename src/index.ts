import { ConnectionChangedError, connectionGeneration, guardedConnectionDb } from "./connection";
import { disconnectInstagram } from "./auth/disconnect";
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
  async fetch(req: Request, env: Env): Promise<Response> {
    let result: Response;
    try { result = await routeRequest(req, env); } catch (error) {
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
    if (event.cron === REFRESH_CRON) {
      const result = await refreshTokenIfDue(env);
      console.log(`[FadeLoop] token refresh: ${result.status}`);
      return;
    }
    if (event.cron === POLL_CRON) {
      const interval = pollIntervalSeconds(env);
      if (interval === null) return;
      await runPoll(env, interval);
    }
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    // --- public routes ---
    if (pathname === "/health") return json({ ok: true, mode: env.MODE });
    if (pathname === "/session" || pathname.startsWith("/session/")) return handleSession(req, env, pathname);

    // OAuth callback is publicly routable. The browser supplies its owner session cookie;
    // handleCallback verifies session-bound state and protects the existing Instagram account.
    if (pathname === "/auth/callback" && method === "GET") return handleCallback(env, url, req);

    // Webhook (only meaningful when MODE=webhook; verification is always safe to answer).
    if (pathname === "/webhook" && method === "GET") return handleWebhookVerify(env, url);
    if (pathname === "/webhook" && method === "POST") return handleWebhookEvent(env, req);

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
async function runPoll(env: Env, interval: number): Promise<void> {
  const rt = await buildRuntime(env);
  if (!rt) return;
  try { if (!await claimPollSlot(rt.db, interval)) return; } catch (e) {
    if (e instanceof ConnectionChangedError) return;
    throw e;
  }

  // Isolated so one poll can never starve the other. pollComments used to run first with no
  // guard, which meant a throw there silently skipped the message poll for that whole tick.
  try {
    await pollComments(rt, rt.db);
  } catch (e) {
    console.warn(`[FadeLoop] pollComments failed: ${e instanceof Error ? e.message : e}`);
  }
  try {
    await pollMessages(rt, rt.db);
  } catch (e) {
    console.warn(`[FadeLoop] pollMessages failed: ${e instanceof Error ? e.message : e}`);
  }
}
