import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { browserKey } from '../src/browser-key.mjs';

test('browser setup keeps the key out of output and rejects cross-origin submissions', { timeout: 5000 }, async (t) => {
  let log = '';
  let ready;
  const link = new Promise((resolve) => { ready = resolve; });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = browserKey({ signal: controller.signal, output: { write(text) { log += text; ready(text.match(/http:\/\/127\.0\.0\.1:\d+\/setup\/[a-f0-9]+/)[0]); } } });
  const url = await link;
  const origin = new URL(url).origin;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /type="password"/);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  const wrong = await fetch(`${origin}/setup/wrong`);
  assert.equal(wrong.status, 404);
  await wrong.text();
  // Forwarded links are often opened as localhost; other hosts stay rejected.
  const withHost = (host) => new Promise((resolve, reject) => request({ host: '127.0.0.1', port: new URL(url).port, path: new URL(url).pathname, headers: { Host: host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject).end());
  assert.equal(await withHost(`localhost:${new URL(url).port}`), 200);
  assert.equal(await withHost('attacker.example'), 404);
  for (const originHeader of [undefined, 'https://attacker.example']) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(originHeader ? { Origin: originHeader } : {}) }, body: 'key=evil' });
    assert.equal(res.status, 403);
    await res.text();
  }
  const bad = await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'key=has+a+space' });
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes('has a space'));
  const key = 'browser-private-test-key';
  const submitted = await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key }) });
  assert.equal(submitted.status, 200);
  assert.ok(!(await submitted.text()).includes(key));
  assert.equal(await pending, key);
  assert.ok(!log.includes(key));
  await assert.rejects(fetch(url));
});

test('browser setup expires and supports cancellation without input', async () => {
  await assert.rejects(browserKey({ timeoutMs: 20, output: { write() {} } }), /expired/);
  await assert.rejects(browserKey({ signal: AbortSignal.abort(), output: { write() {} } }), /cancelled/);
});
