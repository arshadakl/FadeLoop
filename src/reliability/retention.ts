/** Timestamp units are column-specific. Deletes are capped, including historical backlog. */
export async function cleanupRetention(db:D1Database,nowMs=Date.now(),limit=50):Promise<void>{
  const count=Math.max(1,Math.min(100,Math.floor(limit))),seconds=Math.floor(nowMs/1000);
  await db.batch([
    db.prepare(`DELETE FROM send_attempts WHERE id IN(SELECT id FROM send_attempts WHERE dispatched_at<? ORDER BY dispatched_at,id LIMIT ?)`).bind(nowMs-86400_000,count),
    db.prepare(`DELETE FROM inbound_events WHERE id IN(SELECT id FROM inbound_events WHERE status='done' AND created_at<? ORDER BY created_at,id LIMIT ?)`).bind(nowMs-7*86400_000,count),
    db.prepare(`DELETE FROM automation_audit WHERE id IN(SELECT id FROM automation_audit WHERE created_at<? ORDER BY created_at,id LIMIT ?)`).bind(nowMs-30*86400_000,count),
    // Keep compact terminal conversation state while its campaign still exists: otherwise a
    // later comment recreates NEW with an already-suppressed opening and cannot advance.
    db.prepare(`DELETE FROM conversations WHERE rowid IN(SELECT rowid FROM conversations WHERE lifecycle IN('completed','closed','failed') AND updated_at<? AND NOT EXISTS(SELECT 1 FROM campaigns p WHERE p.campaign_id=conversations.campaign_id AND p.instance_id=conversations.campaign_instance) ORDER BY updated_at LIMIT ?)`).bind(seconds-90*86400,count),
    db.prepare(`DELETE FROM events WHERE id IN(SELECT id FROM events WHERE created_at<? ORDER BY created_at,id LIMIT ?)`).bind(seconds-90*86400,count),
  ]);
}
