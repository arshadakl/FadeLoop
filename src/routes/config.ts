// Config import/export routes (power-user escape hatch, Section 7A). The UI will later write the
// same campaigns table; for the backend core these let you seed campaigns from config.json.

import { validateConfig } from "../config";
import { getActiveCampaigns, upsertCampaign } from "../db";
import type { Env } from "../types";
import { json } from "./http";

/** POST /config/import — body is a full config.json (Section 7). Owner-only. */
export async function handleConfigImport(env: Env, req: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  let cfg;
  try {
    cfg = validateConfig(payload);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  for (const campaign of cfg.campaigns) {
    await upsertCampaign(env.DB, campaign, true);
  }
  return json({ imported: cfg.campaigns.length, campaign_ids: cfg.campaigns.map((c) => c.campaign_id) });
}

/** GET /config/export — current active campaigns as a config.json payload. Owner-only. */
export async function handleConfigExport(env: Env): Promise<Response> {
  const campaigns = await getActiveCampaigns(env.DB);
  return json({ mode: env.MODE, poll_interval_seconds: Number(env.POLL_INTERVAL_SECONDS), campaigns });
}
