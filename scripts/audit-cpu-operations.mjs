// Investigation only: real application code + disposable workerd/D1, mocked provider.
// Counts work, NOT Cloudflare billed CPU. Never loads .env or remote bindings.
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { argon2id } from 'hash-wasm';
import { applyLocalMigrations } from './local-migrations.mjs';
import {evidenceManifest} from './evidence-manifest.mjs';

const out = resolve('.wrangler/cpu-investigation');
mkdirSync(out, { recursive: true });
const bundled = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
import worker from './src/index';
import {buildRuntime} from './src/runtime';
import {budgetDatabase,remainingQueries,WorkBudgetExceeded} from './src/reliability/budget';
import {pollMessages} from './src/poller/messagePoll';
import {pollComments} from './src/poller/commentPoll';
import {hashPassword,verifyPassword} from './src/auth/password';
export default {async fetch(req,env){
 const metrics={statements:0,round_trips:0,guards:0,rows_read:0,rows_written:0,bind_json_bytes:0,returned_json_bytes:0,sql:{}};
 const originals=new WeakMap();
 function note(sql){metrics.statements++;if(sql.includes('THEN generation ELSE -1'))metrics.guards++;
  const key=sql.replace(/\\s+/g,' ').trim();metrics.sql[key]=(metrics.sql[key]??0)+1;}
 function record(r){metrics.rows_read+=r.meta?.rows_read??0;metrics.rows_written+=r.meta?.rows_written??0;
  metrics.returned_json_bytes+=JSON.stringify(r).length;return r;}
 function wrap(s,sql){const p=new Proxy(s,{get(t,k){
  if(k==='bind')return(...a)=>{metrics.bind_json_bytes+=JSON.stringify(a).length;return wrap(t.bind(...a),sql);};
  if(k==='first')return async(column)=>{note(sql);metrics.round_trips++;const r=record(await t.all());const first=r.results[0]??null;return column&&first?first[column]:first;};
  if(['run','all','raw'].includes(String(k)))return async(...a)=>{note(sql);metrics.round_trips++;return record(await t[k](...a));};
  const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;
 }});originals.set(p,{s,sql});return p;}
 const db=new Proxy(env.DB,{get(t,k){
  if(k==='prepare')return sql=>wrap(t.prepare(sql),sql);
  if(k==='batch')return async ss=>{metrics.round_trips++;const raw=ss.map(s=>{const x=originals.get(s);if(!x)throw Error('unwrapped audit statement');note(x.sql);return x.s;});return(await t.batch(raw)).map(record);};
  const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;
 }});
 const url=new URL(req.url),pending=[];let response,status;
 try{
  if(url.pathname==='/__audit/hash'){
   const body=await req.json();const ok=body.hash?await verifyPassword('fixture-password',body.hash):!!await hashPassword('fixture-password');response=Response.json({ok});
  }else if(url.pathname.startsWith('/__audit/')){
   const raw=budgetDatabase(db,Number(url.searchParams.get('budget'))||40),rt=await buildRuntime({...env,DB:raw},true);
   if(!rt)throw Error('missing fixture runtime');
   if(url.pathname==='/__audit/messages')await pollMessages(rt,rt.db);
   if(url.pathname==='/__audit/comments')await pollComments(rt,rt.db);
   if(url.pathname==='/__audit/drain')await rt.engine.drain(Number(url.searchParams.get('steps'))||1);
   if(url.pathname==='/__audit/dispatch')await rt.engine.dispatchOne();
   if(url.pathname==='/__audit/ingest')await rt.engine.ingest(await req.json(),'audit');
   response=Response.json({remaining_raw:remainingQueries(raw),remaining_guarded:String(remainingQueries(rt.db))});
  }else if(url.pathname==='/__cron'){
   await worker.scheduled({cron:url.searchParams.get('daily')?'0 3 * * *':'*/15 * * * *'}, {...env,DB:db});response=Response.json({ok:true});
  }else{
   response=await worker.fetch(req,{...env,DB:db},{waitUntil(p){pending.push(p);}});
   await Promise.allSettled(pending);
  }
  status=response.status;
  const body=await response.text();return Response.json({status,response_bytes:new TextEncoder().encode(body).length,metrics,
   ...(url.pathname.startsWith('/__audit/')?{audit:JSON.parse(body)}:{})});
 }catch(error){return Response.json({status:error instanceof WorkBudgetExceeded?503:500,classification:error instanceof WorkBudgetExceeded?'work-budget':'execution-failed',error:String(error),metrics});}
}};` }, bundle: true, format: 'esm', platform: 'browser', outfile: resolve(out, 'worker.js'),
  loader: { '.wasm': 'copy' }, metafile: true, sourcemap: true });
writeFileSync(resolve(out, 'bundle-meta.json'), JSON.stringify(bundled.metafile, null, 2));
let providerMode = 'empty', sends = 0, gets = 0;
const fixtureNow = () => new Date().toISOString();
const mf = new Miniflare({ modules: true, scriptPath: resolve(out, 'worker.js'), inspectorPort: 0,
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  compatibilityDate: '2025-07-01', compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'cpu-investigation-disposable' }, bindings: {
    MODE: 'webhook', WEBHOOK_RECONCILE_SECONDS: '900', GRAPH_VERSION: 'v23.0', APP_SECRET: 'fixture-secret',
  }, outboundService: async req => {
    assert.equal(new URL(req.url).hostname, 'graph.instagram.com');
    if (req.method === 'POST') {
      sends++;
      return providerMode === 'failure' ? Response.json({error:{message:'fixture failure'}}, {status:500})
        : Response.json({ message_id: 'fixture-' + sends, id: 'reply-' + sends });
    }
    gets++;
    const path = new URL(req.url).pathname;
    if (providerMode !== 'pages') return Response.json({data:[]});
    const paging = {next:'https://graph.instagram.com/fixture',cursors:{after:'next-fixture'}};
    if (path.endsWith('/conversations')) return Response.json({data:Array.from({length:20},(_,i)=>({id:'thread-'+i})),paging});
    if (path.endsWith('/messages')) return Response.json({data:Array.from({length:50},(_,i)=>({id:'msg-'+i,from:{id:'msg-user-'+i},message:'hello',created_time:fixtureNow()})),paging});
    if (path.endsWith('/comments')) return Response.json({data:Array.from({length:50},(_,i)=>({id:path+'-comment-'+i,from:{id:'user-'+i},text:'LINK',timestamp:fixtureNow()})),paging});
    throw Error('Unexpected provider route');
  },
});
let profiler;
const report = { warning:'Operation counts and instrumented local wall time only. Neither these times nor sampled profiles are billed production CPU.',
  manifest:evidenceManifest(resolve(out,'worker.js'),{MODE:'webhook',AUTH_MODE:'password',EXECUTION_MODE:'inline',WEBHOOK_RECONCILE_SECONDS:'900',GRAPH_VERSION:'v23.0',physical_statement_ceiling:40}),
  source_files: Object.fromEntries(['src/index.ts','src/runtime.ts','src/engine/engine.ts','src/poller/messagePoll.ts','wrangler.toml'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')])),
  invocations: [], hash_wall_samples: {}, query_plans: {} };
try {
  const db = await mf.getD1Database('DB'); await applyLocalMigrations(db);
  const config = {campaign_id:'fixture',media_id:'post',keywords:['LINK'],reward:{type:'text',value:'Resource'},copy:{opening:'Tap',delivery:'Resource'}};
  const token = 'a'.repeat(64), tokenHash = createHash('sha256').update(token).digest('hex');
  const passwordHash = 'pbkdf2$100000$'+'11'.repeat(16)+'$'+pbkdf2Sync('fixture-password',Buffer.alloc(16,17),100000,32,'sha256').toString('hex');
  async function reset(count=1,extra={}) {
    for (const table of ['inbound_events','outbound_jobs','send_attempts','conversations','events','polling_checkpoints','kv','campaign_trigger_activation','campaign_folders','campaigns','owner_oauth_states','owner_sessions','login_throttles','owner_accounts','auth']) await db.prepare('DELETE FROM '+table).run();
    await db.prepare("INSERT INTO auth(id,access_token,ig_user_id,expires_at) VALUES(1,'fixture-only','owner',9999999999)").run();
    await db.prepare('UPDATE automation_control SET enabled=1,hold_reason=NULL,cutover_at=0,account_interval_ms=0,recipient_interval_ms=0,account_limit=100000,recipient_limit=100000').run();
    for(let i=0;i<count;i++)await db.prepare('INSERT INTO campaigns(campaign_id,media_id,config_json,active,updated_at,instance_id,active_since) VALUES(?,?,?,1,0,?,0)')
      .bind('fixture'+i,i===0?'post':'post'+i,JSON.stringify({...config,...extra,campaign_id:'fixture'+i,media_id:i===0?'post':'post'+i}),'instance'+i).run();
    await db.prepare("INSERT INTO owner_accounts(id,email,password_hash,updated_at) VALUES(1,'fixture@example.com',?,0)").bind(passwordHash).run();
    await db.prepare('INSERT INTO owner_sessions(token_hash,owner_id,credential_version,expires_at,created_at) VALUES(?,1,1,9999999999,0)').bind(tokenHash).run();
    sends=gets=0;providerMode='empty';
  }
  async function invoke(label,path,body,valid=true) {
    const raw=body===undefined?undefined:JSON.stringify(body),before={sends,gets},start=performance.now();
    const response=await mf.dispatchFetch('https://fixture.test'+path,{method:raw===undefined?'GET':'POST',headers:{
      'content-type':'application/json',origin:'https://fixture.test',cookie:'__Host-fadeloop_session='+token,
      ...(path==='/webhook'?{'x-hub-signature-256':'sha256='+(valid?createHmac('sha256','fixture-secret').update(raw).digest('hex'):'0'.repeat(64))}:{})},...(raw===undefined?{}:{body:raw})});
    const result=await response.json();
    const state=await db.prepare("SELECT (SELECT COUNT(*) FROM inbound_events WHERE status!='done') pending_events,(SELECT COUNT(*) FROM outbound_jobs WHERE status='confirmed') confirmed,(SELECT COUNT(*) FROM outbound_jobs WHERE status='unknown') unknown,(SELECT COUNT(*) FROM outbound_jobs WHERE status='sending') sending").first();
    const row={label,path,...result,provider_sends:sends-before.sends,provider_reads:gets-before.gets,local_wall_ms:Math.round((performance.now()-start)*100)/100,state};
    report.invocations.push(row);console.log(JSON.stringify({label,status:row.status,sql:row.metrics.statements,trips:row.metrics.round_trips,guards:row.metrics.guards,sends:row.provider_sends,reads:row.provider_reads,state}));return row;
  }
  const comment=(i,text='LINK')=>({field:'comments',value:{id:'comment-'+i,from:{id:'user-'+i},media:{id:'post'},text,timestamp:fixtureNow()}});
  const hook=changes=>({entry:[{changes}]});
  await reset();await invoke('health','/health');await invoke('invalid signature','/webhook',hook([comment(0)]),false);
  await invoke('valid empty webhook','/webhook',hook([]));await invoke('idle scheduled poll','/__cron');
  for(const n of [1,6,50,100]){await reset();await invoke('webhook '+n+' unique comments','/webhook',hook(Array.from({length:n},(_,i)=>comment(i))));}
  await reset();const repeated=comment(0);await invoke('501 identical copies','/webhook',hook(Array(501).fill(repeated)));
  await invoke('repeat completed comment','/webhook',hook([repeated]));
  await reset();await invoke('unmatched comment','/webhook',hook([comment(0,'irrelevant')]));
  await reset();providerMode='failure';await invoke('ambiguous send failure','/webhook',hook([comment(0)]));
  await reset();await invoke('opening before button','/webhook',hook([comment(0)]));
  const job=await db.prepare("SELECT id FROM outbound_jobs WHERE action='opening'").first();
  await invoke('button direct delivery','/webhook',{entry:[{messaging:[{sender:{id:'user-0'},recipient:{id:'owner'},timestamp:Date.now()+10,postback:{mid:'button-0',payload:'FL1:'+job.id}}]}]});
  await reset();providerMode='pages';await invoke('message discovery + 50 message page','/__audit/messages',{});
  await reset(5);providerMode='pages';await invoke('5 posts x 50 comments ingest only','/__audit/comments',{});
  await reset(5);providerMode='pages';await invoke('full cron with 5 active posts','/__cron');
  await reset();const events=Array.from({length:100},(_,i)=>({kind:'comment',comment_id:'direct-'+i,igsid:'user-'+i,media_id:'post',text:'LINK',timestamp:Math.floor(Date.now()/1000)}));
  await invoke('100 event ingest only','/__audit/ingest',events);
  const single=await invoke('single drain step','/__audit/drain?steps=1',{});assert.equal(single.provider_sends,1);assert.equal(single.audit.remaining_guarded,String(single.audit.remaining_raw));
  await invoke('remaining drain default cron','/__cron');
  // Insufficient finalization capacity must prevent the external attempt entirely.
  await reset();await db.prepare('UPDATE automation_control SET enabled=0').run();
  await invoke('prepare pending job with sending disabled','/webhook',hook([comment(0)]));
  await db.prepare('UPDATE automation_control SET enabled=1').run();
  await db.prepare('UPDATE outbound_jobs SET next_at=0').run();
  const exhausted=await invoke('dispatch with six queries remaining','/__audit/dispatch?budget=7',{});
  assert.equal(exhausted.status,200);assert.equal(exhausted.provider_sends,0);assert.equal(exhausted.state.sending,0);
  // Millisecond-ledger retention must remove expired records within the bounded page.
  const old=Date.now()-10*86400000;
  await db.prepare("INSERT INTO send_attempts VALUES('old-attempt','fixture',0,'old-user',1,?)").bind(old).run();
  await db.prepare("INSERT INTO inbound_events(id,generation,recipient,source,event_ms,content_json,status,created_at) VALUES('old-done',0,'old-user','fixture',0,'{}','done',?)").bind(old).run();
  await invoke('daily retention with ten-day-old ms ledgers','/__cron?daily=1');
  report.retention_probe={old_send_attempt_remaining:!!await db.prepare("SELECT 1 FROM send_attempts WHERE id='old-attempt'").first(),old_completed_event_remaining:!!await db.prepare("SELECT 1 FROM inbound_events WHERE id='old-done'").first()};
  await reset();await invoke('owner status','/api/status');await invoke('campaign list','/api/campaigns');await invoke('dashboard','/api/dashboard');await invoke('contacts','/api/contacts');await invoke('automation health','/api/automation');
  await invoke('native password login','/session/login',{email:'fixture@example.com',password:'fixture-password'});
  await invoke('daily refresh skipped + retention','/__cron?daily=1');
  for(const n of [10,100,1000]){
    await reset(0);
    await db.prepare(`INSERT INTO campaigns(campaign_id,media_id,config_json,active,updated_at,instance_id,active_since)
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
      SELECT 'campaign'||x,'post'||x,?,1,x,'instance'||x,0 FROM n`).bind(n,JSON.stringify(config)).run();
    await invoke('campaign list '+n+' rows','/api/campaigns');
  }
  await reset();
  const query="UPDATE inbound_events SET status='processing',lease_token=?,lease_until=?,touched_at=? WHERE id=(SELECT e.id FROM inbound_events e WHERE generation=? AND ((status='pending' AND next_at<=?) OR (status='processing' AND lease_until<?)) ORDER BY (SELECT MAX(x.touched_at) FROM inbound_events x WHERE x.generation=e.generation AND x.recipient=e.recipient),event_ms,id LIMIT 1) RETURNING id,content_json,lease_token";
  report.query_plans.inbox_claim=(await db.prepare('EXPLAIN QUERY PLAN '+query).bind('fixture',9999999999,0,0,0,0).all()).results;
  report.query_plans.message_due=(await db.prepare("EXPLAIN QUERY PLAN SELECT key FROM polling_checkpoints WHERE generation=? AND substr(key,1,9)='messages:' AND next_at<=? ORDER BY last_attempt_at,key LIMIT 1").bind(0,0).all()).results;
  if(process.argv.includes('--profile')){
    const inspector=await mf.getInspectorURL();inspector.protocol='http:';
    const targets=await(await fetch(new URL('/json/list',inspector))).json();
    const ws=new WebSocket((targets.find(t=>t.type==='node'||t.type==='worker')??targets[0]).webSocketDebuggerUrl);
    await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
    let sequence=0;const pending=new Map();ws.onmessage=({data})=>{const r=JSON.parse(data);if(r.id){const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(r.error):p.resolve(r.result);}};
    const command=method=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method}));});
    await command('Profiler.enable');await command('Profiler.start');profiler={command,ws};
  }
  const legacyHash=await argon2id({password:'fixture-password',salt:new Uint8Array(16).fill(17),memorySize:19456,iterations:2,parallelism:1,hashLength:32,outputType:'encoded'});
  for(const [type,hash] of [['PBKDF2-100000',passwordHash],['legacy Argon2id',legacyHash]]){
    const samples=[];
    for(let i=0;i<6;i++){
      const start=performance.now();const response=await mf.dispatchFetch('https://fixture.test/__audit/hash',{method:'POST',body:JSON.stringify({hash})});const result=await response.json();assert.equal(result.audit?.ok,true);samples.push(Math.round((performance.now()-start)*100)/100);
    }
    report.hash_wall_samples[type]=samples;
  }
  for(const row of report.invocations){
    // The isolated five-post poll deliberately exercises the inline work ceiling.
    // Preserve the failure as evidence; it is not a successful Free-tier release.
    const expected=row.label==='invalid signature'?401:row.label==='5 posts x 50 comments ingest only'?503:200;
    assert.equal(row.status,expected,JSON.stringify(row));
    assert.ok(row.metrics.statements<=40,JSON.stringify(row));
    if(expected===503){assert.equal(row.classification,'work-budget');assert.ok(row.state.pending_events>0);}
  }
  assert.deepEqual(report.retention_probe,{old_send_attempt_remaining:false,old_completed_event_remaining:false});
} finally {
  if(profiler){const {profile}=await profiler.command('Profiler.stop');profiler.ws.close();writeFileSync(resolve(out,'hashes.cpuprofile'),JSON.stringify(profile));}
  writeFileSync(resolve(out,'results.json'),JSON.stringify(report,null,2));
  await mf.dispose();
}
console.log('Saved local investigation evidence to .wrangler/cpu-investigation/results.json');
