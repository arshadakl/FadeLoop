import type {OutboundJob} from '../engine/engine';

/** Must share the job resolution transaction; stale jobs cannot close newer progress. */
export function terminalConversation(db:D1Database,job:OutboundJob,status:'rejected'|'cancelled',reason:string,t:number):D1PreparedStatement{
  return db.prepare(`UPDATE conversations SET lifecycle=?,terminal_job_id=?,terminal_reason=?,pending_job_id=NULL,
    version=version+1,updated_at=? WHERE campaign_id=? AND campaign_instance=? AND igsid=? AND lifecycle='active'
    AND version=? AND pending_job_id=? AND EXISTS(SELECT 1 FROM outbound_jobs WHERE id=? AND status=? AND owner_token IS ?
      AND (?='rejected' OR resolution_source='owner_closed_unresolved'))`)
    .bind(status==='rejected'?'failed':'closed',job.id,reason,Math.floor(t/1000),job.campaign_id,job.campaign_instance,
      job.recipient,job.expected_version,job.id,job.id,status,job.owner_token,status);
}
