// All transports enter the same durable inbox/outbox. Never retry an ambiguous send.
import { InstagramApiError, type InstagramClient } from '../api/client';
import { ConnectionChangedError } from '../connection';
import type { SendQueue } from '../queue/queue';
import type { Campaign, NormalizedComment, NormalizedEvent, NormalizedMessage, State } from '../types';
import { validateCampaign } from '../config';
import { commentTriggers, extractEmail } from './match';
import { afterFollow, afterTap, matchesLabel, parsePayload } from './transitions';
import { WorkBudgetExceeded } from '../reliability/budget';
import {terminalConversation} from '../reliability/conversation';

export type SendOutcome = 'confirmed' | 'pending' | 'retry_scheduled' | 'unknown' | 'rejected' | 'held' | 'cancelled';
interface CampaignRecord { campaign_id: string; instance_id: string; active: number; archived_at: number | null; active_since: number; resumed_at:number|null; config_json: string }
interface Conversation { state: State; lifecycle:'active'|'completed'|'failed'|'closed'; version: number; pending_job_id: string | null; campaign_instance: string; email_retries: number; campaign_id: string; created_at: number; event_boundary_ms:number }
interface RequestSnapshot { method: 'opening' | 'button' | 'email' | 'text' | 'reply'; text: string; commentId?: string; buttonTitle?: string; payload?: string; expiresAt: number }
interface Transition { state?: State; email?: string; followed?: number; email_retries?: number; events: string[] }
export interface OutboundJob {
  id: string; generation: number; campaign_id: string; campaign_instance: string; recipient: string;
  action: string; event_id: string; expected_version: number | null; request_json: string; transition_json: string;
  status: SendOutcome | 'sending'; attempts: number; owner_token: string | null; dispatch_at: number | null;
  finalized: number; provider_id: string | null; created_at: number; updated_at: number;
}
interface Options { generation?: number; igUserId?: string; maintenance?: boolean; now?: () => number; remainingQueries?: () => number; deadline?:number }
const FOLLOW_TEXT = "Make sure you're following so you don't miss the next one 🙌 Not following yet? Follow, then tap below.";
const FOLLOW_TITLE = '✅ I followed';
const title = (value: unknown, fallback: string) => {
  let result='';
  for(const c of typeof value==='string' && value.trim()?value.trim():fallback){if(result.length+c.length>20)break;result+=c;}
  return result;
};
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export class Engine {
  private readonly generation: number;
  private readonly clock: () => number;
  private readonly remaining: () => number;
  private mayHaveWork = false;
  constructor(private readonly db: D1Database, private readonly client: InstagramClient, _queue: SendQueue, private readonly options: Options = {}) {
    this.generation = options.generation ?? 0;
    this.clock = options.now ?? Date.now;
    this.remaining = options.remainingQueries ?? (() => Infinity);
  }
  async handleComment(event: NormalizedComment, _campaigns?: Campaign[]): Promise<void> { await this.ingest([event], 'direct'); await this.drain(); }
  async handleMessage(event: NormalizedMessage): Promise<void> { await this.ingest([event], 'direct'); await this.drain(); }

  /** A page and its checkpoint commit together. No provider calls before this commits. */
  async ingest(events: NormalizedEvent[], source: string, checkpoint?: { key: string; cursor: string | null; boundary: number; nextAt?: number; attemptAt?:number }): Promise<void> {
    const t = this.clock();
    // Collapse byte-identical copies within this page before hashing and SQL.
    // Keep richer versions of the same provider event: the inbox upsert may need
    // their recipient/time to repair a previously incomplete webhook event.
    const unique = new Map<string, NormalizedEvent>();
    for (const event of events) {
      const content = JSON.stringify(event);
      if (!unique.has(content)) unique.set(content, event);
    }
    const rows = await Promise.all([...unique].map(async ([content, event]) => ({
      id: await digest([event.kind, event.kind === 'comment' ? event.comment_id :
        event.message_id ?? [event.igsid, event.timestamp_ms ?? event.timestamp * 1000, event.payload ?? '', event.text ?? '', event.email ?? '']]),
      recipient: event.igsid, event_ms: Number.isFinite(event.timestamp_ms??event.timestamp*1000) ? event.timestamp_ms??event.timestamp*1000 : 0,
      content,
    })));
    const statements = [this.db.prepare(`INSERT INTO inbound_events(id,generation,recipient,source,event_ms,content_json,created_at)
      SELECT json_extract(value,'$.id'), ?, json_extract(value,'$.recipient'), ?, json_extract(value,'$.event_ms'), json_extract(value,'$.content'), ? FROM json_each(?) WHERE 1 ON CONFLICT(id) DO UPDATE SET recipient=excluded.recipient,event_ms=excluded.event_ms,content_json=excluded.content_json,next_at=0 WHERE inbound_events.status='pending' AND (inbound_events.recipient='' OR inbound_events.event_ms=0) AND excluded.recipient!='' AND excluded.event_ms>0`)
      .bind(this.generation, source, t, JSON.stringify(rows))];
    if (checkpoint) statements.push(this.db.prepare(`INSERT INTO polling_checkpoints(key,generation,cursor,boundary,next_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET cursor=excluded.cursor,boundary=excluded.boundary,next_at=excluded.next_at,updated_at=excluded.updated_at,generation=excluded.generation,
        failure_count=0,last_error=NULL WHERE ? IS NULL OR (polling_checkpoints.generation=excluded.generation AND polling_checkpoints.last_attempt_at=?)`)
      .bind(checkpoint.key, this.generation, checkpoint.cursor, checkpoint.boundary, checkpoint.nextAt ?? 0, t,checkpoint.attemptAt??null,checkpoint.attemptAt??null));
    await this.db.batch(statements);
    if (rows.length) this.mayHaveWork = true;
  }

  /** Bounded on both SQL and wall time. Cron resumes durable leftovers. */
  async drain(maxSteps = 20): Promise<void> {
    const deadline = this.options.deadline ?? this.clock() + 25_000;
    try {
      const now = this.clock();
      // Idle minute ticks need no claims, UUIDs, or no-op recovery writes.
      // Include abandoned dispatches and circuit-breaker recovery, even when
      // there are no pending events. Work arriving after this read waits for
      // its own handler or the next cron tick; durable ownership is unchanged.
      if (!this.mayHaveWork) {
      const due = await this.db.prepare(`SELECT
        EXISTS(SELECT 1 FROM inbound_events WHERE generation=? AND
          ((status='pending' AND next_at<=?) OR (status='processing' AND lease_until<?)))
        OR EXISTS(SELECT 1 FROM outbound_jobs WHERE generation=? AND
          ((status IN ('pending','retry_scheduled','held') AND next_at<=?) OR (status='sending' AND dispatch_at<?)))
        OR ((SELECT hold_reason FROM automation_control WHERE id=1) IS NULL AND
          (SELECT COUNT(*) FROM outbound_jobs WHERE generation=? AND status='unknown' AND updated_at>=?)>=3) AS due`)
        .bind(this.generation,now,now,this.generation,now,now-60_000,this.generation,now-600_000).first<{due:number}>();
      if (!due?.due) return;
      }
      await this.recoverAbandoned();
      for (let i = 0; i < maxSteps && this.remaining() >= 8 && this.clock() < deadline; i++) {
        const token = crypto.randomUUID(), t = this.clock();
        const event = await this.db.prepare(`UPDATE inbound_events SET status='processing',lease_token=?,lease_until=?,touched_at=?
          WHERE id=(SELECT e.id FROM inbound_events e WHERE generation=? AND
          ((status='pending' AND next_at<=?) OR (status='processing' AND lease_until<?))
          ORDER BY (SELECT MAX(x.touched_at) FROM inbound_events x WHERE x.generation=e.generation AND x.recipient=e.recipient),event_ms,id LIMIT 1) RETURNING id,content_json,lease_token`)
          .bind(token, t + 30_000, t, this.generation, t, t).first<{id:string;content_json:string;lease_token:string}>();
        let worked = false;
        if (event) {
          worked = true;
          try {
            const done = await this.plan(JSON.parse(event.content_json) as NormalizedEvent, event.id);
            await this.db.prepare(`UPDATE inbound_events SET status=?,next_at=?,error=CASE WHEN ?=1 THEN NULL ELSE error END WHERE id=? AND lease_token=?`)
              .bind(done ? 'done' : 'pending', t + 60_000, done?1:0, event.id, token).run();
          } catch (error) {
            if (error instanceof ConnectionChangedError || error instanceof WorkBudgetExceeded) throw error;
            await this.db.prepare(`UPDATE inbound_events SET status='pending',next_at=?,error=? WHERE id=? AND lease_token=?`)
              .bind(t + 60_000, 'Event processing failed; inspect worker logs', event.id, token).run();
            console.warn('[FadeLoop] durable event failed', event.id);
          }
        }
        if (this.remaining() >= 6 && this.clock() + 3_000 < deadline) worked = await this.dispatchOne() || worked;
        if (!worked) break;
      }
    } catch (error) {
      if (error instanceof WorkBudgetExceeded) return;
      throw error;
    }
  }
  private async recoverAbandoned(): Promise<void> {
    const t = this.clock();
    await this.db.batch([
      this.db.prepare(`UPDATE outbound_jobs SET status='unknown',error='Worker ended after dispatch authorization',updated_at=?
        WHERE generation=? AND status='sending' AND dispatch_at<?`).bind(t, this.generation, t - 60_000),
      this.db.prepare(`UPDATE automation_control SET hold_reason='Repeated uncertain send outcomes' WHERE id=1 AND
        (SELECT COUNT(*) FROM outbound_jobs WHERE generation=? AND status='unknown' AND updated_at>=?)>=3`).bind(this.generation, t - 600_000),
    ]);
  }
  private async plan(event: NormalizedEvent, eventId: string): Promise<boolean> {
    if(!event.igsid)return false;
    if (this.options.igUserId && event.igsid === this.options.igUserId) return true;
    if (event.kind === 'comment') return this.planComment(event, eventId);
    return this.planMessage(event, eventId);
  }
  private async planComment(event: NormalizedComment, eventId: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT * FROM campaigns WHERE media_id=? AND active=1 AND archived_at IS NULL`).bind(event.media_id).first<CampaignRecord>();
    if (!row) return true;
    const campaign = validateCampaign(JSON.parse(row.config_json));
    if (!Number.isFinite(event.timestamp) || event.timestamp <= 0) {
      // Webhook comment values may omit timestamp. Never use receipt time: a delayed
      // old comment could otherwise cross an activation boundary or delivery window.
      let page;
      try { page = await this.client.getCommentTimesPage(event.media_id, event.timestamp_lookup_cursor); }
      catch (error) {
        if (event.timestamp_lookup_cursor && error instanceof InstagramApiError && error.code === 100) {
          const { timestamp_lookup_cursor, ...restart } = event;
          await this.db.prepare("UPDATE inbound_events SET content_json=? WHERE id=? AND generation=? AND status='processing'")
            .bind(JSON.stringify(restart), eventId, this.generation).run();
        }
        throw error;
      }
      const original = page.data.find(comment => comment.id === event.comment_id);
      const ms = original?.timestamp ? Date.parse(original.timestamp) : NaN;
      const resolved = Number.isFinite(ms) && ms > 0;
      const { timestamp_lookup_cursor, ...base } = event;
      event = resolved ? { ...base, timestamp: Math.floor(ms / 1000), timestamp_ms: ms }
        : { ...base, ...(page.cursor ? { timestamp_lookup_cursor: page.cursor } : {}) };
      // Save before planning so crashes and later retries reuse the verified time.
      const saved = await this.db.prepare(`UPDATE inbound_events SET event_ms=?,content_json=?
        WHERE id=? AND generation=? AND status='processing'`)
        .bind(resolved ? ms : 0, JSON.stringify(event), eventId, this.generation).run();
      if (!saved.meta.changes || !resolved) return false;
    }
    if (event.timestamp < row.active_since || (row.resumed_at!==null && event.timestamp<=row.resumed_at) || !commentTriggers(event.text, campaign.keywords, campaign.exclude, campaign.match_mode)) return true;
    if (campaign.match_mode === 'any') {
      const activation = await this.db.prepare('SELECT activated_at FROM campaign_trigger_activation WHERE campaign_id=?').bind(row.campaign_id).first<{activated_at:number}>();
      if (!activation || event.timestamp <= activation.activated_at) return true;
    }
    const existing = await this.db.prepare('SELECT * FROM conversations WHERE igsid=? AND campaign_id=?').bind(event.igsid,row.campaign_id).first<Conversation>();
    if(existing && ['failed','closed'].includes(existing.lifecycle))return true;
    if (!existing) {
      const jobId = await this.jobId(row, event.igsid, 'opening');
      const legacy = await this.db.prepare(`SELECT 1 FROM legacy_campaign_instances l JOIN send_claims s ON s.key IN (?,?) WHERE l.campaign_id=? AND l.instance_id=?`)
        .bind(`opening:${row.campaign_id}:${event.igsid}`,`opening:${row.campaign_id}:${event.comment_id}`,row.campaign_id,row.instance_id).first();
      const request: RequestSnapshot = { method:'opening',commentId:event.comment_id,text:campaign.copy.opening,
        buttonTitle:title(campaign.copy.opening_button,'Continue'),payload:`FL1:${jobId}`,expiresAt:(event.timestamp+7*86400)*1000 };
      await this.db.batch([
        this.db.prepare(`INSERT OR IGNORE INTO conversations(igsid,campaign_id,state,username,created_at,updated_at,campaign_instance,version,event_boundary_ms)
          SELECT ?,?,'NEW',?,?,?,instance_id,0,? FROM campaigns WHERE campaign_id=? AND instance_id=? AND active=1 AND archived_at IS NULL`)
          .bind(event.igsid,row.campaign_id,event.username??null,Math.floor(this.clock()/1000),Math.floor(this.clock()/1000),event.timestamp_ms??event.timestamp*1000,row.campaign_id,row.instance_id),
        this.insertJob(jobId,row,event.igsid,'opening',eventId,0,request,{state:'AWAITING_TAP',events:['comment_matched','opening_sent']},legacy ? 'unknown' : 'pending'),
        this.attachJob(jobId,row,event.igsid,0),
      ]);
    }
    if (campaign.public_reply?.enabled && campaign.public_reply.texts?.length) {
      const action = `public_reply:${event.comment_id}`,jobId = await this.jobId(row,event.igsid,action);
      await this.insertJob(jobId,row,event.igsid,action,eventId,null,{method:'reply',commentId:event.comment_id,
        text:campaign.public_reply.texts[parseInt(jobId.slice(0,8),16)%campaign.public_reply.texts.length]!,expiresAt:(event.timestamp+7*86400)*1000},{events:[]}).run();
    }
    return true;
  }
  private async planMessage(event: NormalizedMessage, eventId: string): Promise<boolean> {
    if(!Number.isFinite(event.timestamp)||event.timestamp<=0)return false;
    const rows = await this.db.prepare(`SELECT c.*,p.instance_id,p.active,p.archived_at,p.active_since,p.config_json,
      EXISTS(SELECT 1 FROM legacy_campaign_instances l WHERE l.campaign_id=p.campaign_id AND l.instance_id=p.instance_id) legacy_instance,
      (SELECT request_json FROM outbound_jobs WHERE campaign_instance=c.campaign_instance AND recipient=c.igsid AND action='opening') opening_request,
      (SELECT request_json FROM outbound_jobs WHERE campaign_instance=c.campaign_instance AND recipient=c.igsid AND action='follow_gate') follow_request FROM conversations c
      JOIN campaigns p ON p.campaign_id=c.campaign_id AND p.instance_id=c.campaign_instance WHERE c.igsid=?
      ORDER BY CASE c.state WHEN 'AWAITING_EMAIL' THEN 3 WHEN 'AWAITING_FOLLOW' THEN 2 ELSE 1 END DESC,c.created_at DESC`)
      .bind(event.igsid).all<Conversation & CampaignRecord & {opening_request:string|null;follow_request:string|null;legacy_instance:number}>();
    const open = rows.results.filter(c=>c.state!=='DONE' && c.lifecycle==='active');
    let tokenJob: OutboundJob | null = null;
    if (event.payload?.startsWith('FL1:')) {
      tokenJob = await this.db.prepare('SELECT * FROM outbound_jobs WHERE id=? AND generation=? AND recipient=?')
        .bind(event.payload.slice(4),this.generation,event.igsid).first<OutboundJob>();
      if (!tokenJob) return true;
      if(!['opening','follow_gate'].includes(tokenJob.action))return true;
      if(tokenJob.attempts===0 && tokenJob.status!=='unknown')return this.holdEvent(eventId,'Button dispatch has not been established');
      if (tokenJob.status === 'unknown') {await this.confirm(tokenJob,tokenJob.owner_token,'postback');return false;}
    }
    const payload = parsePayload(event.payload);
    if(!tokenJob && event.payload && !['OPENING_TAP','FOLLOW_CONFIRM'].includes(payload.kind??''))return true;
    if(!tokenJob && payload.kind && !open.some(c=>c.legacy_instance && (!payload.campaignId||payload.campaignId===c.campaign_id)))return true;
    let labelOwner: {campaign_instance:string;action:string}|undefined;
    if(!event.payload){
      // Dispatched button snapshots survive completion, edits and campaign deletion.
      const issued=await this.db.prepare(`SELECT id,campaign_instance,action,request_json FROM outbound_jobs
        WHERE recipient=? AND action IN ('opening','follow_gate') AND (attempts>0 OR status='unknown')`)
        .bind(event.igsid).all<{id:string;campaign_instance:string;action:string;request_json:string}>();
      const matches=issued.results.filter(j=>matchesLabel(event.text,(JSON.parse(j.request_json) as RequestSnapshot).buttonTitle));
      if(matches.length && !matches.some(j=>open.some(c=>c.campaign_instance===j.campaign_instance &&
        (c.pending_job_id===j.id || (j.action==='opening'?c.state==='AWAITING_TAP':c.state==='AWAITING_FOLLOW')))))return true;
      if(matches.length>1)return this.holdEvent(eventId,'Ambiguous button label ownership');
      labelOwner=matches[0];
    }
    const eligible = open.filter(c => c.active === 1 && c.archived_at === null);
    if(!tokenJob && payload.kind && !payload.campaignId && eligible.length!==1)return false;
    let blocked = false, acted = false;
    for (const row of open) {
      if (tokenJob && tokenJob.campaign_instance !== row.campaign_instance) continue;
      if (labelOwner && labelOwner.campaign_instance !== row.campaign_instance) continue;
      if (!tokenJob && payload.kind && !row.legacy_instance) continue;
      if (!tokenJob && payload.campaignId && payload.campaignId !== row.campaign_id) continue;
      if (!row.active || row.archived_at !== null || row.pending_job_id) { blocked = true; continue; }
      // Processing time is unrelated to event order after an outage or backlog.
      if(!tokenJob && (event.timestamp_ms??event.timestamp*1000)<(row.event_boundary_ms||row.created_at*1000))continue;
      const campaign = validateCampaign(JSON.parse(row.config_json));
      const initial = row.opening_request ? (JSON.parse(row.opening_request) as RequestSnapshot).buttonTitle! : title(campaign.copy.opening_button,'Continue');
      const follow = row.follow_request ? (JSON.parse(row.follow_request) as RequestSnapshot).buttonTitle! : title(campaign.copy.follow_button,FOLLOW_TITLE);
      if(!event.payload && (matchesLabel(event.text,initial)||matchesLabel(event.text,follow)) && (!labelOwner || matchesLabel(initial,follow)))blocked=true;
      const fallback = !event.payload && labelOwner?.campaign_instance===row.campaign_instance && !matchesLabel(initial,follow) && !acted;
      let target: State | undefined, action='', transition: Transition={events:[]};
      if (row.state === 'AWAITING_TAP' && ((tokenJob?.action === 'opening') || (!tokenJob && payload.kind === 'OPENING_TAP') || (fallback && matchesLabel(event.text,initial)))) {
        target=afterTap(campaign);transition.events=['button_clicked'];
      } else if (row.state === 'AWAITING_FOLLOW' && ((tokenJob?.action === 'follow_gate') || (!tokenJob && payload.kind === 'FOLLOW_CONFIRM') || (fallback && matchesLabel(event.text,follow)))) {
        target=afterFollow(campaign);transition.events=['follow_confirmed'];transition.followed=1;
      } else if (row.state === 'AWAITING_EMAIL') {
        if (event.payload) continue;
        if(matchesLabel(event.text,initial)||matchesLabel(event.text,follow))continue;
        const email=event.email??extractEmail(event.text);
        if (email) {target='DELIVER';transition.email=email;transition.events=['email_captured'];}
        else if (!acted && row.email_retries<2) {target='AWAITING_EMAIL';action=`email_ask_resend:${row.email_retries}`;transition.email_retries=row.email_retries+1;}
      }
      if (!target) continue;
      const request: RequestSnapshot={method:'text',text:'',expiresAt:(event.timestamp+86400)*1000};
      if (target==='AWAITING_FOLLOW') {action='follow_gate';request.method='button';request.text=campaign.copy.follow_gate??FOLLOW_TEXT;request.buttonTitle=follow;}
      else if (target==='AWAITING_EMAIL') {action ||= 'email_ask';request.method='email';request.text=campaign.copy.email_ask??'Tap your email or reply with it 👇';}
      else {action='delivery';request.text=campaign.copy.delivery.replaceAll('{reward}',campaign.reward.value);target='DONE';transition.events.push('delivered');}
      transition.state=target;
      const jobId=await this.jobId(row,event.igsid,action);
      if(request.method==='button')request.payload=`FL1:${jobId}`;
      await this.db.batch([this.insertJob(jobId,row,event.igsid,action,eventId,row.version,request,transition),this.attachJob(jobId,row,event.igsid,row.version)]);
      acted=true;
      if (!transition.email) break;
    }
    return !blocked;
  }
  private async holdEvent(id:string,reason:string):Promise<false>{
    await this.db.prepare("UPDATE inbound_events SET error=? WHERE id=?").bind(reason,id).run();return false;
  }
  private jobId(row: CampaignRecord, recipient: string, action: string) { return digest([row.instance_id,recipient,action]); }
  private insertJob(id:string,row:CampaignRecord,recipient:string,action:string,eventId:string,version:number|null,request:RequestSnapshot,transition:Transition,status='pending') {
    const reminder=/^email_ask_resend:(\d+)$/.exec(action);
    const legacyKey=reminder?`email_ask_resend:${row.campaign_id}:${recipient}:${reminder[1]}`:`${action}:${row.campaign_id}:${recipient}`;
    return this.db.prepare(`INSERT OR IGNORE INTO outbound_jobs(id,generation,campaign_id,campaign_instance,recipient,action,event_id,expected_version,request_json,transition_json,status,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM legacy_campaign_instances l JOIN send_claims s ON s.key=? WHERE l.campaign_id=? AND l.instance_id=?) OR (?='reply' AND EXISTS(SELECT 1 FROM comment_actions WHERE comment_id=? AND action='public_reply')) THEN 'unknown' ELSE ? END,?,? WHERE EXISTS(SELECT 1 FROM campaigns WHERE campaign_id=? AND instance_id=? AND active=1 AND archived_at IS NULL)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM conversations WHERE campaign_id=? AND igsid=? AND campaign_instance=? AND version=? AND pending_job_id IS NULL AND lifecycle='active'))`)
      .bind(id,this.generation,row.campaign_id,row.instance_id,recipient,action,eventId,version,JSON.stringify(request),JSON.stringify(transition),legacyKey,row.campaign_id,row.instance_id,request.method,request.commentId??null,status,this.clock(),this.clock(),row.campaign_id,row.instance_id,version,row.campaign_id,recipient,row.instance_id,version);
  }
  private attachJob(id:string,row:CampaignRecord,recipient:string,version:number) {
    return this.db.prepare(`UPDATE conversations SET pending_job_id=? WHERE campaign_id=? AND igsid=? AND campaign_instance=? AND version=? AND pending_job_id IS NULL AND lifecycle='active'
      AND EXISTS(SELECT 1 FROM outbound_jobs WHERE id=? AND finalized=0 AND status NOT IN ('cancelled','rejected'))`)
      .bind(id,row.campaign_id,recipient,row.instance_id,version,id);
  }
  async dispatchOne(): Promise<boolean> {
    if(this.options.maintenance || this.remaining()<6 || this.clock()+3_000> (this.options.deadline??Infinity))return false;
    let t=this.clock();
    const job=await this.db.prepare(`SELECT j.* FROM outbound_jobs j JOIN campaigns p ON p.instance_id=j.campaign_instance AND p.campaign_id=j.campaign_id
      WHERE j.generation=? AND j.status IN ('pending','retry_scheduled','held') AND j.next_at<=? AND p.active=1 AND p.archived_at IS NULL ORDER BY j.updated_at,j.id LIMIT 1`)
      .bind(this.generation,t).first<OutboundJob>();
    if(!job)return false;
    const request=JSON.parse(job.request_json) as RequestSnapshot;
    if(request.expiresAt<=t){
      await this.db.prepare(`UPDATE outbound_jobs SET status='cancelled',error='Messaging window expired',next_at=9007199254740991,updated_at=? WHERE id=? AND status IN ('pending','held','retry_scheduled')`)
        .bind(t,job.id).run();
      return true;
    }
    const isDm=request.method!=='reply';

    const pacing = await this.db.prepare(`SELECT
      COALESCE((SELECT MAX(dispatched_at) FROM send_attempts), 0) AS last_dispatched,
      COALESCE((SELECT account_interval_ms FROM automation_control WHERE id=1), 1200) AS interval,
      COALESCE((SELECT MAX(dispatched_at) FROM send_attempts WHERE recipient=? AND is_dm=1), 0) AS last_recipient,
      COALESCE((SELECT recipient_interval_ms FROM automation_control WHERE id=1), 2000) AS rec_interval
    `).bind(job.recipient).first<{last_dispatched:number;interval:number;last_recipient:number;rec_interval:number}>();

    if (pacing) {
      let sleepMs = 0;
      if (pacing.interval > 0) {
        const elapsed = t - pacing.last_dispatched;
        if (elapsed < pacing.interval) sleepMs = Math.max(sleepMs, pacing.interval - elapsed);
      }
      if (isDm && pacing.rec_interval > 0) {
        const recElapsed = t - pacing.last_recipient;
        if (recElapsed < pacing.rec_interval) sleepMs = Math.max(sleepMs, pacing.rec_interval - recElapsed);
      }
      if (sleepMs > 0 && sleepMs <= 2500 && this.clock() + sleepMs + 3_000 < (this.options.deadline ?? Infinity)) {
        await new Promise(r => setTimeout(r, sleepMs));
        t = this.clock();
      }
    }

    const token=crypto.randomUUID();
    // One transaction serializes the account budget, ownership and dispatch authorization.
    const results=await this.db.batch([
      this.db.prepare(`UPDATE outbound_jobs SET status='sending',owner_token=?,dispatch_at=?,attempts=attempts+1,updated_at=?,error=NULL
        WHERE id=? AND status IN ('pending','retry_scheduled','held') AND next_at<=?
        AND EXISTS(SELECT 1 FROM automation_control WHERE id=1 AND enabled=1 AND hold_reason IS NULL)
        AND EXISTS(SELECT 1 FROM campaigns WHERE campaign_id=outbound_jobs.campaign_id AND instance_id=outbound_jobs.campaign_instance AND active=1 AND archived_at IS NULL)
        AND (expected_version IS NULL OR EXISTS(SELECT 1 FROM conversations WHERE campaign_id=outbound_jobs.campaign_id AND campaign_instance=outbound_jobs.campaign_instance AND igsid=outbound_jobs.recipient AND version=outbound_jobs.expected_version AND pending_job_id=outbound_jobs.id AND lifecycle='active'))
        AND NOT EXISTS(SELECT 1 FROM outbound_jobs WHERE recipient=? AND status IN ('unknown','sending') AND id!=?)
        AND (SELECT COUNT(*) FROM send_attempts WHERE dispatched_at>?)<(SELECT account_limit FROM automation_control WHERE id=1)
        AND COALESCE((SELECT MAX(dispatched_at) FROM send_attempts ),0)<=?-(SELECT account_interval_ms FROM automation_control WHERE id=1)
        AND (?=0 OR ((SELECT COUNT(*) FROM send_attempts WHERE recipient=? AND is_dm=1 AND dispatched_at>?)<(SELECT recipient_limit FROM automation_control WHERE id=1)
          AND COALESCE((SELECT MAX(dispatched_at) FROM send_attempts WHERE recipient=? AND is_dm=1),0)<=?-(SELECT recipient_interval_ms FROM automation_control WHERE id=1)))`)
        .bind(token,t,t,job.id,t,job.recipient,job.id,t-3600_000,t,isDm?1:0,job.recipient,t-3600_000,job.recipient,t),
      this.db.prepare(`INSERT INTO send_attempts(id,job_id,generation,recipient,is_dm,dispatched_at) SELECT ?,id,generation,recipient,?,? FROM outbound_jobs WHERE id=? AND status='sending' AND owner_token=?`)
        .bind(token,isDm?1:0,t,job.id,token),
    ]);
    if(!results[0]?.meta.changes){
      const retryDelay = Math.max(1200, pacing?.interval ?? 1200);
      await this.db.prepare(`UPDATE outbound_jobs SET status='held',next_at=?,updated_at=?,error='Sending held by account, recipient, or campaign safety controls' WHERE id=? AND status IN ('pending','retry_scheduled','held')`)
        .bind(t+retryDelay,t,job.id).run();return true;
    }
    job.owner_token=token;job.attempts++;
    try {
      let result: {message_id?:string;id?:string};
      const button={type:'postback' as const,title:request.buttonTitle!,payload:request.payload!};
      switch(request.method){
        case 'opening':result=await this.client.privateReplyWithButtons(request.commentId!,request.text,[button]);break;
        case 'button':result=await this.client.sendButtonTemplate({igsid:job.recipient},request.text,[button]);break;
        case 'email':result=await this.client.sendQuickReplies(job.recipient,request.text,[{content_type:'user_email'}]);break;
        case 'reply':result=await this.client.replyToComment(request.commentId!,request.text);break;
        default:result=await this.client.sendText(job.recipient,request.text);
      }
      const id=request.method==='reply'?result?.id:result?.message_id;
      if(typeof id!=='string'||!id.trim())throw new Error('Missing provider acknowledgement');
      await this.confirm(job,token,'provider',id);
    }catch(error){
      if(error instanceof ConnectionChangedError)throw error;
      await this.recordFailure(job,token,error);
    }
    return true;
  }
  private async recordFailure(job:OutboundJob,token:string,error:unknown):Promise<void>{
    const t=this.clock();let status:SendOutcome='unknown',next=0,reason='Send outcome unknown; no automatic replay';
    const api=error instanceof InstagramApiError?error:null;
    if(api && api.status<500 && api.isRateLimit){status=job.attempts<4?'retry_scheduled':'rejected';next=t+Math.max(60_000*2**(job.attempts-1)+Math.floor(Math.random()*30_001),(api.retryAfterSeconds??0)*1000);reason=status==='rejected'?'Rate-limit retry budget exhausted':'Provider rate limit';}
    else if(api && api.status<500 && (api.status===401||api.code===190)){status='held';next=t+3600_000;reason='Instagram authorization requires attention';}
    else if(api && api.status>=400 && api.status<500 && [100,10,200,551,10903].includes(api.code??-1)){status='rejected';reason='Provider rejected the request';}
    await this.db.batch([
      this.db.prepare(`UPDATE outbound_jobs SET status=?,next_at=?,error=?,error_code=?,trace_id=?,updated_at=? WHERE id=? AND status='sending' AND owner_token=?`)
        .bind(status,next,reason,api?.code??null,api?.fbtraceId?.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,128)??null,t,job.id,token),
      ...(status==='rejected'?[terminalConversation(this.db,job,'rejected',api?.isRateLimit?'rate_retry_exhausted':'provider_rejected',t),
        this.db.prepare("INSERT OR IGNORE INTO automation_audit(id,job_id,action,created_at) SELECT ?,id,'provider_rejected',? FROM outbound_jobs WHERE id=? AND status='rejected' AND owner_token=?")
          .bind(`reject:${job.id}`,t,job.id,token)]:[]),
      this.db.prepare(`UPDATE automation_control SET hold_reason=CASE WHEN ?=1 THEN 'Instagram authorization requires attention' ELSE 'Repeated uncertain send outcomes' END
        WHERE id=1 AND (?=1 OR (SELECT COUNT(*) FROM outbound_jobs WHERE generation=? AND status='unknown' AND updated_at>=?)>=3)`)
        .bind(api && api.status<500 && (api.status===401||api.code===190)?1:0,api && api.status<500 && (api.status===401||api.code===190)?1:0,this.generation,t-600_000),
    ]);
  }
  async confirm(job:OutboundJob,owner:string|null,source:'provider'|'owner'|'postback',providerId?:string):Promise<void>{
    const t=this.clock(),transition=JSON.parse(job.transition_json) as Transition;
    const condition=`EXISTS(SELECT 1 FROM outbound_jobs WHERE id=? AND status='confirmed' AND finalized=0 AND owner_token IS ?)`;
    const statements=[this.db.prepare(`UPDATE outbound_jobs SET status='confirmed',provider_id=COALESCE(?,provider_id),resolution_source=?,resolved_at=?,updated_at=?
      WHERE id=? AND finalized=0 AND owner_token IS ? AND status IN ('sending','unknown')`).bind(providerId??null,source,t,t,job.id,owner)];
    if(job.expected_version!==null)statements.push(this.db.prepare(`UPDATE conversations SET state=?,lifecycle=?,email=COALESCE(?,email),followed=COALESCE(?,followed),email_retries=COALESCE(?,email_retries),
      pending_job_id=NULL,last_job_id=?,version=version+1,updated_at=? WHERE igsid=? AND campaign_id=? AND campaign_instance=? AND version=? AND pending_job_id=? AND lifecycle='active' AND ${condition}`)
      .bind(transition.state,transition.state==='DONE'?'completed':'active',transition.email??null,transition.followed??null,transition.email_retries??null,job.id,Math.floor(t/1000),job.recipient,job.campaign_id,job.campaign_instance,job.expected_version,job.id,job.id,owner));
    const applied=job.expected_version===null?'1':`EXISTS(SELECT 1 FROM conversations WHERE igsid=? AND campaign_id=? AND campaign_instance=? AND version=? AND pending_job_id IS NULL AND last_job_id=?)`;
    const appliedArgs=job.expected_version===null?[]:[job.recipient,job.campaign_id,job.campaign_instance,job.expected_version+1,job.id];
    statements.push(this.db.prepare(`INSERT INTO events(campaign_id,igsid,type,created_at) SELECT ?,?,value,? FROM json_each(?) WHERE ${condition} AND ${applied}`)
      .bind(job.campaign_id,job.recipient,Math.floor(t/1000),JSON.stringify(transition.events),job.id,owner,...appliedArgs));
    statements.push(this.db.prepare(`UPDATE outbound_jobs SET finalized=1 WHERE id=? AND status='confirmed' AND finalized=0 AND owner_token IS ? AND ${applied}`).bind(job.id,owner,...appliedArgs));
    if(source==='owner')statements.push(this.db.prepare("INSERT OR IGNORE INTO automation_audit(id,job_id,action,created_at) SELECT ?,id,'confirm_received',? FROM outbound_jobs WHERE id=? AND resolution_source='owner' AND resolved_at=?").bind(`confirm_received:${job.id}`,t,job.id,t));
    await this.db.batch(statements);
  }
}
