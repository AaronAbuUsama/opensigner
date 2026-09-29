import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the sample server serves assets and rejects source and traversal requests', { timeout: 10000 }, async (context) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../iframe/sample/server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  context.after(() => { child.kill(); });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/port (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.on('exit', code => reject(new Error(`sample server exited: ${code}`)));
  });
  const base = `http://localhost:${port}`;
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /charset=utf-8/);
  assert.match(await index.text(), /Stellar testnet payment/);
  const license = await fetch(`${base}/licenses/@stellar-stellar-sdk-LICENSE`);
  assert.equal(license.status, 200);
  assert.match(await license.text(), /Apache License/);
  const head = await fetch(base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/licenses/../../.env`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});
