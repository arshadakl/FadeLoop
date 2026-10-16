import type {Env} from '../types';
import {pollIntervalSeconds} from '../runtime';

/** SQL evaluated against the current source of truth, not a cached auth snapshot.
 * Callers bind pollingEnabled followed by epoch seconds. work_tasks is the target.
 */
export const pollEligibilitySql=`(kind NOT IN ('comments','messages') OR (
  ?=1 AND EXISTS(SELECT 1 FROM auth WHERE id=1 AND expires_at>?) AND
  (kind!='comments' OR EXISTS(SELECT 1 FROM campaigns p WHERE p.media_id=work_tasks.reference AND p.active=1 AND p.archived_at IS NULL))))`;

/** Bounded metadata repair and resume, without Queue traffic per suspended object.
 * Every tick detects env configuration, credential refresh and campaign changes.
 * Eligibility guards on publication/claim protect objects outside this small page.
 */
export async function reconcilePollEligibility(env:Env,db:D1Database,generation:number,limit=4):Promise<void>{
  const enabled=pollIntervalSeconds(env)!==null?1:0,t=Date.now();
  const desired=`CASE WHEN ?=0 THEN 'polling-disabled'
    WHEN NOT EXISTS(SELECT 1 FROM auth WHERE id=1 AND expires_at>?) THEN 'credentials-expired'
    WHEN kind='comments' AND NOT EXISTS(SELECT 1 FROM campaigns p WHERE p.media_id=work_tasks.reference AND p.active=1 AND p.archived_at IS NULL) THEN 'campaign-inactive'
    ELSE NULL END`;
  // Read at most four changed rows. A no-change tick does not write eligibility.
  const rows=await db.prepare(`SELECT id,revision,${desired} reason FROM work_tasks
    WHERE generation=? AND kind IN ('comments','messages') AND status IN ('pending','leased')
      AND suspend_reason IS NOT (${desired}) ORDER BY id LIMIT ?`)
    .bind(enabled,Math.floor(t/1000),generation,enabled,Math.floor(t/1000),Math.max(1,Math.min(10,limit)))
    .all<{id:string;revision:number;reason:string|null}>();
  if(!rows.results.length)return;
  await db.batch(rows.results.map(row=>db.prepare(`UPDATE work_tasks SET suspend_reason=?,revision=revision+1,
    next_at_ms=CASE WHEN ? IS NULL THEN MIN(next_at_ms,?) ELSE next_at_ms END,
    notification_until_ms=0,updated_at_ms=? WHERE id=? AND generation=? AND revision=?`)
    .bind(row.reason,row.reason,t,t,row.id,generation,row.revision)));
}
