import type { Env } from "../types";
import { json } from "./http";

export async function validFolder(db: D1Database, id: unknown): Promise<boolean> {
  return id === null || (typeof id === "string" && !!await db.prepare("SELECT 1 FROM automation_folders WHERE folder_id = ?").bind(id).first());
}

export async function moveCampaigns(db: D1Database, ids: string[], folder: string | null): Promise<void> {
  // JSON expansion keeps bulk operations below D1's 100 bound-parameter limit.
  const selected = "SELECT value FROM json_each(?)";
  if (folder === null) {
    await db.prepare(`DELETE FROM campaign_folders WHERE campaign_id IN (${selected})`).bind(JSON.stringify(ids)).run();
  } else {
    await db.prepare(`INSERT INTO campaign_folders (campaign_id, folder_id) SELECT campaign_id, ? FROM campaigns WHERE campaign_id IN (${selected})
      ON CONFLICT(campaign_id) DO UPDATE SET folder_id = excluded.folder_id`).bind(folder, JSON.stringify(ids)).run();
  }
}

export async function folders(env: Env, req: Request, path: string): Promise<Response> {
  if (req.method === "GET" && path === "/api/folders") {
    const result = await env.DB.prepare("SELECT folder_id, name FROM automation_folders ORDER BY lower(name), folder_id").all();
    return json({ folders: result.results });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "Invalid request" }, 400);
  if (path === "/api/folders/move") {
    const ids = body.campaign_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 200)) return json({ error: "Select between 1 and 100 automations" }, 400);
    if (!await validFolder(env.DB, body.folder_id)) return json({ error: "Folder not found" }, 404);
    const found = await env.DB.prepare("SELECT campaign_id FROM campaigns WHERE campaign_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all();
    if (found.results.length !== new Set(ids).size) return json({ error: "Automation not found" }, 404);
    await moveCampaigns(env.DB, ids, body.folder_id as string | null);
    return json({ ok: true });
  }
  if (!["/api/folders", "/api/folders/rename", "/api/folders/delete"].includes(path)) return json({ error: "not found" }, 404);
  if (path !== "/api/folders" && (typeof body.folder_id !== "string" || !await validFolder(env.DB, body.folder_id))) return json({ error: "Folder not found" }, 404);
  if (path === "/api/folders/delete") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM campaign_folders WHERE folder_id = ?").bind(body.folder_id),
      env.DB.prepare("DELETE FROM automation_folders WHERE folder_id = ?").bind(body.folder_id),
    ]);
    return json({ ok: true });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) return json({ error: "Folder name must contain 1–80 characters" }, 400);
  const id = path === "/api/folders" ? crypto.randomUUID() : body.folder_id;
  try {
    if (path === "/api/folders") await env.DB.prepare("INSERT INTO automation_folders (folder_id, name, created_at) VALUES (?, ?, ?)").bind(id, name, Math.floor(Date.now() / 1000)).run();
    else await env.DB.prepare("UPDATE automation_folders SET name = ? WHERE folder_id = ?").bind(name, id).run();
  } catch (error) {
    if (/unique/i.test(String(error))) return json({ error: "A folder with that name already exists" }, 409);
    throw error;
  }
  return json({ ok: true, folder_id: id });
}
