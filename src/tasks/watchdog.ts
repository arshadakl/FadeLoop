import type {Env} from '../types';
import {buildRuntime,pollIntervalSeconds} from '../runtime';
import {publishTasks,taskStatement} from './store';
import {claimPollSlot} from '../db';
import {cleanupTaskRetention} from './retention';

/** Bounded repair. D1 is the long-lived queue; transport expiry cannot erase accepted work. */
export async function taskWatchdog(env:Env):Promise<void>{
  if(!env.WORK_QUEUE||!env.SEND_QUEUE)throw new Error('Task execution requires WORK_QUEUE and SEND_QUEUE');
  const rt=await buildRuntime(env,true);if(!rt)return;
  const db=rt.db,generation=rt.auth.connection_generation,t=Date.now();
  await db.batch([
    db.prepare(`UPDATE work_tasks SET status='pending',lease_token=NULL,lease_until_ms=0,notification_until_ms=0 WHERE id IN(
      SELECT id FROM work_tasks WHERE generation=? AND status='leased' AND lease_until_ms<? LIMIT 4)`).bind(generation,t),
    // Never convert an abandoned authorized attempt back to runnable pending.
    db.prepare(`UPDATE outbound_jobs SET status='unknown',error='Worker ended after dispatch authorization',updated_at=? WHERE id IN(
      SELECT id FROM outbound_jobs WHERE generation=? AND status='sending' AND dispatch_at<? LIMIT 4)`).bind(t,generation,t-60_000),
    db.prepare(`UPDATE automation_control SET hold_reason='Repeated uncertain send outcomes' WHERE id=1 AND hold_reason IS NULL AND
      (SELECT COUNT(*) FROM outbound_jobs WHERE generation=? AND status='unknown' AND updated_at>=?)>=3`).bind(generation,t-600_000),
  ]);
  // Seed pre-cutover durable work in tiny batches. Existing intents are never reset by recovery.
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO work_tasks(id,generation,kind,reference,next_at_ms,updated_at_ms)
      SELECT 'plan:'||e.generation||':'||e.id,e.generation,'plan',e.id,e.next_at,? FROM inbound_events e
      WHERE e.generation=? AND e.status!='done' AND NOT EXISTS(SELECT 1 FROM work_tasks w WHERE w.id='plan:'||e.generation||':'||e.id) ORDER BY e.id LIMIT 4`).bind(t,generation),
    db.prepare(`INSERT OR IGNORE INTO work_tasks(id,generation,kind,reference,next_at_ms,updated_at_ms)
      SELECT 'dispatch:'||j.generation||':'||j.id,j.generation,'dispatch',j.id,j.next_at,? FROM outbound_jobs j
      WHERE j.generation=? AND j.status IN('pending','held','retry_scheduled') AND NOT EXISTS(SELECT 1 FROM work_tasks w WHERE w.id='dispatch:'||j.generation||':'||j.id) ORDER BY j.id LIMIT 4`).bind(t,generation),
  ]);
  const interval=pollIntervalSeconds(env);
  if(interval!==null&&rt.auth.expires_at>Math.floor(t/1000)&&await claimPollSlot(db,interval)){
    const media=await db.prepare(`SELECT p.media_id FROM campaigns p WHERE p.active=1 AND p.archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM work_tasks w WHERE w.id='comments:'||?||':'||p.media_id) ORDER BY p.media_id LIMIT 2`).bind(generation).all<{media_id:string}>();
    await db.batch([
      ...media.results.map(row=>taskStatement(db,'comments',generation,row.media_id)),
      db.prepare(`INSERT OR IGNORE INTO work_tasks(id,generation,kind,reference,updated_at_ms) VALUES(?,?,'messages','conversations',?)`).bind(`messages:${generation}:conversations`,generation,t),
    ]);
  }
  await publishTasks(env,db,generation,2);
  await cleanupTaskRetention(db,t);
}
