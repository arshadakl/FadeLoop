import {describe,it,expect} from 'vitest';
import {Engine} from '../src/engine/engine';
import {SendQueue} from '../src/queue/queue';
import {makeTestDbWithHandle,applyMigration} from './helpers/fakeD1';
import {FakeClient} from './helpers/fakeClient';
import {upsertCampaign} from '../src/db';
import {handleAutomation} from '../src/reliability/status';
import type {Env,Campaign} from '../src/types';
const campaign:Campaign={campaign_id:'c1',media_id:'m1',keywords:['link'],check_follow:true,reward:{type:'text',value:'resource'},copy:{opening:'Tap',delivery:'Here {reward}'}};
function previous(){
 const f=makeTestDbWithHandle('0008');
 f.raw.prepare("INSERT INTO campaigns(campaign_id,media_id,config_json,active,updated_at) VALUES('c1','m1',?,1,10)").run(JSON.stringify(campaign));
 f.raw.exec("INSERT INTO conversations(igsid,campaign_id,state,created_at,updated_at) VALUES('u1','c1','AWAITING_TAP',10,20); INSERT INTO send_claims VALUES('opening:c1:u1',10); INSERT INTO auth(id,access_token,expires_at) VALUES(1,'preserved',9999999999)");
 return f;
}
describe('reliability cutover',()=>{
 it('0010 repairs terminal references, preserves intent and holds lost retry deadlines',async()=>{
  const {db,raw}=makeTestDbWithHandle('0009');await upsertCampaign(db,campaign,true);
  raw.exec(`INSERT INTO conversations(igsid,campaign_id,state,created_at,updated_at,pending_job_id) VALUES
    ('rejected','c1','NEW',10,10,'rejected'),('closed','c1','AWAITING_TAP',10,10,'closed'),('retry','c1','NEW',10,10,'retry'),('completed','c1','DONE',10,10,NULL);
    INSERT INTO inbound_events(id,generation,recipient,source,event_ms,content_json,created_at) VALUES('original',0,'rejected','fixture',5000,'{}',10000);
    INSERT INTO outbound_jobs(id,generation,campaign_id,campaign_instance,recipient,action,event_id,expected_version,request_json,transition_json,status,resolution_source,attempts,error,created_at,updated_at)
      SELECT igsid,0,campaign_id,campaign_instance,igsid,'opening','original',0,'{"text":"preserved"}','{}',
        CASE igsid WHEN 'rejected' THEN 'rejected' WHEN 'closed' THEN 'cancelled' ELSE 'held' END,
        CASE igsid WHEN 'closed' THEN 'owner_closed_unresolved' ELSE NULL END,1,
        CASE igsid WHEN 'retry' THEN 'Campaign paused or archived' ELSE NULL END,10000,10000
      FROM conversations WHERE igsid!='completed';
    INSERT INTO send_claims VALUES('opaque:preserved',10);UPDATE automation_control SET enabled=1;`);
  applyMigration(raw,'0010_reliability_repairs.sql');
  expect(await db.prepare("SELECT lifecycle,pending_job_id,event_boundary_ms FROM conversations WHERE igsid='rejected'").first()).toMatchObject({lifecycle:'failed',pending_job_id:null,event_boundary_ms:5000});
  expect(await db.prepare("SELECT lifecycle,pending_job_id FROM conversations WHERE igsid='closed'").first()).toMatchObject({lifecycle:'closed',pending_job_id:null});
  expect(await db.prepare("SELECT lifecycle FROM conversations WHERE igsid='completed'").first()).toMatchObject({lifecycle:'completed'});
  expect(await db.prepare('SELECT enabled FROM automation_control').first()).toMatchObject({enabled:0});
  expect(await db.prepare('SELECT COUNT(*) n FROM send_claims').first()).toMatchObject({n:1});
  const retry=(await db.prepare("SELECT status,next_at,request_json FROM outbound_jobs WHERE id='retry'").first<{status:string;next_at:number;request_json:string}>())!;
  expect(retry.status).toBe('held');expect(retry.next_at).toBeGreaterThan(Date.now()+86400_000);expect(JSON.parse(retry.request_json).text).toBe('preserved');
  const req=new Request('https://test/api/automation/resolve',{method:'POST',body:JSON.stringify({job_id:'retry',action:'close_unresolved'})});
  expect((await handleAutomation({DB:db} as Env,req,new URL(req.url))).status).toBe(200);
  expect(await db.prepare("SELECT lifecycle,pending_job_id FROM conversations WHERE igsid='retry'").first()).toMatchObject({lifecycle:'closed',pending_job_id:null});
 });
 it('preserves credentials, progress and suppression claims and starts disabled',async()=>{
  const {db,raw}=previous();applyMigration(raw,'0009_reliability.sql');applyMigration(raw,'0010_reliability_repairs.sql');
  expect(await db.prepare('SELECT state,created_at,updated_at,version,pending_job_id,campaign_instance FROM conversations').first()).toMatchObject({state:'AWAITING_TAP',created_at:10,updated_at:20,version:0,pending_job_id:null,campaign_instance:expect.any(String)});
  expect(await db.prepare('SELECT access_token FROM auth').first()).toMatchObject({access_token:'preserved'});
  expect(await db.prepare('SELECT key FROM send_claims').first()).toMatchObject({key:'opening:c1:u1'});
  expect(await db.prepare('SELECT enabled FROM automation_control').first()).toMatchObject({enabled:0});
 });
 it('fails before any external send when the new schema is missing',async()=>{
  const {db}=previous(),client=new FakeClient(),engine=new Engine(db,client.asClient(),new SendQueue());
  await expect(engine.handleComment({kind:'comment',comment_id:'new',igsid:'new',media_id:'m1',text:'link',timestamp:Math.floor(Date.now()/1000)})).rejects.toThrow();
  expect(client.calls.privateReply).toHaveLength(0);
 });
 it('retains queued intent until cutover is explicitly enabled',async()=>{
  const {db,raw}=previous();applyMigration(raw,'0009_reliability.sql');applyMigration(raw,'0010_reliability_repairs.sql');const client=new FakeClient(),engine=new Engine(db,client.asClient(),new SendQueue());
  await engine.handleComment({kind:'comment',comment_id:'new',igsid:'new',media_id:'m1',text:'link',timestamp:Math.floor(Date.now()/1000)});
  expect(client.calls.privateReply).toHaveLength(0);expect(await db.prepare('SELECT COUNT(*) n FROM outbound_jobs').first()).toMatchObject({n:1});
  await db.prepare('UPDATE automation_control SET enabled=1,account_interval_ms=0,recipient_interval_ms=0').run();await db.prepare('UPDATE outbound_jobs SET next_at=0').run();await engine.drain();
  expect(client.calls.privateReply).toHaveLength(1);
 });
 it('legacy in-progress funnels complete without another opening',async()=>{
  const {db,raw}=previous();applyMigration(raw,'0009_reliability.sql');applyMigration(raw,'0010_reliability_repairs.sql');await db.prepare('UPDATE automation_control SET enabled=1,account_interval_ms=0,recipient_interval_ms=0').run();
  const client=new FakeClient(),engine=new Engine(db,client.asClient(),new SendQueue());const timestamp=Math.floor(Date.now()/1000);
  await engine.handleMessage({kind:'message',igsid:'u1',message_id:'a',timestamp,payload:'OPENING_TAP:c1'});
  await engine.handleMessage({kind:'message',igsid:'u1',message_id:'b',timestamp,payload:'FOLLOW_CONFIRM:c1'});
  expect(client.calls.privateReply).toHaveLength(0);expect(client.calls.button).toHaveLength(1);expect(client.calls.text).toHaveLength(1);
  expect(await db.prepare('SELECT state FROM conversations').first()).toMatchObject({state:'DONE'});
 });
 it('a legacy downstream claim suppresses automatic replay',async()=>{
  const {db,raw}=previous();raw.exec("INSERT INTO send_claims VALUES('follow_gate:c1:u1',10)");applyMigration(raw,'0009_reliability.sql');applyMigration(raw,'0010_reliability_repairs.sql');await db.prepare('UPDATE automation_control SET enabled=1').run();
  const client=new FakeClient(),engine=new Engine(db,client.asClient(),new SendQueue());
  await engine.handleMessage({kind:'message',igsid:'u1',message_id:'a',timestamp:Math.floor(Date.now()/1000),payload:'OPENING_TAP:c1'});
  expect(client.calls.button).toHaveLength(0);expect(await db.prepare('SELECT status FROM outbound_jobs').first()).toMatchObject({status:'unknown'});
 });
});
