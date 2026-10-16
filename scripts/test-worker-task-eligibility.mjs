// Real workerd + disposable D1. No remote bindings, credentials or provider calls.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {applyLocalMigrations} from './local-migrations.mjs';
import {evidenceManifest} from './evidence-manifest.mjs';

const out=resolve('.wrangler/task-eligibility-runtime');mkdirSync(out,{recursive:true});
const bundle=resolve(out,'worker.js');
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import worker from './src/index';
export default {async fetch(req,env){
 const notifications=[];const queue={send:async body=>{notifications.push(body);}};
 await worker.scheduled({cron:'* * * * *'}, {...env,WORK_QUEUE:queue,SEND_QUEUE:queue,
  WEBHOOK_RECONCILE_SECONDS:new URL(req.url).searchParams.has('enabled')?'900':'off'});
 return Response.json({notifications});
}};`},bundle:true,format:'esm',platform:'browser',outfile:bundle,loader:{'.wasm':'copy'}});
let providerCalls=0;
const mf=new Miniflare({modules:true,scriptPath:bundle,modulesRules:[{type:'CompiledWasm',include:['**/*.wasm']}],
 compatibilityDate:'2025-07-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'task-eligibility-disposable'},
 bindings:{EXECUTION_MODE:'tasks',MODE:'webhook',GRAPH_VERSION:'v23.0',APP_SECRET:'fixture-only'},
 outboundService:async()=>{providerCalls++;throw new Error('Unexpected provider request');}});
try{
 const db=await mf.getD1Database('DB');await applyLocalMigrations(db);
 await db.prepare("INSERT INTO auth(id,access_token,ig_user_id,expires_at) VALUES(1,'fixture','owner',9999999999)").run();
 await db.prepare(`INSERT INTO work_tasks(id,generation,kind,reference,updated_at_ms)
  WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100)
  SELECT 'messages:0:messages:thread'||x,0,'messages','messages:thread'||x,0 FROM n`).run();
 const tick=async(enabled=false)=>{
  const response=await mf.dispatchFetch('https://fixture.test/tick'+(enabled?'?enabled=1':''));
  assert.equal(response.status,200);return (await response.json()).notifications;
 };
 for(let i=0;i<26;i++)assert.deepEqual(await tick(),[]);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM work_tasks WHERE suspend_reason='polling-disabled'").first()).n,100);
 await db.prepare('UPDATE auth SET expires_at=0').run();
 for(let i=0;i<26;i++)assert.deepEqual(await tick(true),[]);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM work_tasks WHERE suspend_reason='credentials-expired'").first()).n,100);
 await db.prepare('UPDATE auth SET expires_at=9999999999').run();
 const resumed=await tick(true);assert.ok(resumed.length>0&&resumed.length<=2);
 assert.equal(providerCalls,0);
 const result={manifest:evidenceManifest(bundle,{EXECUTION_MODE:'tasks',MODE:'webhook',physical_statement_ceiling:40}),
  assertions:{disabled_objects:100,disabled_ticks:26,expired_ticks:26,disabled_notifications:0,expired_notifications:0,resumed_notifications:resumed.length,provider_calls:providerCalls},
  limits:'Local workerd/D1 correctness only. Queue sends are intercepted; deployed CPU, billing and 24-hour soak remain unmeasured.'};
 writeFileSync(resolve(out,'results.json'),JSON.stringify(result,null,2));
 console.log('workerd task eligibility passed: 100 objects, disabled/expired repair, zero Queue hints while ineligible, bounded resume; no provider calls.');
}finally{await mf.dispose();}
