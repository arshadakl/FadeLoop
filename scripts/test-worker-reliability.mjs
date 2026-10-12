// Disposable workerd/D1. Every provider call is intercepted; no real recipients or credentials.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHmac} from 'node:crypto';
import {applyLocalMigrations} from './local-migrations.mjs';
mkdirSync('.wrangler/reliability-runtime',{recursive:true});
const scriptPath=resolve('.wrangler/reliability-runtime/index.js');
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import worker from './src/index';
export default {async fetch(req,env){
 const originals=new WeakMap(),metrics={queries:0,rows_read:0,rows_written:0};
 function record(r){metrics.queries++;metrics.rows_read+=r.meta?.rows_read??0;metrics.rows_written+=r.meta?.rows_written??0;return r;}
 function wrap(s){const p=new Proxy(s,{get(t,k){if(k==='bind')return(...a)=>wrap(t.bind(...a));if(k==='first')return async()=>{const r=record(await t.all());return r.results[0]??null;};if(['run','all','raw'].includes(k))return async(...a)=>record(await t[k](...a));const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});originals.set(p,s);return p;}
 const db=new Proxy(env.DB,{get(t,k){if(k==='prepare')return sql=>wrap(t.prepare(sql));if(k==='batch')return async ss=>(await t.batch(ss.map(s=>originals.get(s)??s))).map(record);const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
 let response;
 if(new URL(req.url).pathname==='/__cron'){const polling=new URL(req.url).searchParams.has('poll');await worker.scheduled({cron:'* * * * *',scheduledTime:Date.now()},{...env,DB:db,...(polling?{MODE:'polling',POLL_INTERVAL_SECONDS:'30',AUTOMATION_MAINTENANCE:'true'}:{})});response=new Response('cron');}
 else response=await worker.fetch(req,{...env,DB:db});
 return new Response(response.body,{status:response.status,headers:{...Object.fromEntries(response.headers),'x-test-metrics':JSON.stringify(metrics)}});
}};`},bundle:true,format:'esm',platform:'browser',outfile:scriptPath,loader:{'.wasm':'file'}});
let sends=0,mode='confirmed';
const profileLabel=process.env.PROFILE_WORKER_CPU;
const mf=new Miniflare({...(profileLabel?{inspectorPort:0}:{}),modules:true,scriptPath,modulesRules:[{type:'CompiledWasm',include:['**/*.wasm']}],compatibilityDate:'2025-07-01',compatibilityFlags:['nodejs_compat'],
 d1Databases:{DB:'reliability-runtime-disposable'},bindings:{MODE:'webhook',WEBHOOK_RECONCILE_SECONDS:'off',GRAPH_VERSION:'v23.0',APP_SECRET:'fixture-secret'},
 outboundService:async request=>{
  assert.equal(new URL(request.url).hostname,'graph.instagram.com');
  if(request.method==='POST'){sends++;if(mode==='body-timeout'){let timer;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"message_id":'));timer=setTimeout(()=>{controller.enqueue(new TextEncoder().encode('"late"}'));controller.close();},20000);},cancel(){clearTimeout(timer);}}),{headers:{'content-type':'application/json'}});}return mode==='unknown'?Response.json({error:{message:'Simulated accepted-send failure'}},{status:500}):Response.json({message_id:`fixture-${sends}`});}
  const path=new URL(request.url).pathname;
  if(path.endsWith('/comments') && new URL(request.url).searchParams.get('fields')==='id,timestamp'){
   assert.equal(new URL(request.url).searchParams.get('fields'),'id,timestamp');
   return Response.json({data:[{id:'missing-time',timestamp:new Date().toISOString()}]});
  }
  if(path.endsWith('/comments'))return Response.json({data:Array.from({length:50},(_,i)=>({id:`polled-comment-${i}`,text:'LINK',from:{id:`polled-user-${i}`},timestamp:new Date().toISOString()})),paging:{next:'https://graph.instagram.com/ignored',cursors:{after:'next-comments'}}});
  if(path.endsWith('/conversations'))return Response.json({data:Array.from({length:20},(_,i)=>({id:`thread-${i}`})),paging:{next:'https://graph.instagram.com/ignored',cursors:{after:'next-threads'}}});
  if(path.endsWith('/messages'))return Response.json({data:Array.from({length:50},(_,i)=>({id:`polled-message-${i}`,message:'hello',from:{id:`message-user-${i}`},created_time:new Date().toISOString()})),paging:{next:'https://graph.instagram.com/ignored',cursors:{after:'next-messages'}}});
  return Response.json({data:[]});
 },
});
let profiler;
try{
 const db=await mf.getD1Database('DB');await applyLocalMigrations(db);
 await db.prepare("INSERT INTO auth(id,access_token,ig_user_id,expires_at) VALUES(1,'fixture-only','owner',9999999999)").run();
 const campaign={campaign_id:'fixture',media_id:'post',keywords:['LINK'],reward:{type:'text',value:'Resource'},copy:{opening:'Tap',delivery:'Resource'}};
 await db.prepare("INSERT INTO campaigns(campaign_id,media_id,config_json,active,updated_at,instance_id,active_since) VALUES('fixture','post',?,1,0,'instance',0)").bind(JSON.stringify(campaign)).run();
 if(profileLabel){
  const inspector=await mf.getInspectorURL();
  inspector.protocol='http:';
  const targets=await (await fetch(new URL('/json/list',inspector))).json();
  const socket=new WebSocket(targets.find(t=>t.type==='node'||t.type==='worker')?.webSocketDebuggerUrl??targets[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let sequence=0;const pending=new Map();
  socket.onmessage=({data})=>{const result=JSON.parse(data);if(result.id){const callback=pending.get(result.id);pending.delete(result.id);result.error?callback.reject(result.error):callback.resolve(result.result);}};
  const command=(method)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method}));});
  await command('Profiler.enable');await command('Profiler.start');
  profiler={command,socket};
 }
 const report=[];
 async function invoke(path,body){
  const raw=JSON.stringify(body),start=performance.now();
  const response=await mf.dispatchFetch(`https://fixture.test${path}`,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','fixture-secret').update(raw).digest('hex')},body:raw});
  const metrics=JSON.parse(response.headers.get('x-test-metrics'));assert.ok(metrics.queries<=40,JSON.stringify(metrics));assert.equal(response.status,200,await response.text());
  report.push({path,...metrics,wall_ms:Math.round(performance.now()-start)});
 }
 const event=(id,recipient)=>({field:'comments',value:{id,text:'LINK',from:{id:recipient},media:{id:'post'},timestamp:new Date().toISOString()}});
 await invoke('/webhook',{entry:[{changes:[event('disabled','disabled')]}]});assert.equal(sends,0);
 await db.prepare('UPDATE automation_control SET enabled=1,account_interval_ms=0,recipient_interval_ms=0').run();
 await db.prepare('UPDATE outbound_jobs SET next_at=0').run();await invoke('/__cron',{});assert.equal(sends,1);
 await invoke('/webhook',{entry:[{changes:Array.from({length:501},()=>event('duplicate','one-user'))}]});
 for(let i=0;i<3;i++)await invoke('/__cron',{});
 assert.equal(sends,2);assert.equal((await db.prepare("SELECT COUNT(*) n FROM outbound_jobs WHERE recipient='one-user'").first()).n,1);
 mode='unknown';await invoke('/webhook',{entry:[{changes:[event('unknown','uncertain-user')]}]});
 for(let i=0;i<4;i++)await invoke('/__cron',{});
 assert.equal(sends,3);assert.equal((await db.prepare("SELECT status,attempts FROM outbound_jobs WHERE recipient='uncertain-user'").first()).status,'unknown');
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM events WHERE igsid='uncertain-user'").first()).n,0);
 mode='body-timeout';await invoke('/webhook',{entry:[{changes:[event('body-timeout','timeout-user')]}]});
 assert.equal(sends,4);assert.equal((await db.prepare("SELECT status FROM outbound_jobs WHERE recipient='timeout-user'").first()).status,'unknown');
 await invoke('/__cron',{});assert.equal(sends,4);
 // Persistence failure must not ACK or send. A real trigger forces transactional rollback.
 await db.prepare("CREATE TRIGGER fail_inbox BEFORE INSERT ON inbound_events BEGIN SELECT RAISE(ABORT,'injected outage'); END").run();
 const raw=JSON.stringify({entry:[{changes:[event('outage','outage')]}]});
 const failed=await mf.dispatchFetch('https://fixture.test/webhook',{method:'POST',headers:{'x-hub-signature-256':'sha256='+createHmac('sha256','fixture-secret').update(raw).digest('hex')},body:raw});
 assert.equal(failed.status,503);assert.equal(sends,4);await db.prepare('DROP TRIGGER fail_inbox').run();
 await db.prepare('UPDATE auth SET expires_at=0').run();mode='confirmed';
 await invoke('/webhook',{entry:[{changes:[event('expired-auth','expired-auth-user')]}]});assert.equal(sends,4);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM inbound_events WHERE recipient='expired-auth-user'").first()).n,1);
 await db.prepare('UPDATE auth SET expires_at=9999999999').run();
 await db.prepare("DELETE FROM kv WHERE key='last_poll_ts'").run();
 await invoke('/__cron?poll',{});assert.equal(sends,4);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM inbound_events WHERE source='comment-poll'").first()).n,50);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM inbound_events WHERE source='message-poll'").first()).n,50);
 await db.prepare('UPDATE automation_control SET enabled=0').run();
 const missingTime=event('missing-time','missing-time-user');delete missingTime.value.timestamp;
 await invoke('/webhook',{entry:[{changes:[missingTime]}]});assert.equal(sends,4);
 const resolved=await db.prepare("SELECT event_ms,content_json FROM inbound_events WHERE recipient='missing-time-user'").first();
 assert.ok(resolved.event_ms>0);assert.ok(JSON.parse(resolved.content_json).timestamp>0);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM outbound_jobs WHERE recipient='missing-time-user'").first()).n,1);
 writeFileSync('.wrangler/reliability-runtime/results.json',JSON.stringify({provider_attempts:sends,invocations:report,limits:'Local SQL and wall time only; deployed CPU/memory and provider contracts require staging.'},null,2));
 console.log(`workerd/D1 reliability passed: disabled cutover, 501 duplicate events, HTTP 500 and response-body timeout unknown/no replay, inbox rollback/503, expired-auth ingestion, full polling pages; ${report.length} invocations, maximum ${Math.max(...report.map(r=>r.queries))} SQL statements. No real Instagram requests.`);
}finally{
 if(profiler){
  const {profile}=await profiler.command('Profiler.stop');profiler.socket.close();
  const label=profileLabel.replace(/[^a-z0-9_-]/gi,'_');
  writeFileSync(`.wrangler/reliability-runtime/${label}.cpuprofile`,JSON.stringify(profile));
  const nodes=new Map(profile.nodes.map(n=>[n.id,n]));const totals=new Map();
  for(let i=0;i<(profile.samples??[]).length;i++){
   const frame=nodes.get(profile.samples[i]).callFrame;
   const key=`${frame.functionName||'(anonymous)'} ${frame.url}:${frame.lineNumber+1}`;
   totals.set(key,(totals.get(key)??0)+(profile.timeDeltas[i]??0));
  }
  console.log('Sampled workerd profile (microseconds, includes waits; not billed CPU):', [...totals].sort((a,b)=>b[1]-a[1]).slice(0,20));
 }
 await mf.dispose();
}
