import {describe,it,expect,vi,afterEach} from 'vitest';
import {budgetDatabase,remainingQueries,queryBudget,reserveQueries,WorkBudgetExceeded} from '../src/reliability/budget';
import {guardedConnectionDb} from '../src/connection';
import {cleanupRetention} from '../src/reliability/retention';
import {cleanupTaskRetention} from '../src/tasks/retention';
import {Engine} from '../src/engine/engine';
import {InstagramClient,ProviderRequestNotStarted} from '../src/api/client';
import {SendQueue} from '../src/queue/queue';
import {makeTestDbWithHandle} from './helpers/fakeD1';
import {FakeClient} from './helpers/fakeClient';
import {upsertCampaign} from '../src/db';
afterEach(()=>vi.unstubAllGlobals());
function fixture(){const f=makeTestDbWithHandle();f.raw.exec("INSERT INTO auth(id,access_token,ig_user_id,expires_at) VALUES(1,'fixture','owner',9999999999);UPDATE automation_control SET enabled=1,account_interval_ms=0,recipient_interval_ms=0");return f;}
describe('invocation work correctness',()=>{
 it('bounds task cleanup, scrubs completed payloads, and preserves unfinished and blocked evidence',async()=>{
  const f=fixture(),now=Date.now(),old=now-8*86400_000;
  for(const [id,status] of [['complete','done'],['pending','pending'],['blocked','blocked']] as const){
   f.raw.prepare('INSERT INTO work_tasks(id,generation,kind,reference,status,updated_at_ms) VALUES(?,0,\'normalize\',?,?,?)').run(id,id,status,old);
   f.raw.prepare('INSERT INTO ingress_batches(id,generation,source,raw_json,status,created_at_ms,updated_at_ms) VALUES(?,0,\'webhook\',\'{"text":"private"}\',?,?,?)').run(id,status==='done'?'done':'pending',old,old);
  }
  f.raw.prepare('INSERT INTO ingress_batches(id,generation,source,raw_json,status,created_at_ms,updated_at_ms) VALUES(\'recent\',0,\'webhook\',\'{"text":"private"}\',\'done\',?,?)').run(now,now);
  await cleanupTaskRetention(f.db,now,1);
  expect(f.raw.prepare("SELECT COUNT(*) n FROM work_tasks WHERE status='done'").get()).toMatchObject({n:0});
  expect(f.raw.prepare('SELECT COUNT(*) n FROM work_tasks').get()).toMatchObject({n:2});
  expect(f.raw.prepare('SELECT COUNT(*) n FROM ingress_batches').get()).toMatchObject({n:3});
  await cleanupTaskRetention(f.db,now,1);
  expect(f.raw.prepare("SELECT raw_json FROM ingress_batches WHERE id='recent'").get()).toMatchObject({raw_json:'{}'});
  expect(f.raw.prepare("SELECT raw_json FROM ingress_batches WHERE id='pending'").get()).toMatchObject({raw_json:'{"text":"private"}'});
 });
 it('shares finite accounting through guards and does not spend diagnostic queries after denied submission',async()=>{
  const f=fixture(),raw=budgetDatabase(f.db,3),guarded=guardedConnectionDb(raw,0);
  await guarded.prepare("INSERT INTO kv VALUES('fixture','1',0)").run();
  expect(remainingQueries(raw)).toBe(1);expect(remainingQueries(guarded)).toBe(1);
  await expect(guarded.prepare("UPDATE kv SET value='2'").run()).rejects.toBeInstanceOf(WorkBudgetExceeded);
  expect(remainingQueries(raw)).toBe(1);expect(f.raw.prepare('SELECT value FROM kv').get()).toMatchObject({value:'1'});
 });
 it('protects completion capacity from ordinary work and prevents overspending an exhausted reservation',async()=>{
  const f=fixture(),db=budgetDatabase(f.db,5),reserve=reserveQueries(db,3)!;
  expect(remainingQueries(db)).toBe(2);await db.prepare('SELECT 1').first();await db.prepare('SELECT 1').first();
  expect(()=>db.prepare('SELECT 1').first()).toThrow(WorkBudgetExceeded);
  await reserve.run(async()=>{for(let i=0;i<3;i++)await db.prepare('SELECT 1').first();expect(()=>db.prepare('SELECT 1').first()).toThrow(WorkBudgetExceeded);});reserve.release();
  expect(queryBudget(db)?.used).toBe(5);expect(remainingQueries(db)).toBe(0);
 });
 it('never starts an external attempt when completion capacity is insufficient',async()=>{
  for(const limit of [6,7,12,16,17,18,20,25]){
   const f=fixture();await upsertCampaign(f.db,{campaign_id:'c',media_id:'p',keywords:['LINK'],reward:{type:'text',value:'r'},copy:{opening:'Tap',delivery:'r'}});
   const client=new FakeClient(),planner=new Engine(f.db,client.asClient(),new SendQueue(),{maintenance:true});
   await planner.handleComment({kind:'comment',comment_id:'e',igsid:'u',media_id:'p',text:'LINK',timestamp:Math.floor(Date.now()/1000)+1});
   const raw=budgetDatabase(f.db,limit),guarded=guardedConnectionDb(raw,0),sender=new Engine(guarded,client.asClient(),new SendQueue(),{remainingQueries:()=>remainingQueries(raw)});
   await sender.dispatchOne();
   const status=(f.raw.prepare('SELECT status FROM outbound_jobs').get() as {status:string}).status;
   expect(status).not.toBe('sending');expect(client.calls.privateReply.length).toBe(status==='confirmed'?1:0);
   if(limit<18){expect(status).toBe('pending');expect(f.raw.prepare('SELECT COUNT(*) n FROM send_attempts').get()).toMatchObject({n:0});}
   expect(queryBudget(raw)!.used).toBeLessThanOrEqual(limit);
  }
 });
 it('classifies failed preflight as never started rather than ambiguous delivery',async()=>{
  const client=new InstagramClient('fixture','v23.0','owner',async()=>{throw new Error('D1 unavailable');});
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(client.sendText('u','hello')).rejects.toBeInstanceOf(ProviderRequestNotStarted);expect(fetch).not.toHaveBeenCalled();
 });
 it('uses millisecond cutoffs for reliability rows, preserves pending data and caps cleanup',async()=>{
  const f=fixture(),now=Date.now(),old=now-10*86400_000;
  for(let i=0;i<4;i++){
   f.raw.prepare('INSERT INTO send_attempts VALUES(?,?,0,?,1,?)').run('attempt'+i,'job'+i,'u',old);
   f.raw.prepare("INSERT INTO inbound_events(id,generation,recipient,source,event_ms,content_json,status,created_at) VALUES(?,0,'u','test',0,'{}','done',?)").run('done'+i,old);
  }
  f.raw.prepare("INSERT INTO inbound_events(id,generation,recipient,source,event_ms,content_json,status,created_at) VALUES('pending',0,'u','test',0,'{}','pending',?)").run(old);
  await cleanupRetention(f.db,now,2);
  expect(f.raw.prepare('SELECT COUNT(*) n FROM send_attempts').get()).toMatchObject({n:2});expect(f.raw.prepare("SELECT COUNT(*) n FROM inbound_events WHERE status='done'").get()).toMatchObject({n:2});
  await cleanupRetention(f.db,now,2);
  expect(f.raw.prepare('SELECT COUNT(*) n FROM send_attempts').get()).toMatchObject({n:0});expect(f.raw.prepare('SELECT COUNT(*) n FROM inbound_events').get()).toMatchObject({n:1});
 });
});
