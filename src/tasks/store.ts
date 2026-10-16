import type {Env} from '../types';
import {pollEligibilitySql} from './eligibility';
import {pollIntervalSeconds} from '../runtime';

export type TaskKind='normalize'|'plan'|'dispatch'|'comments'|'messages';
export interface Task {id:string;generation:number;kind:TaskKind;reference:string;revision:number;lease_token:string;next_at_ms:number;failures:number}
export interface Notification {schema:1;taskId:string;generation:number}
export const taskId=(kind:TaskKind,generation:number,reference:string)=>`${kind}:${generation}:${reference}`;
export function taskStatement(db:D1Database,kind:TaskKind,generation:number,reference:string,nextAt=0):D1PreparedStatement{
  return db.prepare(`INSERT INTO work_tasks(id,generation,kind,reference,next_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET revision=work_tasks.revision+1,
    status=CASE WHEN work_tasks.status='leased' THEN 'leased' ELSE 'pending' END,
    next_at_ms=MIN(work_tasks.next_at_ms,excluded.next_at_ms),updated_at_ms=excluded.updated_at_ms,error=NULL`)
    .bind(taskId(kind,generation,reference),generation,kind,reference,nextAt,Date.now());
}
/** A short notification lease bridges D1 and Queue without pretending they share a transaction. */
export async function publishTasks(env:Env,db:D1Database,generation:number,limit=2):Promise<number>{
  if(!env.WORK_QUEUE||!env.SEND_QUEUE)throw new Error('Configure both WORK_QUEUE and SEND_QUEUE before enabling task execution');
  const t=Date.now(),owner=crypto.randomUUID();
  const result=await db.prepare(`UPDATE work_tasks SET notification_token=?,notification_until_ms=? WHERE id IN(
    SELECT id FROM work_tasks WHERE generation=? AND status='pending' AND suspend_reason IS NULL AND next_at_ms<=? AND notification_until_ms<=?
    AND ${pollEligibilitySql}
    ORDER BY next_at_ms,updated_at_ms,id LIMIT ?) RETURNING id,generation,kind,reference,revision`)
    .bind(owner,t+90_000,generation,t,t,pollIntervalSeconds(env)!==null?1:0,Math.floor(t/1000),Math.max(1,Math.min(4,limit))).all<Task>();
  let sent=0;
  for(const task of result.results){
    try{await (task.kind==='dispatch'?env.SEND_QUEUE:env.WORK_QUEUE).send({schema:1,taskId:task.id,generation});sent++;}
    catch{await db.prepare('UPDATE work_tasks SET notification_until_ms=?,error=? WHERE id=? AND notification_token=?')
      .bind(t+60_000,'Task notification unavailable; durable intent retained',task.id,owner).run();}
  }
  return sent;
}
export async function claimTask(db:D1Database,id:string,generation:number,pollingEnabled=true):Promise<Task|null>{
  const t=Date.now(),owner=crypto.randomUUID();
  return db.prepare(`UPDATE work_tasks SET status='leased',lease_token=?,lease_until_ms=?,updated_at_ms=?
    WHERE id=? AND generation=? AND suspend_reason IS NULL AND next_at_ms<=? AND (status='pending' OR(status='leased' AND lease_until_ms<?))
    AND ${pollEligibilitySql} RETURNING *`)
    .bind(owner,t+45_000,t,id,generation,t,t,pollingEnabled?1:0,Math.floor(t/1000)).first<Task>();
}
export async function settleTask(db:D1Database,task:Task,nextAt?:number):Promise<void>{
  const t=Date.now();
  // A new revision arriving under the lease is never marked done by this older execution.
  await db.prepare(`UPDATE work_tasks SET status=CASE WHEN revision!=? OR ? IS NOT NULL THEN 'pending' ELSE 'done' END,
    next_at_ms=CASE WHEN revision!=? THEN MIN(next_at_ms,?) ELSE COALESCE(?,next_at_ms) END,
    lease_token=NULL,lease_until_ms=0,notification_until_ms=0,failures=0,error=NULL,updated_at_ms=? WHERE id=? AND lease_token=?`)
    .bind(task.revision,nextAt??null,task.revision,t,nextAt??null,t,task.id,task.lease_token).run();
}
export async function deferTask(db:D1Database,task:Task,error='Task deferred; durable work retained'):Promise<void>{
  const delay=Math.min(30*60_000,60_000*2**Math.min(task.failures,5));
  await db.prepare(`UPDATE work_tasks SET status=CASE WHEN failures>=4 THEN 'blocked' ELSE 'pending' END,next_at_ms=?,lease_token=NULL,lease_until_ms=0,
    notification_until_ms=0,failures=failures+1,error=?,updated_at_ms=? WHERE id=? AND lease_token=?`)
    .bind(Date.now()+delay,error,Date.now(),task.id,task.lease_token).run();
}
