// Own the local Worker in this process so Windows does not need process-tree termination.
import { spawn } from 'node:child_process';
import { mf } from './serve-ui-test.mjs';
try {
  const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, FADELOOP_UI_EXTERNAL: '1' },
  });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally { await mf.dispose(); }
