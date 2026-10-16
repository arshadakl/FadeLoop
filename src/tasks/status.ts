import type {Env} from '../types';
import {json} from '../routes/http';
import {connectionGeneration,guardedConnectionDb} from '../connection';

/** Owner-only caller. Bounded pages expose retained work without reading event payloads. */
export async function taskStatus(env:Env,url:URL):Promise<Response>{
  if(env.EXECUTION_MODE!=='tasks')return json({execution_mode:'inline',tasks:[],next_cursor:null});
  const status=url.searchParams.get('status')??'blocked';
  if(!['pending','leased','blocked','done','suspended'].includes(status))return json({error:'Invalid task status'},400);
  const cursor=url.searchParams.get('cursor')??'';
  if(cursor.length>1024)return json({error:'Invalid task cursor'},400);
  const generation=await connectionGeneration(env.DB);
  const tasks=await env.DB.prepare(`SELECT id,kind,status execution_status,
    CASE WHEN suspend_reason IS NOT NULL AND status IN ('pending','leased') THEN 'suspended' ELSE status END status,
    suspend_reason,failures,next_at_ms,lease_until_ms,updated_at_ms,error
    FROM work_tasks WHERE generation=? AND ${status==='suspended'?"status IN ('pending','leased') AND suspend_reason IS NOT NULL":"status=? AND (suspend_reason IS NULL OR status IN ('blocked','done'))"}
    AND id>? ORDER BY id LIMIT 26`)
    .bind(...(status==='suspended'?[generation,cursor]:[generation,status,cursor])).all<{id:string}>();
  return json({execution_mode:'tasks',generation,tasks:tasks.results.slice(0,25),next_cursor:tasks.results.length>25?tasks.results[24]!.id:null});
}

/** Retry the scheduling unit, never reset a provider send or its evidence. */
export async function retryTask(env:Env,req:Request):Promise<Response>{
  if(env.EXECUTION_MODE!=='tasks')return json({error:'Task execution is disabled'},409);
  let body:{task_id?:unknown;connection_generation?:unknown};
  try{body=await req.json();}catch{return json({error:'Invalid JSON'},400);}
  if(!body||typeof body.task_id!=='string'||body.task_id.length>1024||!Number.isSafeInteger(body.connection_generation))return json({error:'Task ID and connection generation are required'},400);
  const generation=await connectionGeneration(env.DB);
  if(generation!==body.connection_generation)return json({error:'Instagram connection changed'},409);
  const db=guardedConnectionDb(env.DB,generation),t=Date.now();
  const result=await db.prepare(`UPDATE work_tasks SET status='pending',failures=0,error=NULL,next_at_ms=?,notification_until_ms=0,updated_at_ms=?
    WHERE id=? AND generation=? AND status='blocked' AND (kind!='dispatch' OR EXISTS(
      SELECT 1 FROM outbound_jobs j WHERE j.id=work_tasks.reference AND j.generation=work_tasks.generation AND j.status IN ('pending','held','retry_scheduled')))`)
    .bind(t,t,body.task_id,generation).run();
  if(!result.meta.changes)return json({error:'No retryable blocked task; review any uncertain send separately'},409);
  // Publication is deliberately left to the watchdog: a Queue failure cannot turn a
  // successfully committed owner action into an ambiguous API response.
  return json({ok:true});
}
