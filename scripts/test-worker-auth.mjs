// Exercise the deploy bundle and statically imported WASM inside actual workerd, with local D1.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { argon2id } from 'hash-wasm';
import { Miniflare } from 'miniflare';

const mf = new Miniflare({
  name: 'auth-test',
  modules: true, scriptPath: resolve('.wrangler/dry-run/index.js'),
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  compatibilityDate: '2025-07-01', compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'auth-runtime-test' },
  assets: { workerName: 'auth-test', directory: resolve('dist/ui'), binding: 'ASSETS', routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true } },
  bindings: { MODE: 'polling', GRAPH_VERSION: 'v23.0', POLL_INTERVAL_SECONDS: '60', REDIRECT_URI: 'https://fadeloop.test/auth/callback', APP_ID: 'test', APP_SECRET: 'test' },
});
try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync('schema').filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(`schema/${file}`, 'utf8').replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const password = 'eight123';
  const hash = await argon2id({ password, salt: new Uint8Array(16).fill(7), memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32, outputType: 'encoded' });
  await db.prepare('INSERT INTO owner_accounts (id,email,password_hash,updated_at) VALUES (1,?,?,0)').bind('owner@example.com', hash).run();
  const durations = [];
  let cookie;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const response = await mf.dispatchFetch('https://fadeloop.test/session/login', { method: 'POST', headers: { origin: 'https://fadeloop.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password }) });
    durations.push(Math.round(performance.now() - start));
    assert.equal(response.status, 200, await response.text());
    cookie = response.headers.get('set-cookie').split(';')[0];
  }
  assert.equal((await mf.dispatchFetch('https://fadeloop.test/api/status', { headers: { cookie } })).status, 200);
  const oldCookie = cookie;
  const changed = await mf.dispatchFetch('https://fadeloop.test/session/password', { method: 'POST', headers: { cookie, origin: 'https://fadeloop.test', 'content-type': 'application/json' }, body: JSON.stringify({ new_password: 'runtime changed password' }) });
  assert.equal(changed.status, 200, await changed.text());
  cookie = changed.headers.get('set-cookie').split(';')[0];
  assert.equal((await mf.dispatchFetch('https://fadeloop.test/session', { headers: { cookie: oldCookie } })).status, 401);
  assert.equal((await mf.dispatchFetch('https://fadeloop.test/session', { headers: { cookie } })).status, 200);
  await db.prepare("INSERT INTO auth (id,access_token,ig_user_id,expires_at) VALUES (1,'fixture','fixture-account',9999999999)").run();
  const folder = await mf.dispatchFetch('https://fadeloop.test/api/folders', { method: 'POST', headers: { cookie, origin: 'https://fadeloop.test', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Runtime folder' }) });
  const folderBody = await folder.json();
  assert.equal(folder.status, 200, JSON.stringify(folderBody));
  const config = { campaign_id: 'runtime-campaign', media_id: 'fixture-post', match_mode: 'any', keywords: [], reward: { type: 'link', value: 'https://example.com' }, copy: { opening: 'Tap', delivery: '{reward}' } };
  const saved = await mf.dispatchFetch('https://fadeloop.test/api/campaigns', { method: 'POST', headers: { cookie, origin: 'https://fadeloop.test', 'content-type': 'application/json' }, body: JSON.stringify({ campaign: config, active: true, folder_id: folderBody.folder_id }) });
  assert.equal(saved.status, 200, await saved.text());
  assert.equal((await db.prepare('SELECT folder_id FROM campaign_folders WHERE campaign_id = ?').bind(config.campaign_id).first()).folder_id, folderBody.folder_id);
  assert.ok((await db.prepare('SELECT activated_at FROM campaign_trigger_activation WHERE campaign_id = ?').bind(config.campaign_id).first()).activated_at > 0);
  for (const folder_id of [null, folderBody.folder_id]) {
    const moved = await mf.dispatchFetch('https://fadeloop.test/api/folders/move', { method: 'POST', headers: { cookie, origin: 'https://fadeloop.test', 'content-type': 'application/json' }, body: JSON.stringify({ campaign_ids: [config.campaign_id], folder_id }) });
    assert.equal(moved.status, 200, await moved.text());
    const membership = await db.prepare('SELECT folder_id FROM campaign_folders WHERE campaign_id = ?').bind(config.campaign_id).first();
    assert.equal(membership?.folder_id ?? null, folder_id);
  }
  const disconnectRequest = password => mf.dispatchFetch('https://fadeloop.test/auth/disconnect', { method: 'POST', headers: { cookie, origin: 'https://fadeloop.test', 'content-type': 'application/json' }, body: JSON.stringify({ password, connection_generation: 0 }) });
  assert.equal((await disconnectRequest('incorrect123')).status, 403);
  // A real SQLite trigger failure proves workerd/D1 rolls back the generation and all deletes.
  await db.prepare("CREATE TRIGGER reset_failure BEFORE DELETE ON auth BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END").run();
  assert.equal((await disconnectRequest('runtime changed password')).status, 500);
  assert.ok(await db.prepare('SELECT id FROM auth').first());
  assert.ok(await db.prepare('SELECT campaign_id FROM campaigns').first());
  assert.equal((await db.prepare('SELECT generation FROM instagram_connection_state').first()).generation, 0);
  await db.prepare('DROP TRIGGER reset_failure').run();
  const reset = await disconnectRequest('runtime changed password');
  assert.equal(reset.status, 200, await reset.text());
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM campaigns').first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM automation_folders').first()).n, 0);
  assert.equal((await db.prepare('SELECT generation FROM instagram_connection_state').first()).generation, 1);
  assert.equal((await mf.dispatchFetch('https://fadeloop.test/session', { headers: { cookie } })).status, 200);
  assert.equal((await disconnectRequest('runtime changed password')).status, 200);
  assert.equal((await mf.dispatchFetch('https://fadeloop.test/api/folders')).status, 401);
  assert.equal((await mf.dispatchFetch('https://fadeloop.test/api/status?token=old', { headers: { authorization: 'Bearer old' } })).status, 401);
  assert.equal((await mf.dispatchFetch('https://fadeloop.test/session/logout', { method: 'POST', headers: { cookie, origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await mf.dispatchFetch('https://fadeloop.test/session/logout', { method: 'POST', headers: { cookie, origin: 'https://fadeloop.test' } })).status, 200);
  assert.equal((await mf.dispatchFetch('https://fadeloop.test/session', { headers: { cookie } })).status, 401);
  const html = await mf.dispatchFetch('https://fadeloop.test/');
  assert.match(await html.text(), /id="app"/);
  console.log(`Workers runtime: transactional disconnect/rollback/session retention, login, password rotation, folders/campaign assignment, activation metadata, protected API, legacy rejection, CSRF and logout passed. Login wall times: ${durations.join(', ')} ms. Argon2 memory: 19 MiB plus runtime overhead. Local wall time is not deployed CPU usage; see docs/authentication.md for the measured Free-plan release limitation.`);
} finally { await mf.dispose(); }
