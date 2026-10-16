import type {Env} from '../types';
import type {Runtime} from '../runtime';
import {guardedConnectionDb} from '../connection';
import type {Task} from './store';
import {normalizeWebhook} from '../engine/normalize';

export async function persistEnvelope(env:Env,generation:number,raw:string):Promise<void>{
  if(!env.WORK_QUEUE||!env.SEND_QUEUE)throw new Error('Task queues are not configured');
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${generation}:webhook:${raw}`));
  const id=Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join(''),db=guardedConnectionDb(env.DB,generation),t=Date.now();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO ingress_batches(id,generation,source,raw_json,created_at_ms,updated_at_ms) VALUES(?,?,'webhook',?,?,?)").bind(id,generation,raw,t,t),
    db.prepare(`INSERT OR IGNORE INTO work_tasks(id,generation,kind,reference,updated_at_ms)
      SELECT 'normalize:'||generation||':'||id,generation,'normalize',id,? FROM ingress_batches WHERE id=? AND status='pending'`).bind(t,id),
  ]);
}

/** SQL returns a small deterministic slice; the Worker never parses a whole large envelope. */
export async function normalizeEnvelope(rt:Runtime,task:Task):Promise<number|undefined>{
  const db=rt.db,batch=await db.prepare('SELECT status,position,json_valid(raw_json) valid FROM ingress_batches WHERE id=? AND generation=?')
    .bind(task.reference,task.generation).first<{status:string;position:number;valid:number}>();
  if(!batch||batch.status==='done')return;
  if(!batch.valid){await db.prepare("UPDATE ingress_batches SET status='invalid',raw_json='{}',updated_at_ms=? WHERE id=?").bind(Date.now(),task.reference).run();return;}
  const rows=await db.prepare(`WITH parts AS(
    SELECT CAST(e.key AS INTEGER) entry_index,0 kind,CAST(c.key AS INTEGER) part_index,json_object('entry',json_array(json_object('changes',json_array(json(c.value))))) fragment
    FROM ingress_batches b,json_each(CASE WHEN json_type(b.raw_json,'$.entry')='array' THEN json_extract(b.raw_json,'$.entry') ELSE '[]' END) e,
      json_each(CASE WHEN e.type='object' THEN CASE WHEN json_type(e.value,'$.changes')='array' THEN json_extract(e.value,'$.changes') ELSE '[]' END ELSE '[]' END) c WHERE b.id=? AND c.type='object'
    UNION ALL
    SELECT CAST(e.key AS INTEGER),1,CAST(m.key AS INTEGER),json_object('entry',json_array(json_object('messaging',json_array(json(m.value)))))
    FROM ingress_batches b,json_each(CASE WHEN json_type(b.raw_json,'$.entry')='array' THEN json_extract(b.raw_json,'$.entry') ELSE '[]' END) e,
      json_each(CASE WHEN e.type='object' THEN CASE WHEN json_type(e.value,'$.messaging')='array' THEN json_extract(e.value,'$.messaging') ELSE '[]' END ELSE '[]' END) m WHERE b.id=? AND m.type='object'
  ) SELECT fragment FROM parts ORDER BY entry_index,kind,part_index LIMIT 10 OFFSET ?`)
    .bind(task.reference,task.reference,batch.position).all<{fragment:string}>();
  let consumed=0,chars=0;
  const events=[];
  for(const row of rows.results){
    // One legitimate large event receives its own bounded (raw-envelope-ceiling) unit.
    if(consumed&&chars+row.fragment.length>16*1024)break;
    chars+=row.fragment.length;consumed++;
    events.push(...normalizeWebhook(JSON.parse(row.fragment),rt.igUserId));
  }
  // ingest and the position update share one outer D1 transaction through checkpoint-style extra statements.
  await rt.engine.ingest(events,'webhook',undefined,[db.prepare(`UPDATE ingress_batches SET position=?,status=?,updated_at_ms=? WHERE id=? AND generation=? AND position=?`)
    .bind(batch.position+consumed,rows.results.length<10&&consumed===rows.results.length?'done':'pending',Date.now(),task.reference,task.generation,batch.position)]);
  return rows.results.length<10&&consumed===rows.results.length?undefined:Date.now();
}
