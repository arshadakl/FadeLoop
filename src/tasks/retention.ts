/** Run only after the task-schema migration, with a small independent work allowance.
 * Never delete unfinished or blocked evidence. Completed envelopes retain their digest
 * for seven days; clear their payload promptly to avoid retaining message text twice.
 */
export async function cleanupTaskRetention(db:D1Database,now=Date.now(),limit=25):Promise<void>{
  const count=Math.max(1,Math.min(50,Math.floor(limit)));
  await db.batch([
    db.prepare(`UPDATE ingress_batches SET raw_json='{}' WHERE id IN(
      SELECT id FROM ingress_batches WHERE status IN ('done','invalid') AND raw_json!='{}' ORDER BY updated_at_ms LIMIT ?)`)
      .bind(count),
    db.prepare(`DELETE FROM ingress_batches WHERE id IN(
      SELECT b.id FROM ingress_batches b WHERE b.status IN ('done','invalid') AND b.updated_at_ms<?
      AND NOT EXISTS(SELECT 1 FROM work_tasks w WHERE w.kind='normalize' AND w.generation=b.generation AND w.reference=b.id AND w.status!='done')
      ORDER BY b.updated_at_ms LIMIT ?)`)
      .bind(now-7*86400_000,count),
    db.prepare(`DELETE FROM work_tasks WHERE id IN(
      SELECT id FROM work_tasks WHERE status='done' AND updated_at_ms<? ORDER BY updated_at_ms LIMIT ?)`)
      .bind(now-7*86400_000,count),
  ]);
}
