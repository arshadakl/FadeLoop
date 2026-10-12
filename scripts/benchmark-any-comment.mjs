// Bounded real-engine benchmark in disposable workerd/D1; no provider calls.
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {applyLocalMigrations} from './local-migrations.mjs';
mkdirSync('.wrangler/any-comment-benchmark',{recursive:true});
const scriptPath=resolve('.wrangler/any-comment-benchmark/index.js');
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {Engine} from './src/engine/engine';
import {SendQueue} from './src/queue/queue';
import {budgetDatabase,remainingQueries} from './src/reliability/budget';
import {guardedConnectionDb} from './src/connection';
export default {async fetch(req,env){
 const input=await req.json(),raw=budgetDatabase(env.DB),db=guardedConnectionDb(raw,0);let sends=0;
 const client={privateReplyWithButtons:async()=>{sends++;return {message_id:'fixture'};}};
 const engine=new Engine(db,client,new SendQueue(),{igUserId:'owner',remainingQueries:()=>remainingQueries(raw)});
 if(input.events)await engine.ingest(input.events,'benchmark');await engine.drain();
 return Response.json({queries:40-remainingQueries(raw),sends});
}};`},bundle:true,format:'esm',platform:'browser',outfile:scriptPath});
const mf=new Miniflare({modules:true,scriptPath,compatibilityDate:'2025-07-01',d1Databases:{DB:'disposable-benchmark'}});
try{
 const db=await mf.getD1Database('DB');await applyLocalMigrations(db);
 await db.prepare("INSERT INTO auth(id,access_token,ig_user_id,expires_at) VALUES(1,'fixture','owner',9999999999)").run();
 await db.prepare('UPDATE automation_control SET enabled=1,account_interval_ms=0,recipient_interval_ms=0').run();
 const report=[];
 for(const match_mode of ['keywords','any']){
  await db.batch(['campaigns','conversations','events','campaign_trigger_activation','inbound_events','outbound_jobs','send_attempts','polling_checkpoints'].map(table=>db.prepare('DELETE FROM '+table)));
  const config={campaign_id:'fixture',media_id:'post',keywords:['LINK'],match_mode,reward:{type:'text',value:'r'},copy:{opening:'Tap',delivery:'r'}};
  await db.prepare("INSERT INTO campaigns(campaign_id,media_id,config_json,active,updated_at,instance_id) VALUES('fixture','post',?,1,0,?)").bind(JSON.stringify(config),match_mode).run();
  if(match_mode==='any')await db.prepare("INSERT INTO campaign_trigger_activation VALUES('fixture',0)").run();
  const events=Array.from({length:100},(_,i)=>({kind:'comment',comment_id:'c'+i,igsid:'u'+i,media_id:'post',text:i%10===0?'LINK':'hello',timestamp:Math.floor(Date.now()/1000)+1}));
  const invocations=[];
  async function invoke(body={}){const start=performance.now(),response=await mf.dispatchFetch('https://benchmark.test',{method:'POST',body:JSON.stringify(body)});assert.equal(response.status,200);const metrics=await response.json();assert.ok(metrics.queries<=40);invocations.push({...metrics,wall_ms:Math.round(performance.now()-start)});return metrics;}
  await invoke({events});
  for(let i=0;i<100 && (await db.prepare("SELECT COUNT(*) n FROM inbound_events WHERE status!='done'").first()).n;i++)await invoke();
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM inbound_events WHERE status!='done'").first()).n,0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM outbound_jobs WHERE status='confirmed'").first()).n,match_mode==='any'?100:10);
  const repeat=await invoke({events});assert.equal(repeat.sends,0);
  report.push({match_mode,comments:100,confirmed:match_mode==='any'?100:10,invocations,repeat,limits:'SQL and wall time only. Staging must measure deployed CPU and memory.'});
 }
 writeFileSync('.wrangler/any-comment-benchmark/results.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report.map(({match_mode,confirmed,invocations,repeat})=>({match_mode,confirmed,invocations:invocations.length,max_queries:Math.max(...invocations.map(i=>i.queries)),repeat_sends:repeat.sends})),null,2));
}finally{await mf.dispose();}
