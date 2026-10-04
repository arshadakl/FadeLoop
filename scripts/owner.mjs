import { createInterface, emitKeypressEvents } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argon2id } from 'hash-wasm';
import { ownerSql } from './owner-sql.mjs';

const [action, target] = process.argv.slice(2);
if (!['create', 'reset'].includes(action) || !['--local', '--remote'].includes(target) || process.argv.length !== 4) {
  console.error('Usage: npm run owner:create -- --local|--remote (or owner:reset)'); process.exit(1);
}
if (!process.stdin.isTTY) { console.error('Use an interactive terminal; passwords must never be passed as arguments.'); process.exit(1); }

async function askEmail() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const result = await new Promise(resolve => rl.question('Owner email: ', resolve));
  rl.close(); return result.trim().toLowerCase();
}
function secret(prompt) {
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let text = '';
    const finish = () => { process.stdin.removeListener('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onKey = (value, key = {}) => {
      if (key.ctrl && key.name === 'c') { finish(); reject(new Error('Cancelled')); }
      else if (key.name === 'return' || key.name === 'enter') { finish(); resolve(text); }
      else if (key.name === 'backspace') text = [...text].slice(0, -1).join('');
      else if (value && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(value)) text += value;
    };
    process.stdin.on('keypress', onKey);
  });
}
let directory;
try {
  const email = await askEmail();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
  const preflight = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'fadeloop', target, '--command', 'SELECT email FROM owner_accounts WHERE id = 1', '--json'], { encoding: 'utf8', cwd: process.cwd() });
  if (preflight.status !== 0) throw new Error(`Cannot read the ${target.slice(2)} database. Confirm migrations and Cloudflare login.`);
  const existing = JSON.parse(preflight.stdout)[0]?.results?.[0];
  if (action === 'reset' && !existing) throw new Error(`No owner exists in the ${target.slice(2)} database. Run npm run owner:create -- ${target} first.`);
  if (action === 'reset' && existing.email !== email) throw new Error(`Email does not match the owner in the ${target.slice(2)} database. Use the existing owner email.`);
  if (action === 'create' && existing) throw new Error(`An owner already exists in the ${target.slice(2)} database. Run npm run owner:reset -- ${target} instead.`);
  console.log(`Target: ${target.slice(2)} D1 database (fadeloop).`);
  const password = await secret('Password (8–128 characters): ');
  if ([...password].length < 8 || [...password].length > 128) throw new Error('Password must contain 8–128 characters.');
  if (password !== await secret('Confirm password: ')) throw new Error('Passwords do not match.');
  const hash = await argon2id({ password, salt: randomBytes(16), memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32, outputType: 'encoded' });
  const now = Math.floor(Date.now() / 1000);
  const sql = ownerSql(action, email, hash, now);
  directory = mkdtempSync(join(tmpdir(), 'fadeloop-owner-'));
  const file = join(directory, 'owner.sql'); writeFileSync(file, sql, { mode: 0o600 });
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'fadeloop', target, '--file', file, '--json'], { encoding: 'utf8', cwd: process.cwd() });
  if (result.status !== 0) throw new Error('D1 operation failed. Confirm migrations, Cloudflare login, and the selected target.');
  // Wrangler's local CLI strips changes metadata; remote file imports return aggregate summaries.
  // Verify the resulting record with a separate read rather than relying on either output shape.
  const check = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'fadeloop', target, '--command', 'SELECT email, password_hash FROM owner_accounts WHERE id = 1', '--json'], { encoding: 'utf8', cwd: process.cwd() });
  if (check.status !== 0) throw new Error('D1 write finished, but verification failed. Check database access before retrying.');
  const owner = JSON.parse(check.stdout)[0]?.results?.[0];
  if (owner?.email !== email || owner?.password_hash !== hash) throw new Error('No owner updated. Use the existing owner email when resetting.');
  console.log(`Owner ${action === 'create' ? 'created' : 'password reset; all sessions revoked'} (${target.slice(2)}).`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
