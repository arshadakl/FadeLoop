// Reuse the operator's secure terminal prompts; this helper creates a curl-compatible jar.
import { createInterface, emitKeypressEvents } from 'node:readline';
import { writeFileSync } from 'node:fs';

const supplied = process.argv[2];
const url = new URL(supplied || 'http://localhost:8787');
if (process.argv.length > 3 || url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
  throw new Error('Usage: npm run session:login -- https://your-worker.example (localhost HTTP is allowed).');
}
if (!process.stdin.isTTY) throw new Error('Use an interactive terminal; passwords are never accepted as arguments.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = await new Promise(resolve => rl.question('Owner email: ', resolve)); rl.close();
emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write('Password: ');
const password = await new Promise((resolve, reject) => {
  let value = '';
  function finish() { process.stdin.removeListener('keypress', key); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); }
  function key(text, info = {}) {
    if (info.ctrl && info.name === 'c') { finish(); reject(new Error('Cancelled')); }
    else if (info.name === 'return' || info.name === 'enter') { finish(); resolve(value); }
    else if (info.name === 'backspace') value = [...value].slice(0, -1).join('');
    else if (text && !info.ctrl && !info.meta) value += text;
  }
  process.stdin.on('keypress', key);
});
const response = await fetch(new URL('/session/login', url), { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
if (!response.ok) { console.error((await response.json()).error); process.exitCode = 1; }
else {
  const cookie = response.headers.get('set-cookie');
  const pair = cookie.split(';')[0]; const split = pair.indexOf('=');
  const expires = Math.floor(Date.now() / 1000) + 604800;
  writeFileSync('.fadeloop-cookies', `# Netscape HTTP Cookie File\n#HttpOnly_${url.hostname}\tFALSE\t/\tTRUE\t${expires}\t${pair.slice(0, split)}\t${pair.slice(split + 1)}\n`, { mode: 0o600 });
  console.log('Signed in. Cookie jar saved to .fadeloop-cookies; delete it when finished.');
}
