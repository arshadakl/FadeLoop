// Disposable UI-test instance. Uses in-memory D1, never the owner's local or remote database.
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { argon2id } from 'hash-wasm';
export const mf = new Miniflare({
  name: 'ui-test', port: 8789, host: '127.0.0.1',
  modules: true, scriptPath: resolve('.wrangler/dry-run/index.js'),
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  compatibilityDate: '2025-07-01', compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'ui-test-database' },
  assets: { workerName: 'ui-test', directory: resolve('dist/ui'), binding: 'ASSETS', routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true } },
  bindings: { MODE: 'polling', GRAPH_VERSION: 'v23.0', POLL_INTERVAL_SECONDS: '60', REDIRECT_URI: 'http://127.0.0.1:8789/auth/callback', APP_ID: 'test', APP_SECRET: 'test' },
});
const db = await mf.getD1Database('DB');
for (const file of readdirSync('schema').filter(f => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(`schema/${file}`, 'utf8').replace(/^--.*$/gm, '');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
}
const password = 'mobile test password with spaces';
const hash = await argon2id({ password, salt: new Uint8Array(16).fill(9), memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32, outputType: 'encoded' });
await db.prepare('INSERT INTO owner_accounts (id,email,password_hash,updated_at) VALUES (1,?,?,0)').bind('owner@example.com', hash).run();
await db.prepare('INSERT INTO auth (id,access_token,ig_user_id,username,account_type,expires_at) VALUES (1,?,?,?, ?,?)').bind('test-only', 'test-account', 'creator_studio', 'BUSINESS', Math.floor(Date.now()/1000) + 86400 * 30).run();
const campaign = { campaign_id: 'sample', name: 'Creator guide — comment to get the free resource', media_id: 'media1', keywords: ['GUIDE'], exclude: [], reward: { type: 'link', value: 'https://example.com/guide' }, copy: { opening: 'Thanks for your interest. Tap below for your guide.', opening_button: 'Get my guide', delivery: 'Here is your guide: {reward}' } };
await db.prepare('INSERT INTO campaigns (campaign_id,media_id,config_json,active,updated_at) VALUES (?,?,?,?,?)').bind('sample','media1',JSON.stringify(campaign),1,Math.floor(Date.now()/1000)).run();
await db.prepare("INSERT INTO conversations (igsid,campaign_id,state,username,email,followed,created_at,updated_at) VALUES ('contact1','sample','DONE','happy_creator','creator@example.com',1,?,?)").bind(Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)).run();
await db.prepare("INSERT INTO events (campaign_id,igsid,type,created_at) VALUES ('sample','contact1','comment_matched',?),('sample','contact1','delivered',?)").bind(Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)).run();
await mf.ready;
console.log('UI test server ready on http://127.0.0.1:8789');
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await mf.dispose(); process.exit(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
