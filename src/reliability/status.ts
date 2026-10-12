import {buildRuntime} from '../runtime';
import type {Env} from '../types';
import type {OutboundJob} from '../engine/engine';
import {json} from '../routes/http';
import {getAuth} from '../db';
import {pollIntervalSeconds} from '../runtime';
import {terminalConversation} from './conversation';
export async function automationStatus(db:D1Database){
  return db.prepare(`SELECT c.enabled,c.hold_reason,c.build_revision,
    (SELECT COUNT(*) FROM inbound_events WHERE status!='done') pending_events,
    (SELECT MIN(created_at) FROM inbound_events WHERE status!='done') oldest_event_at,
    (SELECT MAX(created_at) FROM inbound_events) last_ingested_at,
    (SELECT COUNT(*) FROM outbound_jobs WHERE status IN ('pending','held','retry_scheduled','sending')) pending_jobs,
    (SELECT MIN(created_at) FROM outbound_jobs WHERE status IN ('pending','held','retry_scheduled','sending')) oldest_pending_at,
    (SELECT COUNT(*) FROM outbound_jobs WHERE status='unknown') unknown_jobs,
    (SELECT COUNT(*) FROM outbound_jobs WHERE status='rejected') rejected_jobs,
    (SELECT COUNT(*) FROM outbound_jobs WHERE status='confirmed') confirmed_jobs,
    (SELECT COUNT(*) FROM conversations WHERE lifecycle='failed') failed_conversations,
    (SELECT COUNT(*) FROM conversations WHERE lifecycle='closed') closed_conversations,
    (SELECT COUNT(*) FROM send_attempts) attempts,
    (SELECT COUNT(DISTINCT recipient) FROM outbound_jobs WHERE status='unknown') recipient_holds,
    (SELECT COUNT(*) FROM campaign_conflicts f JOIN campaigns p USING(campaign_id) WHERE p.active=0) campaign_conflicts
    FROM automation_control c WHERE id=1`).first();
}
export async function handleAutomation(env:Env,req:Request,url:URL):Promise<Response>{
  if(req.method==='GET'&&url.pathname==='/api/automation'){
    const offset=Math.max(0,Math.min(1000000,Number(url.searchParams.get('offset'))||0));
    const jobs=await env.DB.prepare(`SELECT j.id,j.campaign_id,j.recipient,j.action,j.status,j.attempts,j.error,j.error_code,j.trace_id,j.provider_id,j.created_at,j.updated_at,j.resolution_source,
      CASE WHEN j.status IN ('pending','retry_scheduled','held') AND (p.active=0 OR p.archived_at IS NOT NULL) THEN 1 ELSE 0 END campaign_suspended,
      CASE WHEN j.status='unknown' OR (j.status='held' AND j.error='Legacy retry deadline requires owner review') THEN 1 ELSE 0 END can_close_unresolved
      FROM outbound_jobs j LEFT JOIN campaigns p ON p.instance_id=j.campaign_instance
      WHERE j.status IN ('unknown','rejected','held') OR (j.status IN ('pending','retry_scheduled') AND (p.active=0 OR p.archived_at IS NOT NULL))
      ORDER BY CASE j.status WHEN 'unknown' THEN 0 ELSE 1 END,j.updated_at DESC,j.id LIMIT 101 OFFSET ?`).bind(offset).all();
    const conflicts=await env.DB.prepare('SELECT f.campaign_id,f.media_id FROM campaign_conflicts f JOIN campaigns p USING(campaign_id) WHERE p.active=0').all();
    const auth=await getAuth(env.DB);
    const poll=await env.DB.prepare("SELECT key,value FROM kv WHERE key IN ('last_msg_poll_ts','last_comment_poll_ts','last_msg_poll_error','last_comment_poll_error')").all<{key:string;value:string}>();
    const pollFailures=await env.DB.prepare(`SELECT key,failure_count,last_attempt_at,next_at,last_error FROM polling_checkpoints WHERE last_error IS NOT NULL ORDER BY last_attempt_at DESC LIMIT 100`).all();
    return json({status:await automationStatus(env.DB),jobs:jobs.results.slice(0,100),next_offset:jobs.results.length>100?offset+100:null,conflicts:conflicts.results,maintenance:env.AUTOMATION_MAINTENANCE==='true',
      health:{connected:!!auth,token_expired:!!auth && auth.expires_at<=Math.floor(Date.now()/1000),generation:auth?.connection_generation??null,polling_enabled:pollIntervalSeconds(env)!==null,poll:Object.fromEntries(poll.results.map(row=>[row.key,row.value])),poll_failures:pollFailures.results},build_revision:env.BUILD_REVISION??'reliability-v2'});
  }
  if(req.method!=='POST')return json({error:'method not allowed'},405);
  let body:Record<string,unknown>;try{body=await req.json() as Record<string,unknown>;}catch{return json({error:'Invalid JSON'},400);}
  if(!body||typeof body!=='object')return json({error:'Invalid request'},400);
  if(url.pathname==='/api/automation/control'){
    if(typeof body.enabled!=='boolean')return json({error:'enabled must be boolean'},400);
    if(body.enabled){
      if(env.AUTOMATION_MAINTENANCE==='true')return json({error:'Exit deployment maintenance before enabling sending'},409);
      if(body.verified!==true)return json({error:'Complete the cutover and provider contract checks before enabling sending'},400);
      const rt=await buildRuntime(env);if(!rt)return json({error:'Connect Instagram first'},409);
      const unsafe=await env.DB.prepare(`SELECT 1 FROM outbound_jobs WHERE status='unknown' UNION ALL SELECT 1 FROM campaign_conflicts f JOIN campaigns p USING(campaign_id) WHERE p.active=0 LIMIT 1`).first();
      if(unsafe)return json({error:'Review uncertain sends and resolve campaign conflicts first'},409);
      const result=await env.DB.batch([
        env.DB.prepare(`UPDATE automation_control SET enabled=1,hold_reason=NULL WHERE id=1 AND COALESCE(hold_reason,'')!='Instagram authorization requires attention'
          AND NOT EXISTS(SELECT 1 FROM outbound_jobs WHERE status='unknown') AND NOT EXISTS(SELECT 1 FROM campaign_conflicts f JOIN campaigns p USING(campaign_id) WHERE p.active=0)`),
        env.DB.prepare("INSERT INTO automation_audit(id,action,created_at) SELECT ?,'sending_enabled_after_owner_verification',? FROM automation_control WHERE id=1 AND enabled=1 AND hold_reason IS NULL").bind(crypto.randomUUID(),Date.now()),
      ]);
      if(!result[0]?.meta.changes)return json({error:'Reconnect Instagram to clear authorization failures, and review all uncertain outcomes'},409);
    }else await env.DB.batch([
      env.DB.prepare('UPDATE automation_control SET enabled=0 WHERE id=1'),
      env.DB.prepare("INSERT INTO automation_audit(id,action,created_at) VALUES(?,'sending_disabled',?)").bind(crypto.randomUUID(),Date.now()),
    ]);
    return json({ok:true});
  }
  if(url.pathname==='/api/automation/resolve'){
    if(typeof body.job_id!=='string'||!['confirm_received','close_unresolved'].includes(String(body.action)))return json({error:'Choose a job and resolution'},400);
    const job=await env.DB.prepare("SELECT * FROM outbound_jobs WHERE id=? AND (status='unknown' OR (status='held' AND error='Legacy retry deadline requires owner review'))").bind(body.job_id).first<OutboundJob>();
    if(!job)return json({error:'Unknown send not found'},404);
    if(body.action==='confirm_received'){
      if(job.status!=='unknown')return json({error:'Only uncertain sends may be confirmed received'},409);
      const rt=await buildRuntime(env);if(!rt)return json({error:'Reconnect Instagram before resolving a send'},409);
      await rt.engine.confirm(job,job.owner_token,'owner');
    }else await env.DB.batch([
      env.DB.prepare("UPDATE outbound_jobs SET status='cancelled',resolution_source='owner_closed_unresolved',resolved_at=?,updated_at=? WHERE id=? AND status=? AND owner_token IS ?").bind(Date.now(),Date.now(),job.id,job.status,job.owner_token),
      terminalConversation(env.DB,job,'cancelled','owner_closed_unresolved',Date.now()),
      env.DB.prepare("INSERT OR IGNORE INTO automation_audit(id,job_id,action,created_at) SELECT ?,id,'close_unresolved',? FROM outbound_jobs WHERE id=? AND resolution_source='owner_closed_unresolved'").bind(`close_unresolved:${job.id}`,Date.now(),job.id),
    ]);
    return json({ok:true});
  }
  return json({error:'not found'},404);
}
