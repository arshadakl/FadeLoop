import {describe,it,expect,vi,afterEach} from 'vitest';
import {InstagramClient,InstagramApiError} from '../src/api/client';
import {pollComments} from '../src/poller/commentPoll';
import {makeTestDb} from './helpers/fakeD1';
import {Engine} from '../src/engine/engine';
import {SendQueue} from '../src/queue/queue';
import {upsertCampaign} from '../src/db';
import {FakeClient} from './helpers/fakeClient';
import type {Runtime} from '../src/runtime';
afterEach(()=>vi.restoreAllMocks());
describe('bounded Graph pagination',()=>{
 it('uses the known Graph host with an opaque cursor, ignoring the next URL',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({data:[{id:'c'}],paging:{next:'https://untrusted.test/steal',cursors:{after:'opaque+/:?cursor'}}}));
  const client=new InstagramClient('fixture','v23.0','owner');const first=await client.getCommentsPage('post');
  await client.getCommentsPage('post',first.cursor!);
  const url=new URL(String(fetch.mock.calls[1]![0]));expect(url.hostname).toBe('graph.instagram.com');expect(url.searchParams.get('after')).toBe('opaque+/:?cursor');
 });
 it('does not silently commit an unsupported continuation contract',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({data:[],paging:{next:'https://graph.instagram.com/next'}}));
  await expect(new InstagramClient('fixture','v23.0','owner').getConversationsPage()).rejects.toThrow(/pagination/);
 });
 it('persists all 120 comments over three pages and sends at most once per lead',async()=>{
  const db=makeTestDb(),client=new FakeClient();const timestamp=new Date(Date.now()+1000).toISOString();
  await upsertCampaign(db,{campaign_id:'c',media_id:'post',keywords:['link'],reward:{type:'text',value:'r'},copy:{opening:'Tap',delivery:'r'}});
  const engine=new Engine(db,client.asClient(),new SendQueue(),{igUserId:'owner'});
  const runtime={auth:{connection_generation:0},igUserId:'owner',engine,client:{getCommentsPage:async(_id:string,cursor?:string)=>{
   const start=Number(cursor??0),length=Math.min(50,120-start);return {data:Array.from({length},(_,i)=>({id:`comment${start+i}`,from:{id:`user${start+i}`},text:'link',timestamp})),cursor:start+length<120?String(start+length):null};
  }}} as unknown as Runtime;
  for(let i=0;i<3;i++)await pollComments(runtime,db);
  for(let i=0;i<20;i++)await engine.drain();
  expect(await db.prepare('SELECT COUNT(*) n FROM inbound_events').first()).toMatchObject({n:120});expect(client.calls.privateReply).toHaveLength(120);
 });
 it('restarts an expired cursor while retaining the cutover boundary',async()=>{
  const db=makeTestDb();await upsertCampaign(db,{campaign_id:'c',media_id:'post',keywords:['link'],reward:{type:'text',value:'r'},copy:{opening:'Tap',delivery:'r'}});
  await db.prepare("INSERT INTO polling_checkpoints(key,generation,cursor,boundary,updated_at) VALUES('comments:post',0,'expired',123,0)").run();
  const rt={auth:{connection_generation:0},igUserId:'owner',client:{getCommentsPage:async()=>{throw new InstagramApiError('invalid cursor',400,100);}}} as unknown as Runtime;
  await pollComments(rt,db);expect(await db.prepare("SELECT cursor,boundary FROM polling_checkpoints WHERE key='comments:post'").first()).toMatchObject({cursor:null,boundary:123});
 });
});
