import {describe,it,expect} from 'vitest';
import {Engine,type OutboundJob} from '../src/engine/engine';
import {SendQueue} from '../src/queue/queue';
import {InstagramApiError} from '../src/api/client';
import {upsertCampaign,setCampaignActive,deleteCampaign,claimSend} from '../src/db';
import {makeTestDb,makeTestDbWithHandle,applyMigration} from './helpers/fakeD1';
import {FakeClient} from './helpers/fakeClient';
import {budgetDatabase,remainingQueries} from '../src/reliability/budget';
import type {Campaign,NormalizedComment,NormalizedMessage} from '../src/types';
import {guardedConnectionDb} from '../src/connection';
import {handleConfigImport} from '../src/routes/config';
import {setCampaignArchived,saveAuth} from '../src/db';
import type {Env} from '../src/types';
import {handleAutomation} from '../src/reliability/status';
const config=(id='c1',extra:Partial<Campaign>={}):Campaign=>({campaign_id:id,media_id:id,keywords:['link'],reward:{type:'text',value:'resource'},copy:{opening:'Tap below',opening_button:'Send it',follow_button:'Followed',delivery:'Your {reward}'},...extra});
async function fixture(extra:Partial<Campaign>={}){
 const db=makeTestDb(),client=new FakeClient();let t=Date.now();
 await db.prepare('UPDATE automation_control SET enabled=1,account_interval_ms=0,recipient_interval_ms=0').run();
 await upsertCampaign(db,config('c1',extra),true);
 const engine=new Engine(db,client.asClient(),new SendQueue({minIntervalMs:0}),{igUserId:'owner',now:()=>t});
 const comment=(over:Partial<NormalizedComment>={}):NormalizedComment=>({kind:'comment',igsid:'user',comment_id:'comment',media_id:'c1',text:'link',timestamp:Math.floor(t/1000),...over});
 const message=(over:Partial<NormalizedMessage>={}):NormalizedMessage=>({kind:'message',igsid:'user',message_id:crypto.randomUUID(),timestamp:Math.floor(t/1000),payload:(client.calls.privateReply[0] as {buttons:{payload:string}[]}|undefined)?.buttons[0]?.payload,...over});
 return {db,client,engine,comment,message,advance:(ms=61_000)=>{t+=ms;}};
}
const count=async(db:D1Database,table:string)=> (await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{n:number}>())!.n;
describe('durable automation reliability',()=>{
 it('uses one read for an idle drain and still processes work on the next drain',async()=>{
  const f=await fixture();const db=budgetDatabase(f.db);
  const engine=new Engine(db,f.client.asClient(),new SendQueue(),{igUserId:'owner'});
  await engine.drain();expect(remainingQueries(db)).toBe(39);
  await engine.ingest([f.comment()], 'webhook');await engine.drain();
  expect(f.client.calls.privateReply).toHaveLength(1);
 });
 it('collapses identical batch events without losing richer timestamp evidence',async()=>{
  const f=await fixture();const missing=f.comment({timestamp:0,timestamp_ms:0});
  await f.engine.ingest([...Array.from({length:501},()=>missing),f.comment()], 'webhook');
  expect(await count(f.db,'inbound_events')).toBe(1);
  const saved=await f.db.prepare('SELECT event_ms FROM inbound_events').first<{event_ms:number}>();
  expect(saved!.event_ms).toBe(f.comment().timestamp*1000);
  await f.engine.drain();expect(f.client.calls.privateReply).toHaveLength(1);
 });
 it('resolves and persists missing comment time before sending once',async()=>{
  const f=await fixture();let reads=0;
  Object.assign(f.client,{getCommentTimesPage:async()=>{reads++;return {data:[{id:f.comment().comment_id,timestamp:new Date(f.comment().timestamp*1000).toISOString()}],cursor:null};}});
  const event=f.comment({timestamp:0,timestamp_ms:0});
  await f.engine.handleComment(event);await f.engine.handleComment(event);
  expect(f.client.calls.privateReply).toHaveLength(1);expect(reads).toBe(1);
  const saved=await f.db.prepare('SELECT event_ms,content_json FROM inbound_events').first<{event_ms:number;content_json:string}>();
  expect(saved!.event_ms).toBe(f.comment().timestamp*1000);expect(JSON.parse(saved!.content_json).timestamp).toBe(f.comment().timestamp);
 });
 it('does not substitute receipt time for old or unverifiable comments',async()=>{
  for(const response of ['old','invalid','mismatch','failure']){
   const f=await fixture();
   Object.assign(f.client,{getCommentTimesPage:async()=>{if(response==='failure')throw new Error('read failed');return {data:[{id:response==='mismatch'?'another':f.comment().comment_id,timestamp:response==='invalid'?'invalid':new Date((f.comment().timestamp-(response==='old'?3600:0))*1000).toISOString()}],cursor:null};}});
   await f.engine.handleComment(f.comment({timestamp:0,timestamp_ms:0}));
   expect(f.client.calls.privateReply).toHaveLength(0);expect(await count(f.db,'outbound_jobs')).toBe(0);
   expect(await f.db.prepare('SELECT status FROM inbound_events').first()).toMatchObject({status:response==='old'?'done':'pending'});
  }
 });
 it('resumes timestamp lookup pagination after restart without resending',async()=>{
  const f=await fixture();const cursors:Array<string|undefined>=[];
  Object.assign(f.client,{getCommentTimesPage:async(_media:string,cursor?:string)=>{
   cursors.push(cursor);return cursor==='page-2'
    ? {data:[{id:f.comment().comment_id,timestamp:new Date(f.comment().timestamp*1000).toISOString()}],cursor:null}
    : {data:[{id:'different-comment',timestamp:new Date().toISOString()}],cursor:'page-2'};
  }});
  await f.engine.handleComment(f.comment({timestamp:0,timestamp_ms:0}));
  expect(f.client.calls.privateReply).toHaveLength(0);
  expect(JSON.parse((await f.db.prepare('SELECT content_json FROM inbound_events').first<{content_json:string}>())!.content_json).timestamp_lookup_cursor).toBe('page-2');
  await f.db.prepare('UPDATE inbound_events SET next_at=0').run();
  const restarted=new Engine(f.db,f.client.asClient(),new SendQueue(),{igUserId:'owner'});
  await restarted.drain();await restarted.drain();
  expect(cursors).toEqual([undefined,'page-2']);expect(f.client.calls.privateReply).toHaveLength(1);
 });
 it('migration defaults to disabled sending',async()=>{const {db}=makeTestDbWithHandle();expect((await db.prepare('SELECT enabled FROM automation_control').first<{enabled:number}>())!.enabled).toBe(0);});
 it('501 concurrent repeats create and send one opening',async()=>{const f=await fixture();await Promise.all(Array.from({length:501},()=>f.engine.handleComment(f.comment())));expect(f.client.calls.privateReply).toHaveLength(1);expect(await count(f.db,'outbound_jobs')).toBe(1);});
 for(const type of ['http500','http500-auth','socket','bad-success'] as const)it(`${type} is held without replay or successful analytics`,async()=>{
  const f=await fixture();let sends=0;
  f.client.privateReplyWithButtons=async()=>{sends++;if(type==='http500'||type==='http500-auth')throw new InstagramApiError('after accept',500,type==='http500-auth'?190:undefined);if(type==='socket')throw new Error('socket');return {} as {message_id:string};};
  for(let i=0;i<501;i++){await f.engine.handleComment(f.comment());f.advance();}
  expect(sends).toBe(1);expect((await f.db.prepare('SELECT status FROM outbound_jobs').first<{status:string}>())!.status).toBe('unknown');expect(await count(f.db,'events')).toBe(0);
 });
 it('a slow rejected opening is never falsely confirmed by a competing event',async()=>{
  const f=await fixture();let start!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>start=r),gate=new Promise<void>(r=>release=r);
  f.client.privateReplyWithButtons=async()=>{start();await gate;throw new InstagramApiError('invalid',400,100);};
  const first=f.engine.handleComment(f.comment());await ready;await f.engine.handleComment(f.comment({comment_id:'second'}));release();await first;
  expect((await f.db.prepare('SELECT state FROM conversations').first<{state:string}>())!.state).toBe('NEW');expect(await count(f.db,'events')).toBe(0);
 });
 it('a rejected opening terminalizes its conversation without retrying later inputs',async()=>{
  const f=await fixture();f.client.privateReplyWithButtons=async()=>{throw new InstagramApiError('invalid',400,100);};await f.engine.handleComment(f.comment());
  expect(await f.db.prepare('SELECT lifecycle,pending_job_id,terminal_reason FROM conversations').first()).toMatchObject({lifecycle:'failed',pending_job_id:null,terminal_reason:'provider_rejected'});
  await f.engine.handleMessage(f.message());f.advance();await f.engine.drain();
  expect(await f.db.prepare("SELECT status FROM inbound_events WHERE content_json LIKE '%message_id%'").first()).toMatchObject({status:'done'});
  expect(await count(f.db,'send_attempts')).toBe(1);
 });
 it('public reply rejection does not terminalize the DM conversation',async()=>{
  const f=await fixture({public_reply:{enabled:true,texts:['Thanks']}});f.client.replyToComment=async()=>{throw new InstagramApiError('invalid',400,100);};
  await f.engine.handleComment(f.comment());expect(await f.db.prepare('SELECT state,lifecycle FROM conversations').first()).toMatchObject({state:'AWAITING_TAP',lifecycle:'active'});
  await f.engine.handleMessage(f.message());expect(f.client.calls.text).toHaveLength(1);
 });
 it('a stale rejection cannot close a newer conversation transition',async()=>{
  const f=await fixture();let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>ready=r);
  f.client.privateReplyWithButtons=async()=>{ready();await gate;throw new InstagramApiError('invalid',400,100);};
  const run=f.engine.handleComment(f.comment());await started;
  await f.db.prepare("UPDATE conversations SET version=version+1,pending_job_id='newer-job'").run();release();await run;
  expect(await f.db.prepare('SELECT lifecycle,pending_job_id,version FROM conversations').first()).toMatchObject({lifecycle:'active',pending_job_id:'newer-job',version:1});
 });
 it('owner closure is audited and terminal without releasing the suppressed action',async()=>{
  const f=await fixture();f.client.deliverThenFailNext.privateReply=1;await f.engine.handleComment(f.comment());
  const job=(await f.db.prepare('SELECT * FROM outbound_jobs').first<OutboundJob>())!;
  const req=()=>new Request('https://test/api/automation/resolve',{method:'POST',body:JSON.stringify({job_id:job.id,action:'close_unresolved'})});
  expect((await handleAutomation({DB:f.db} as Env,req(),new URL(req().url))).status).toBe(200);
  expect((await handleAutomation({DB:f.db} as Env,req(),new URL(req().url))).status).toBe(404);
  expect(await f.db.prepare('SELECT lifecycle,pending_job_id,terminal_reason FROM conversations').first()).toMatchObject({lifecycle:'closed',pending_job_id:null,terminal_reason:'owner_closed_unresolved'});
  await f.engine.handleMessage(f.message({payload:`FL1:${job.id}`}));expect(f.client.calls.privateReply).toHaveLength(1);expect(f.client.calls.text).toHaveLength(0);
  expect(await count(f.db,'automation_audit')).toBe(1);
 });
 it('same-second press completes exactly once',async()=>{const f=await fixture();await f.engine.handleComment(f.comment());const m=f.message();await Promise.all([f.engine.handleMessage(m),f.engine.handleMessage(m)]);expect(f.client.calls.text).toHaveLength(1);expect((await f.db.prepare('SELECT state FROM conversations').first<{state:string}>())!.state).toBe('DONE');});
 for(const echoFirst of [false,true])it(`a postback and label echo cannot complete another campaign (echo first: ${echoFirst})`,async()=>{
  const f=await fixture();await upsertCampaign(f.db,config('second'),true);
  await f.engine.handleComment(f.comment());await f.engine.handleComment(f.comment({comment_id:'second',media_id:'second'}));
  const job=(await f.db.prepare("SELECT id FROM outbound_jobs WHERE campaign_id='c1' AND action='opening'").first<{id:string}>())!;
  const echo=f.message({payload:undefined,text:'Send it'});
  if(echoFirst)await f.engine.handleMessage(echo);
  await f.engine.handleMessage(f.message({payload:`FL1:${job.id}`}));
  if(!echoFirst)await f.engine.handleMessage(echo);
  f.advance();await f.engine.drain();
  expect(f.client.calls.text).toHaveLength(1);
  expect(await f.db.prepare("SELECT state FROM conversations WHERE campaign_id='second'").first()).toMatchObject({state:'AWAITING_TAP'});
 });
 it('deleted button ownership still prevents label reassignment',async()=>{
  const f=await fixture();await f.engine.handleComment(f.comment());await deleteCampaign(f.db,'c1');await upsertCampaign(f.db,config('second'),true);
  await f.engine.handleComment(f.comment({media_id:'second',comment_id:'second'}));await f.engine.handleMessage(f.message({payload:undefined,text:'Send it'}));
  expect(f.client.calls.text).toHaveLength(0);
 });
 it('an old legacy button cannot advance a recreated campaign instance',async()=>{
  const f=await fixture();await f.db.prepare('INSERT INTO legacy_campaign_instances SELECT campaign_id,instance_id FROM campaigns').run();
  await deleteCampaign(f.db,'c1');await upsertCampaign(f.db,config(),true);await f.engine.handleComment(f.comment());
  await f.engine.handleMessage(f.message({payload:'OPENING_TAP:c1'}));expect(f.client.calls.text).toHaveLength(0);
  expect(await f.db.prepare('SELECT state FROM conversations').first()).toMatchObject({state:'AWAITING_TAP'});
 });
 it('new campaigns do not accept campaign-ID-only button payloads',async()=>{
  const f=await fixture();await f.engine.handleComment(f.comment());await f.engine.handleMessage(f.message({payload:'OPENING_TAP:c1'}));expect(f.client.calls.text).toHaveLength(0);
 });
 for(const correlated of [false,true])it(`a delayed reply after its comment survives processing lag (token: ${correlated})`,async()=>{
  const f=await fixture(),comment=f.comment();f.advance(10_000);await f.engine.handleComment(comment);
  const job=(await f.db.prepare("SELECT id FROM outbound_jobs WHERE action='opening'").first<{id:string}>())!;
  await f.engine.handleMessage(f.message({timestamp:comment.timestamp+5,payload:correlated?`FL1:${job.id}`:undefined,text:'Send it'}));
  expect(f.client.calls.text).toHaveLength(1);expect(await f.db.prepare('SELECT state FROM conversations').first()).toMatchObject({state:'DONE'});
 });
 it('paused conversations retain their event and finish on resume',async()=>{const f=await fixture();await f.engine.handleComment(f.comment());await setCampaignActive(f.db,'c1',false);await f.engine.handleMessage(f.message());expect(f.client.calls.text).toHaveLength(0);await setCampaignActive(f.db,'c1',true);f.advance();await f.engine.drain();expect(f.client.calls.text).toHaveLength(1);});
 it('resuming never backfills comments from the paused boundary second',async()=>{
  const f=await fixture();await setCampaignActive(f.db,'c1',false);const timestamp=Math.floor(Date.now()/1000);await setCampaignActive(f.db,'c1',true);
  await f.engine.handleComment(f.comment({timestamp}));expect(f.client.calls.privateReply).toHaveLength(0);
  await f.engine.handleComment(f.comment({timestamp:timestamp+2,comment_id:'after'}));expect(f.client.calls.privateReply).toHaveLength(1);
 });
 it('self-authored comments never send',async()=>{const f=await fixture({public_reply:{enabled:true,texts:['link']}});await f.engine.handleComment(f.comment({igsid:'owner'}));expect(await count(f.db,'outbound_jobs')).toBe(0);});
 it('deleting wildcard IDs preserves unrelated and legacy claims',async()=>{const f=await fixture();await claimSend(f.db,'opening:c1:user');await upsertCampaign(f.db,config('%'),true);await deleteCampaign(f.db,'%');expect(await claimSend(f.db,'opening:c1:user')).toBe(false);});
 it('enforces one active campaign per post atomically',async()=>{const f=await fixture();await expect(upsertCampaign(f.db,config('second',{media_id:'c1'}),true)).rejects.toThrow();expect(await count(f.db,'campaigns')).toBe(1);});
 it('rate-limit rejections retry at most three more times',async()=>{const f=await fixture();let n=0;f.client.privateReplyWithButtons=async()=>{n++;throw new InstagramApiError('rate',429);};await f.engine.handleComment(f.comment());for(let i=0;i<6;i++){f.advance(600_000);await f.engine.drain();}expect(n).toBe(4);expect((await f.db.prepare('SELECT status FROM outbound_jobs').first<{status:string}>())!.status).toBe('rejected');});
 it('honors a longer Retry-After without an in-memory retry',async()=>{
  const f=await fixture();let n=0;f.client.privateReplyWithButtons=async()=>{n++;throw new InstagramApiError('rate',429,4,undefined,undefined,600);};
  await f.engine.handleComment(f.comment());f.advance(300_000);await f.engine.drain();expect(n).toBe(1);
  const job=(await f.db.prepare('SELECT next_at,dispatch_at FROM outbound_jobs').first<{next_at:number;dispatch_at:number}>())!;
  expect(job.next_at).toBeGreaterThanOrEqual(job.dispatch_at+600_000);
 });
 for(const archive of [false,true])it(`suspension preserves Retry-After and attempt ownership (archive: ${archive})`,async()=>{
  const f=await fixture();let sends=0;f.client.privateReplyWithButtons=async()=>{sends++;throw new InstagramApiError('rate',429,4,undefined,undefined,600);};
  await f.engine.handleComment(f.comment());const before=await f.db.prepare('SELECT status,next_at,attempts,request_json,owner_token FROM outbound_jobs').first();
  if(archive){await setCampaignArchived(f.db,'c1',true);await setCampaignArchived(f.db,'c1',false);}
  else {await setCampaignActive(f.db,'c1',false);await setCampaignActive(f.db,'c1',true);}
  expect(await f.db.prepare('SELECT status,next_at,attempts,request_json,owner_token FROM outbound_jobs').first()).toEqual(before);
  f.advance(300_000);await f.engine.drain();expect(sends).toBe(1);
  f.advance(300_001);await f.engine.drain();expect(sends).toBe(2);
 });
 it('authorization failures cannot be cleared by the enable control before reconnection',async()=>{
  const f=await fixture();await saveAuth(f.db,{access_token:'fixture',ig_user_id:'owner',expires_at:9999999999});let n=0;
  f.client.privateReplyWithButtons=async()=>{n++;throw new InstagramApiError('auth expired',400,190);};await f.engine.handleComment(f.comment());f.advance(7200_000);await f.engine.drain();expect(n).toBe(1);
  const response=await handleAutomation({DB:f.db,MODE:'webhook'} as Env,new Request('https://test/api/automation/control',{method:'POST',body:JSON.stringify({enabled:true,verified:true})}),new URL('https://test/api/automation/control'));
  expect(response.status).toBe(409);expect(await f.db.prepare('SELECT hold_reason FROM automation_control').first()).toMatchObject({hold_reason:'Instagram authorization requires attention'});
 });
 it('account attempt limit applies concurrently across recipients',async()=>{const f=await fixture();await f.db.prepare('UPDATE automation_control SET account_limit=2').run();await Promise.all(Array.from({length:10},(_,i)=>f.engine.handleComment(f.comment({igsid:'u'+i,comment_id:'m'+i}))));expect(f.client.calls.privateReply).toHaveLength(2);expect(await count(f.db,'send_attempts')).toBe(2);});
 it('a sending crash becomes unknown and is not reclaimed',async()=>{const f=await fixture();await f.db.prepare('UPDATE automation_control SET enabled=0').run();await f.engine.handleComment(f.comment());await f.db.prepare("UPDATE outbound_jobs SET status='sending',dispatch_at=0").run();await f.db.prepare('UPDATE automation_control SET enabled=1').run();f.advance();await f.engine.drain();expect(f.client.calls.privateReply).toHaveLength(0);expect((await f.db.prepare('SELECT status FROM outbound_jobs').first<{status:string}>())!.status).toBe('unknown');});
 it('unknown recipient holds other campaigns in that thread',async()=>{const f=await fixture();f.client.deliverThenFailNext.privateReply=1;await f.engine.handleComment(f.comment());await upsertCampaign(f.db,config('c2'),true);await f.engine.handleComment(f.comment({media_id:'c2',comment_id:'other'}));expect(f.client.calls.privateReply).toHaveLength(1);});
 it('query budget leaves durable work without exceeding forty SQL statements',async()=>{const f=await fixture();const raw=budgetDatabase(f.db);const engine=new Engine(raw,f.client.asClient(),new SendQueue(),{igUserId:'owner',remainingQueries:()=>remainingQueries(raw)});await engine.ingest(Array.from({length:100},(_,i)=>f.comment({comment_id:'b'+i,igsid:'b'+i})),'test');await engine.drain();expect(remainingQueries(raw)).toBeGreaterThanOrEqual(0);expect(await count(f.db,'inbound_events')).toBe(100);});
 it('migration holds all legacy overlapping campaigns without deleting claims',async()=>{const f=makeTestDbWithHandle('0008');f.raw.exec(`INSERT INTO campaigns(campaign_id,media_id,config_json,active,updated_at) VALUES('a','post','{}',1,0),('b','post','{}',1,0);INSERT INTO send_claims VALUES('opaque:key',0)`);applyMigration(f.raw,'0009_reliability.sql');expect(await count(f.db,'campaign_conflicts')).toBe(2);expect(await count(f.db,'send_claims')).toBe(1);expect((await f.db.prepare('SELECT SUM(active) n FROM campaigns').first<{n:number}>())!.n).toBe(0);});
 it('owner confirmation finalizes progress and analytics only once',async()=>{
  const f=await fixture();f.client.deliverThenFailNext.privateReply=1;await f.engine.handleComment(f.comment());
  const job=(await f.db.prepare('SELECT * FROM outbound_jobs').first<OutboundJob>())!;
  await f.engine.confirm(job,job.owner_token,'owner');await f.engine.confirm(job,job.owner_token,'owner');
  expect(await count(f.db,'events')).toBe(2);expect(await count(f.db,'automation_audit')).toBe(1);
  expect(await f.db.prepare('SELECT state,version FROM conversations').first()).toMatchObject({state:'AWAITING_TAP',version:1});
 });
 it('a correlated postback resolves an uncertain opening without another opening',async()=>{
  const f=await fixture();f.client.deliverThenFailNext.privateReply=1;await f.engine.handleComment(f.comment());
  const job=(await f.db.prepare('SELECT * FROM outbound_jobs').first<OutboundJob>())!;
  await f.engine.handleMessage(f.message({payload:`FL1:${job.id}`}));f.advance();await f.engine.drain();
  expect(f.client.calls.privateReply).toHaveLength(1);expect(f.client.calls.text).toHaveLength(1);
 });
 it('a preparation crash can resume without losing the immutable request',async()=>{
  const f=await fixture();await f.db.prepare('UPDATE automation_control SET enabled=0').run();await f.engine.handleComment(f.comment());
  await upsertCampaign(f.db,config('c1',{copy:{opening:'Edited after planning',delivery:'Edited'}}));
  await f.db.prepare('UPDATE automation_control SET enabled=1').run();f.advance();await f.engine.drain();
  expect(f.client.calls.privateReply[0]).toMatchObject({text:'Tap below'});
 });
 it('database failure at dispatch authorization prevents the provider call',async()=>{
  const f=await fixture();await f.engine.ingest([f.comment()],'test');
  const unavailable=new Proxy(f.db,{get(target,key){if(key==='batch')return async()=>{throw new Error('D1 unavailable');};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const engine=new Engine(unavailable,f.client.asClient(),new SendQueue());await expect(engine.drain()).rejects.toThrow('D1 unavailable');
  expect(f.client.calls.privateReply).toHaveLength(0);
 });
 it('three uncertain recipients trip the account breaker',async()=>{
  const f=await fixture();f.client.privateReplyWithButtons=async()=>{throw new Error('accepted but disconnected');};
  for(let i=0;i<4;i++)await f.engine.handleComment(f.comment({comment_id:`x${i}`,igsid:`x${i}`}));
  expect(await count(f.db,'send_attempts')).toBe(3);
  expect(await f.db.prepare('SELECT hold_reason FROM automation_control').first()).toMatchObject({hold_reason:'Repeated uncertain send outcomes'});
 });
 it('query counting includes real connection guard statements',async()=>{
  const f=await fixture();await saveAuth(f.db,{access_token:'fixture',ig_user_id:'owner',expires_at:9999999999});const raw=budgetDatabase(f.db),scoped=guardedConnectionDb(raw,0);
  const engine=new Engine(scoped,f.client.asClient(),new SendQueue(),{remainingQueries:()=>remainingQueries(raw)});
  await engine.ingest(Array.from({length:80},(_,i)=>f.comment({comment_id:`q${i}`,igsid:`q${i}`})),'test');await engine.drain();
  expect(remainingQueries(raw)).toBeGreaterThanOrEqual(0);expect(await count(f.db,'inbound_events')).toBe(80);
  expect(await count(f.db,'send_attempts')).toBeGreaterThan(0);
 });
 it('late confirmation cannot overwrite a newer version or add success analytics',async()=>{
  const f=await fixture();f.client.deliverThenFailNext.privateReply=1;await f.engine.handleComment(f.comment());
  const job=(await f.db.prepare('SELECT * FROM outbound_jobs').first<OutboundJob>())!;
  await f.db.prepare("UPDATE conversations SET version=1,state='DONE',last_job_id='other-job',pending_job_id=NULL").run();await f.engine.confirm(job,job.owner_token,'owner');
  expect(await f.db.prepare('SELECT state,version FROM conversations').first()).toMatchObject({state:'DONE',version:1});expect(await count(f.db,'events')).toBe(0);
 });
 it('archive restore and imports enforce conflicts with transactional rollback',async()=>{
  const f=await fixture();await upsertCampaign(f.db,config('other',{media_id:'c1'}),false);await setCampaignArchived(f.db,'c1',true);
  await setCampaignActive(f.db,'other',true);await expect(setCampaignArchived(f.db,'c1',false)).rejects.toThrow();
  const response=await handleConfigImport({DB:f.db} as Env,new Request('https://test/config/import',{method:'POST',body:JSON.stringify({campaigns:[config('new'),config('conflict',{media_id:'c1'})]})})).catch(()=>null);
  expect(response).toBeNull();expect(await f.db.prepare("SELECT 1 FROM campaigns WHERE campaign_id='new'").first()).toBeNull();
 });
 it('a reconnect preserves queued work and account-wide attempt accounting',async()=>{
  const f=await fixture();await saveAuth(f.db,{access_token:'before',ig_user_id:'owner',expires_at:9999999999});
  await f.engine.handleComment(f.comment());await f.db.prepare("INSERT INTO owner_accounts(id,email,password_hash,updated_at) VALUES(1,'test','hash',0)").run();
  await f.db.prepare("INSERT INTO owner_sessions(token_hash,owner_id,credential_version,expires_at,created_at) VALUES('session',1,1,9999999999,0)").run();
  await saveAuth(f.db,{access_token:'after',ig_user_id:'owner',expires_at:9999999999},{generation:0,sessionHash:'session',credentialVersion:1});
  expect(await f.db.prepare('SELECT generation,status FROM outbound_jobs').first()).toMatchObject({generation:1,status:'confirmed'});
  expect(await count(f.db,'send_attempts')).toBe(1);expect(await f.db.prepare('SELECT enabled FROM automation_control').first()).toMatchObject({enabled:0});
  await f.db.prepare('UPDATE automation_control SET enabled=1,account_limit=1').run();const engine=new Engine(f.db,f.client.asClient(),new SendQueue(),{generation:1});
  await engine.handleComment(f.comment());expect(await count(f.db,'inbound_events')).toBe(1);
  await engine.handleComment(f.comment({comment_id:'after',igsid:'after'}));expect(f.client.calls.privateReply).toHaveLength(1);
 });
});
