// Config import/export routes (power-user escape hatch, Section 7A). The UI will later write the
// same campaigns table; for the backend core these let you seed campaigns from config.json.

import { validateConfig } from "../config";
import { getActiveCampaigns, campaignUpsertStatements } from "../db";
import type { Env } from "../types";
import { json } from "./http";
import {readBoundedBytes} from './body';

/** POST /config/import — body is a full config.json (Section 7). Owner-only. */
export async function handleConfigImport(env: Env, req: Request): Promise<Response> {
  const bytes=await readBoundedBytes(req,64*1024);
  if(bytes===null)return json({error:'Configuration exceeds the 64 KiB import limit'},413);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  let cfg;
  try {
    cfg = validateConfig(payload);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const media=new Set<string>();
  for(const campaign of cfg.campaigns){if(media.has(campaign.media_id))return json({error:'Only one automation may be active per post'},409);media.add(campaign.media_id);}
  const statements=cfg.campaigns.flatMap(campaign=>campaignUpsertStatements(env.DB,campaign,true));
  if(statements.length>30)return json({error:'Import exceeds the atomic query budget; use a smaller configuration (at most 10 keyword or 6 Any comment automations)'},413);
  await env.DB.batch(statements);
  return json({ imported: cfg.campaigns.length, campaign_ids: cfg.campaigns.map((c) => c.campaign_id) });
}

/** GET /config/export — current active campaigns as a config.json payload. Owner-only. */
export async function handleConfigExport(env: Env): Promise<Response> {
  const campaigns = await getActiveCampaigns(env.DB);
  return json({ mode: env.MODE, poll_interval_seconds: Number(env.POLL_INTERVAL_SECONDS), campaigns });
}
