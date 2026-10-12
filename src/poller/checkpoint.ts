import {InstagramApiError} from '../api/client';
export interface Checkpoint { key:string; generation:number; cursor:string|null; boundary:number; next_at:number; updated_at:number; failure_count:number; last_attempt_at:number; last_error:string|null }
export async function checkpoint(db:D1Database,key:string,generation:number):Promise<Checkpoint>{
  const row=await db.prepare('SELECT * FROM polling_checkpoints WHERE key=? AND generation=?').bind(key,generation).first<Checkpoint>();
  if(row)return row;
  const inserted=await db.prepare(`INSERT INTO polling_checkpoints(key,generation,boundary,updated_at)
    SELECT ?,?,cutover_at,0 FROM automation_control WHERE id=1 ON CONFLICT(key) DO NOTHING RETURNING *`).bind(key,generation).first<Checkpoint>();
  if(inserted)return inserted;
  const existing=await db.prepare('SELECT * FROM polling_checkpoints WHERE key=? AND generation=?').bind(key,generation).first<Checkpoint>();
  if(!existing)throw new Error('Reliability checkpoint unavailable');
  return existing;
}
/** A short read lease rotates failed objects fairly and recovers abandoned reads. */
export async function beginPoll(db:D1Database,key:string,generation:number):Promise<Checkpoint|null>{
  const t=Date.now();
  return db.prepare(`UPDATE polling_checkpoints SET last_attempt_at=?,next_at=? WHERE key=? AND generation=? AND next_at<=? RETURNING *`)
    .bind(t,t+30_000,key,generation,t).first<Checkpoint>();
}
export async function pollFailure(db:D1Database,errorKey:string,error:unknown,cp:Checkpoint):Promise<void>{
  const t=Date.now(),api=error instanceof InstagramApiError?error:null;
  const evidence=JSON.stringify({at:Math.floor(t/1000),message:api?'InstagramApiError':'Provider read failed',...(api?{code:api.code,status:api.status,trace_id:api.fbtraceId?.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,128)}:{})});
  const delay=Math.max(Math.min(30,2**Math.min(cp.failure_count,5))*60_000+Math.floor(Math.random()*30_001),(api?.retryAfterSeconds??0)*1000);
  await db.batch([
    db.prepare(`UPDATE polling_checkpoints SET failure_count=failure_count+1,last_error=?,next_at=?,
      cursor=CASE WHEN ?=1 THEN NULL ELSE cursor END WHERE key=? AND generation=? AND last_attempt_at=?`)
      .bind(evidence,t+delay,api?.status===400&&api.code===100?1:0,cp.key,cp.generation,cp.last_attempt_at),
    db.prepare(`INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind(errorKey,evidence,Math.floor(t/1000)),
  ]);
}
export function clearPollErrorStatement(db:D1Database,key:string,prefix:string):D1PreparedStatement{
  return db.prepare(`DELETE FROM kv WHERE key=? AND NOT EXISTS(SELECT 1 FROM polling_checkpoints WHERE last_error IS NOT NULL AND (substr(key,1,?)=? OR key=?))`)
    .bind(key,prefix.length,prefix,prefix==='messages:'?'conversations':'');
}
export async function readPollError(db:D1Database,key:string):Promise<{at:number;message:string}|null>{
  const row=await db.prepare('SELECT value FROM kv WHERE key=?').bind(key).first<{value:string}>();
  try{return row?.value?JSON.parse(row.value):null;}catch{return null;}
}
