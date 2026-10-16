import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('../src/auth/vendor/argon2.js',async()=>({argon2id:(await import('hash-wasm')).argon2id}));
import worker from '../src/index';
import {makeTestDbWithHandle,applyMigration} from './helpers/fakeD1';
import {upsertCampaign} from '../src/db';
import {taskId,taskStatement,claimTask,settleTask,publishTasks,type Notification} from '../src/tasks/store';
import type {Env} from '../src/types';
import {taskStatus,retryTask} from '../src/tasks/status';
import {reconcilePollEligibility} from '../src/tasks/eligibility';

const origin='https://fixture.test',secret='fixture-secret';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
async function fixture(){
 const {db,raw}=makeTestDbWithHandle(),queued:{body:Notification;queue:string}[]=[],calls:{path:string;body:any}[]=[];
 raw.exec("INSERT INTO auth(id,access_token,ig_user_id,expires_at) VALUES(1,'fixture','owner',9999999999);UPDATE automation_control SET enabled=1,account_interval_ms=0,recipient_interval_ms=0");
 const binding=(queue:string)=>({send:async(body:Notification)=>{queued.push({body,queue});}}) as unknown as Queue<Notification>;
 const env={DB:db,EXECUTION_MODE:'tasks',WORK_QUEUE:binding('work'),SEND_QUEUE:binding('send'),AUTH_MODE:'access',MODE:'webhook',WEBHOOK_RECONCILE_SECONDS:'off',GRAPH_VERSION:'v23.0',APP_SECRET:secret,APP_ID:'fixture',REDIRECT_URI:origin+'/auth/callback',POLL_INTERVAL_SECONDS:'180',ASSETS:{fetch:async()=>new Response('asset')} as unknown as Fetcher} satisfies Env;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;
  if(init?.method==='POST'){calls.push({path,body:JSON.parse(String(init.body??'{}'))});return Response.json({message_id:'sent-'+calls.length,id:'reply-'+calls.length});}
  return Response.json({data:[]});
 }));
 async function push(body:unknown){
  const text=JSON.stringify(body),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text));
  return worker.fetch(new Request(origin+'/webhook',{method:'POST',body:text,headers:{'x-hub-signature-256':'sha256='+Buffer.from(signature).toString('hex')}}),env);
 }
 async function consumeOne(){
  const item=queued.shift();if(!item)return false;
  const ack=vi.fn(),retry=vi.fn();
  await worker.queue({queue:item.queue,messages:[{body:item.body,ack,retry}],ackAll:vi.fn(),retryAll:vi.fn()} as unknown as MessageBatch<unknown>,env);
  expect(retry).not.toHaveBeenCalled();expect(ack).toHaveBeenCalled();return true;
 }
 async function drain(){for(let i=0;i<200&&queued.length;i++)await consumeOne();expect(queued).toHaveLength(0);}
 return {db,raw,env,queued,calls,push,consumeOne,drain};
}
const comment=(i:number)=>({field:'comments',value:{id:'comment'+i,from:{id:'user'+i},media:{id:'post'},text:'LINK',timestamp:new Date(Date.now()+1000).toISOString()}});
const hook=(changes:unknown[])=>({entry:[{changes}]});
describe('bounded durable execution',()=>{
 it('expands the existing task schema without replacing identities, leases or continuation progress',()=>{
  const {raw}=makeTestDbWithHandle('0012');
  raw.exec("INSERT INTO work_tasks(id,generation,kind,reference,revision,status,lease_token,lease_until_ms,updated_at_ms) VALUES('existing',7,'messages','messages:thread',3,'leased','owner-token',12345,99)");
  const before=raw.prepare('SELECT * FROM work_tasks').get();
  applyMigration(raw,'0013_task_eligibility.sql');
  expect(raw.prepare('SELECT * FROM work_tasks').get()).toMatchObject({...before,suspend_reason:null});
 });
 it('does not publish or claim disabled polling, then resumes without resetting checkpoints',async()=>{
  const f=await fixture();await taskStatement(f.db,'messages',0,'messages:thread').run();
  f.raw.exec("INSERT INTO polling_checkpoints(key,generation,cursor,boundary,updated_at) VALUES('messages:thread',0,'saved-cursor',123,0)");
  expect(await publishTasks(f.env,f.db,0)).toBe(0);
  expect(await claimTask(f.db,taskId('messages',0,'messages:thread'),0,false)).toBeNull();
  await reconcilePollEligibility(f.env,f.db,0);
  const page=await(await taskStatus(f.env,new URL(origin+'/api/automation/tasks?status=suspended'))).json() as {tasks:{status:string;suspend_reason:string}[]};
  expect(page.tasks).toHaveLength(1);expect(page.tasks[0]).toMatchObject({status:'suspended',suspend_reason:'polling-disabled'});
  f.env.WEBHOOK_RECONCILE_SECONDS='900';await reconcilePollEligibility(f.env,f.db,0);
  expect(await publishTasks(f.env,f.db,0)).toBe(1);
  expect(f.raw.prepare("SELECT cursor,boundary FROM polling_checkpoints WHERE key='messages:thread'").get()).toMatchObject({cursor:'saved-cursor',boundary:123});
 });
 it('publishes no polling hints during 24 hours disabled with 100 existing objects',async()=>{
  const f=await fixture();vi.useFakeTimers();const start=Date.now();
  for(let i=0;i<100;i++)await taskStatement(f.db,'messages',0,'messages:thread'+i).run();
  for(let minute=0;minute<1440;minute++){
   vi.setSystemTime(start+minute*60_000);
   await worker.scheduled({cron:'* * * * *'} as ScheduledController,f.env);
  }
  expect(f.queued).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
  expect(f.raw.prepare("SELECT COUNT(*) n FROM work_tasks WHERE suspend_reason='polling-disabled'").get()).toMatchObject({n:100});
 });
 it('suppresses expired credentials and inactive campaigns before repair reaches their rows',async()=>{
  const f=await fixture();f.env.WEBHOOK_RECONCILE_SECONDS='900';
  await taskStatement(f.db,'comments',0,'post').run();await taskStatement(f.db,'messages',0,'messages:thread').run();
  f.raw.exec('UPDATE auth SET expires_at=0');expect(await publishTasks(f.env,f.db,0)).toBe(0);
  expect(await claimTask(f.db,taskId('messages',0,'messages:thread'),0)).toBeNull();
  await reconcilePollEligibility(f.env,f.db,0);
  expect(f.raw.prepare("SELECT COUNT(*) n FROM work_tasks WHERE suspend_reason='credentials-expired'").get()).toMatchObject({n:2});
  f.raw.exec('UPDATE auth SET expires_at=9999999999');await reconcilePollEligibility(f.env,f.db,0);
  expect(f.raw.prepare("SELECT suspend_reason FROM work_tasks WHERE kind='comments'").get()).toMatchObject({suspend_reason:'campaign-inactive'});
  await upsertCampaign(f.db,{campaign_id:'c',media_id:'post',keywords:['LINK'],reward:{type:'text',value:'r'},copy:{opening:'Tap',delivery:'r'}});
  await reconcilePollEligibility(f.env,f.db,0);expect(await publishTasks(f.env,f.db,0)).toBe(2);
 });
 it('preserves a suspension/resume change under a live lease and ignores old settlement',async()=>{
  const f=await fixture();f.env.WEBHOOK_RECONCILE_SECONDS='900';await taskStatement(f.db,'messages',0,'conversations').run();
  const old=await claimTask(f.db,taskId('messages',0,'conversations'),0);expect(old).not.toBeNull();
  f.env.WEBHOOK_RECONCILE_SECONDS='off';await reconcilePollEligibility(f.env,f.db,0);await settleTask(f.db,old!,Date.now()+900_000);
  expect(await publishTasks(f.env,f.db,0)).toBe(0);
  f.env.WEBHOOK_RECONCILE_SECONDS='900';await reconcilePollEligibility(f.env,f.db,0);
  const current=await claimTask(f.db,old!.id,0);expect(current).not.toBeNull();
  await settleTask(f.db,old!);expect(f.raw.prepare('SELECT lease_token FROM work_tasks').get()).toMatchObject({lease_token:current!.lease_token});
 });
 it('pages blocked task evidence and retries only fenced scheduling work without resetting uncertain sends',async()=>{
  const f=await fixture();
  for(let i=0;i<27;i++)f.raw.prepare("INSERT INTO work_tasks(id,generation,kind,reference,status,failures,error,updated_at_ms) VALUES(?,0,'plan',?,'blocked',5,'fixture',0)").run('blocked-'+String(i).padStart(2,'0'),'event-'+i);
  const page=await (await taskStatus(f.env,new URL(origin+'/api/automation/tasks'))).json() as {tasks:{id:string}[];next_cursor:string};
  expect(page.tasks).toHaveLength(25);expect(page.next_cursor).toBe('blocked-24');
  const next=await (await taskStatus(f.env,new URL(origin+'/api/automation/tasks?cursor='+page.next_cursor))).json() as {tasks:unknown[]};expect(next.tasks).toHaveLength(2);
  const req=(id:string,generation=0)=>new Request(origin+'/api/automation/tasks/retry',{method:'POST',body:JSON.stringify({task_id:id,connection_generation:generation})});
  expect((await retryTask(f.env,req('blocked-00',1))).status).toBe(409);
  expect((await retryTask(f.env,req('blocked-00'))).status).toBe(200);
  expect((await retryTask(f.env,req('blocked-00'))).status).toBe(409);
  expect(f.raw.prepare("SELECT status,failures FROM work_tasks WHERE id='blocked-00'").get()).toMatchObject({status:'pending',failures:0});
  f.raw.exec("INSERT INTO work_tasks(id,generation,kind,reference,status,updated_at_ms) VALUES('uncertain',0,'dispatch','missing-or-uncertain','blocked',0)");
  expect((await retryTask(f.env,req('uncertain'))).status).toBe(409);
 });
 it('acknowledges persisted bursts without planning or sending inline, then completes independent tasks',async()=>{
  const f=await fixture();await upsertCampaign(f.db,{campaign_id:'c',media_id:'post',keywords:['LINK'],reward:{type:'text',value:'resource'},copy:{opening:'Tap',delivery:'Here {reward}'}});
  expect((await f.push(hook(Array.from({length:26},(_,i)=>comment(i))))).status).toBe(200);
  expect(f.calls).toHaveLength(0);expect(f.raw.prepare('SELECT COUNT(*) n FROM inbound_events').get()).toMatchObject({n:0});
  expect(f.raw.prepare('SELECT COUNT(*) n FROM ingress_batches').get()).toMatchObject({n:1});
  await f.drain();expect(f.calls).toHaveLength(26);
  expect(f.raw.prepare("SELECT COUNT(*) n FROM outbound_jobs WHERE status='confirmed'").get()).toMatchObject({n:26});
  expect(f.raw.prepare("SELECT COUNT(*) n FROM inbound_events WHERE status!='done'").get()).toMatchObject({n:0});
 });
 it('continues opening, follow, email and reward without owner login and suppresses duplicates',async()=>{
  const f=await fixture();await upsertCampaign(f.db,{campaign_id:'c',media_id:'post',keywords:['LINK'],check_follow:true,ask_email:true,reward:{type:'text',value:'resource'},copy:{opening:'Tap',opening_button:'Continue',follow_button:'I followed',delivery:'Here {reward}'}});
  const original=hook([comment(0)]);await f.push(original);await f.drain();
  async function reply(id:string,payload?:string,text?:string){await f.push({entry:[{messaging:[{sender:{id:'user0'},recipient:{id:'owner'},timestamp:Date.now()+2000,message:{mid:id,text,...(payload?{quick_reply:{payload}}:{})}}]}]});await f.drain();}
  const opening=f.raw.prepare("SELECT id FROM outbound_jobs WHERE action='opening'").get() as {id:string};
  await reply('tap','FL1:'+opening.id);
  const follow=f.raw.prepare("SELECT id FROM outbound_jobs WHERE action='follow_gate'").get() as {id:string};
  await reply('follow','FL1:'+follow.id);await reply('email',undefined,'hello@example.com');
  expect(f.calls).toHaveLength(4);expect(f.raw.prepare('SELECT state,email FROM conversations').get()).toMatchObject({state:'DONE',email:'hello@example.com'});
  await f.push(original);await f.drain();expect(f.calls).toHaveLength(4);
 });
 it('retains work when publication fails and watchdog resumes it without provider replay',async()=>{
  const f=await fixture();await upsertCampaign(f.db,{campaign_id:'c',media_id:'post',keywords:['LINK'],reward:{type:'text',value:'r'},copy:{opening:'Tap',delivery:'r'}});
  const original=f.env.WORK_QUEUE.send;f.env.WORK_QUEUE.send=async()=>{throw new Error('Queue unavailable');};
  expect((await f.push(hook([comment(0)]))).status).toBe(200);expect(f.calls).toHaveLength(0);expect(f.queued).toHaveLength(0);
  f.env.WORK_QUEUE.send=original;f.raw.exec('UPDATE work_tasks SET notification_until_ms=0');
  await worker.scheduled({cron:'* * * * *'} as ScheduledController,f.env);await f.drain();expect(f.calls).toHaveLength(1);
 });
 it('does not let an old lease settle a newer revision or a replacement lease',async()=>{
  const f=await fixture();await taskStatement(f.db,'plan',0,'event').run();
  const old=await claimTask(f.db,taskId('plan',0,'event'),0);expect(old).not.toBeNull();
  await taskStatement(f.db,'plan',0,'event').run();await settleTask(f.db,old!);
  expect(f.raw.prepare('SELECT status,revision FROM work_tasks').get()).toMatchObject({status:'pending',revision:2});
  const current=await claimTask(f.db,old!.id,0);expect(current).not.toBeNull();await settleTask(f.db,old!);
  expect(f.raw.prepare('SELECT lease_token FROM work_tasks').get()).toMatchObject({lease_token:current!.lease_token});
 });
 it('ignores stale generations and duplicate transport delivery after confirmation',async()=>{
  const f=await fixture();await upsertCampaign(f.db,{campaign_id:'c',media_id:'post',keywords:['LINK'],reward:{type:'text',value:'r'},copy:{opening:'Tap',delivery:'r'}});
  await f.push(hook([comment(0)]));await f.drain();const task=f.raw.prepare("SELECT id FROM work_tasks WHERE kind='dispatch'").get() as {id:string};
  const ack=vi.fn();await worker.queue({queue:'send',messages:[{body:{schema:1,taskId:task.id,generation:0},ack,retry:vi.fn()}]} as unknown as MessageBatch<unknown>,f.env);expect(f.calls).toHaveLength(1);
  f.raw.exec('UPDATE instagram_connection_state SET generation=1');await worker.queue({queue:'send',messages:[{body:{schema:1,taskId:task.id,generation:0},ack,retry:vi.fn()}]} as unknown as MessageBatch<unknown>,f.env);
  expect(ack).toHaveBeenCalledTimes(2);expect(f.calls).toHaveLength(1);
 });
});
