import type {NormalizedMessage} from '../../src/types';

/** Scenario helpers name the intended button; deliver its actual emitted opaque payload. */
export async function buttonPress(db:D1Database,event:NormalizedMessage):Promise<NormalizedMessage>{
  const match=/^(OPENING_TAP|FOLLOW_CONFIRM):(.+)$/.exec(event.payload??'');
  if(!match)return event;
  const job=await db.prepare(`SELECT request_json FROM outbound_jobs WHERE campaign_id=? AND recipient=? AND action=? ORDER BY created_at DESC LIMIT 1`)
    .bind(match[2],event.igsid,match[1]==='OPENING_TAP'?'opening':'follow_gate').first<{request_json:string}>();
  return job?{...event,payload:JSON.parse(job.request_json).payload}:event;
}
