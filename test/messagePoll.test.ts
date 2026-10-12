import {describe,it,expect} from 'vitest';
import {pollMessages} from '../src/poller/messagePoll';
import {Engine} from '../src/engine/engine';
import {SendQueue} from '../src/queue/queue';
import {makeTestDb} from './helpers/fakeD1';
import {FakeClient} from './helpers/fakeClient';
import {kvGet,kvSet,now} from '../src/db';
import type {Runtime} from '../src/runtime';
import {pollComments} from '../src/poller/commentPoll';
import {upsertCampaign} from '../src/db';
import {InstagramApiError} from '../src/api/client';
import {ConnectionCheckFailedError} from '../src/connection';
async function harness(throws=false){
 const db=makeTestDb(),client=new FakeClient();let reads=0;
 const rt={db,auth:{connection_generation:0},igUserId:'owner',engine:new Engine(db,client.asClient(),new SendQueue()),client:{
  getConversationsPage:async()=>{if(throws)throw new Error('provider failed');return {data:Array.from({length:25},(_,i)=>({id:String(i)})),cursor:null};},
  getMessagesPage:async(id:string,cursor?:string)=>{reads++;return {data:Array.from({length:15},(_,i)=>({id:`${id}:${cursor??'first'}:${i}`,from:{id:`u${id}`},message:'hi',created_time:new Date(Date.now()+i).toISOString()})),cursor:cursor?null:'second'};},
 }} as unknown as Runtime;
 return {db,rt,reads:()=>reads};
}
describe('resumable message discovery',()=>{
 it('database preflight failure is not recorded as a provider failure',async()=>{
  const f=await harness();f.rt.client.getConversationsPage=async()=>{throw new ConnectionCheckFailedError();};
  await expect(pollMessages(f.rt,f.db)).rejects.toThrow('database check');
  expect(await f.db.prepare("SELECT failure_count,last_error FROM polling_checkpoints WHERE key='conversations'").first()).toMatchObject({failure_count:0,last_error:null});
  expect(await kvGet(f.db,'last_msg_poll_error')).toBeNull();
 });
 it('a failed thread backs off while healthy threads progress',async()=>{
  const f=await harness(),reads:string[]=[];
  f.rt.client.getMessagesPage=async(id:string)=>{reads.push(id);if(id==='0')throw new InstagramApiError('bad thread',403,10);return {data:[],cursor:null};};
  for(let i=0;i<3;i++)await pollMessages(f.rt,f.db);
  expect(reads).toEqual(['0','1','10']);
  expect(await f.db.prepare("SELECT failure_count,next_at,last_error FROM polling_checkpoints WHERE key='messages:0'").first()).toMatchObject({failure_count:1,last_error:expect.any(String),next_at:expect.any(Number)});
  expect(await kvGet(f.db,'last_msg_poll_error')).not.toBeNull();
 });
 it('discovery failure does not block an already known thread',async()=>{
  const f=await harness(true);await f.db.prepare("INSERT INTO polling_checkpoints(key,generation,boundary,updated_at) VALUES('messages:known',0,0,0)").run();
  await pollMessages(f.rt,f.db);expect(f.reads()).toBe(1);
  expect(await f.db.prepare("SELECT failure_count FROM polling_checkpoints WHERE key='conversations'").first()).toMatchObject({failure_count:1});
  expect(await kvGet(f.db,'last_msg_poll_error')).not.toBeNull();
 });
 it('a failing media object cannot monopolize comment polling',async()=>{
  const f=await harness(),reads:string[]=[];
  for(const id of ['a','b','c'])await upsertCampaign(f.db,{campaign_id:id,media_id:id,keywords:['link'],reward:{type:'text',value:'x'},copy:{opening:'Open',delivery:'Reward'}},true);
  f.rt.client.getCommentsPage=async(id:string)=>{reads.push(id);if(id==='a')throw new InstagramApiError('bad media',403,10);return {data:[],cursor:null};};
  for(let i=0;i<3;i++)await pollComments(f.rt,f.db);
  expect(reads).toEqual(['a','b','c']);expect(await kvGet(f.db,'last_comment_poll_error')).not.toBeNull();
 });
 it('provider backoff grows and honors a longer Retry-After',async()=>{
  const f=await harness(true);f.rt.client.getConversationsPage=async()=>{throw new InstagramApiError('rate',429,4,undefined,'trace',600);};
  const t=Date.now();await pollMessages(f.rt,f.db);
  expect((await f.db.prepare("SELECT next_at FROM polling_checkpoints WHERE key='conversations'").first<{next_at:number}>())!.next_at).toBeGreaterThanOrEqual(t+600_000);
  await f.db.prepare("UPDATE polling_checkpoints SET next_at=0 WHERE key='conversations'").run();
  f.rt.client.getConversationsPage=async()=>{throw new Error('network');};await pollMessages(f.rt,f.db);
  expect(await f.db.prepare("SELECT failure_count,next_at FROM polling_checkpoints WHERE key='conversations'").first()).toMatchObject({failure_count:2,next_at:expect.any(Number)});
 });
 it('records wall-clock health independently of message timestamps',async()=>{
  const f=await harness();await kvSet(f.db,'last_msg_poll_ts','100');await pollMessages(f.rt,f.db);
  expect(Number(await kvGet(f.db,'last_msg_poll_ts'))).toBeGreaterThanOrEqual(now()-1);expect(f.reads()).toBe(1);
 });
 it('retains previous completion and records a sanitized discovery failure',async()=>{
  const f=await harness(true);await kvSet(f.db,'last_msg_poll_ts','100');await pollMessages(f.rt,f.db);
  expect(await kvGet(f.db,'last_msg_poll_ts')).toBe('100');expect(await kvGet(f.db,'last_msg_poll_error')).toContain('Provider read failed');expect(f.reads()).toBe(0);
 });
 it('discovers over twenty threads and ten messages per thread fairly',async()=>{
  const f=await harness();for(let i=0;i<50;i++)await pollMessages(f.rt,f.db);
  expect(f.reads()).toBe(50);expect(await f.db.prepare('SELECT COUNT(*) n FROM inbound_events').first()).toMatchObject({n:750});
  expect(await f.db.prepare("SELECT COUNT(DISTINCT recipient) n FROM inbound_events").first()).toMatchObject({n:25});
  expect(await f.db.prepare("SELECT COUNT(*) n FROM polling_checkpoints WHERE key LIKE 'messages:%' AND cursor IS NULL").first()).toMatchObject({n:25});
 });
 it('persists a page before its continuation and deduplicates overlap',async()=>{
  const f=await harness();await pollMessages(f.rt,f.db);
  expect(await f.db.prepare("SELECT cursor FROM polling_checkpoints WHERE key='messages:0'").first()).toMatchObject({cursor:'second'});
  expect(await f.db.prepare('SELECT COUNT(*) n FROM inbound_events').first()).toMatchObject({n:15});
  await f.db.prepare("UPDATE polling_checkpoints SET cursor=NULL,last_attempt_at=-1,next_at=0 WHERE key='messages:0'").run();await pollMessages(f.rt,f.db);
  expect(await f.db.prepare('SELECT COUNT(*) n FROM inbound_events').first()).toMatchObject({n:15});
 });
});
