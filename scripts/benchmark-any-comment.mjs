// Disposable workerd + D1 workload. No real Instagram calls, owner credentials, or remote writes.
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('.wrangler/any-comment-benchmark', { recursive: true });
const scriptPath = resolve('.wrangler/any-comment-benchmark/index.js');
await build({ stdin: { contents: `
import { Engine } from './src/engine/engine';
import { SendQueue } from './src/queue/queue';
import { getActiveCampaigns } from './src/db';
export default { async fetch(req, env) {
 const input = await req.json();
 const metrics = { rows_read: 0, rows_written: 0, queries: 0, sends: 0 };
 function record(result) { metrics.queries++; metrics.rows_read += result.meta?.rows_read || 0; metrics.rows_written += result.meta?.rows_written || 0; return result; }
 function statement(sql, params = []) {
  const base = env.DB.prepare(sql).bind(...params);
  return {
   bind: (...values) => statement(sql, values),
   all: async () => record(await base.all()),
   run: async () => record(await base.run()),
   first: async () => { const result = record(await base.all()); return result.results[0] || null; }
  };
 }
 const db = { prepare: statement, batch: async statements => { const results = []; for (const statement of statements) results.push(await statement.run()); return results; } };
 const client = { privateReplyWithButtons: async () => { metrics.sends++; return { message_id: 'fixture' }; } };
 const engine = new Engine(db, client, new SendQueue({ minIntervalMs: 0, maxRetries: 0 }));
 const campaigns = await getActiveCampaigns(db);
 for (let index = 0; index < input.count; index++) await engine.handleComment({ kind: 'comment', comment_id: input.prefix + index, igsid: input.prefix + index, media_id: 'post1', text: index % 10 === 0 ? 'LINK' : '👋', timestamp: Math.floor(Date.now()/1000) + 1 }, campaigns);
 return Response.json(metrics);
} };`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', outfile: scriptPath });
const mf = new Miniflare({ modules: true, scriptPath, compatibilityDate: '2025-07-01', d1Databases: { DB: 'disposable-benchmark' } });
try {
 const db = await mf.getD1Database('DB');
 for (const file of readdirSync('schema').filter(f => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(`schema/${file}`, 'utf8').replace(/^--.*$/gm, '');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
 }
 const report = [];
 for (const match_mode of ['keywords', 'any']) {
  await db.batch(['campaigns', 'conversations', 'processed_comments', 'send_claims', 'events', 'campaign_trigger_activation'].map(table => db.prepare(`DELETE FROM ${table}`)));
  const config = { campaign_id: 'fixture', media_id: 'post1', keywords: ['LINK'], match_mode, reward: { type: 'link', value: 'https://example.com' }, copy: { opening: 'Tap', delivery: '{reward}' } };
  await db.prepare('INSERT INTO campaigns (campaign_id, media_id, config_json, active, updated_at) VALUES (?, ?, ?, 1, ?)').bind('fixture', 'post1', JSON.stringify(config), Math.floor(Date.now()/1000)).run();
  if (match_mode === 'any') await db.prepare('INSERT INTO campaign_trigger_activation VALUES (?, ?)').bind('fixture', Math.floor(Date.now()/1000)).run();
  const invoke = async prefix => {
   const start = performance.now();
   const response = await mf.dispatchFetch('https://benchmark.test', { method: 'POST', body: JSON.stringify({ prefix, count: 100 }) });
   if (!response.ok) throw new Error('Benchmark failed');
   return { ...await response.json(), local_wall_ms: Math.round(performance.now() - start) };
  };
  const initial = await invoke('person');
  const repeated = await invoke('person');
  report.push({ match_mode, comments: 100, keyword_matches: 10, initial, repeated });
 }
 writeFileSync('.wrangler/any-comment-benchmark/results.json', JSON.stringify(report, null, 2));
 console.log(JSON.stringify(report, null, 2));
} finally { await mf.dispose(); }
