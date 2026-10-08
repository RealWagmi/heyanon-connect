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
  const foreign = await fetch(url, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'key=evil' });
  assert.equal(foreign.status, 403);
  await foreign.text();
  const json = await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(json.status, 403);
  await json.text();
  // Browsers may send "Origin: null" or no Origin for a same-origin form post; the secret path protects the form.
  for (const headers of [{ Origin: 'null' }, {}]) {
    const bad = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'key=has+a+space' });
    assert.equal(bad.status, 400);
    const text = await bad.text();
    assert.ok(!text.includes('has a space'));
    assert.match(text, /type="password"/);
  }
  const key = 'browser-private-test-key';
  const submitted = await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key }) });
  assert.equal(submitted.status, 200);
  assert.ok(!(await submitted.text()).includes(key));
  assert.equal(await pending, key);
  assert.ok(!log.includes(key));
  await assert.rejects(fetch(url));
});

test('with a submit hook the page finishes the setup and shows the outcome, retrying after a rejected key', async (t) => {
  let ready;
  const link = new Promise((resolve) => { ready = resolve; });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const keys = [];
  let urls = 0;
  const pending = browserKey({
    signal: controller.signal, output: { write() {} }, onUrl: () => { urls++; },
    submit: async (key) => { keys.push(key); if (key === 'bad-key') throw Object.assign(new Error('HeyAnon rejected this API key.'), { rejected: true }); return 'codex: saved\nSUMMARY-LINE'; },
  });
  // The URL is reported through onUrl before anything is written to output.
  const seen = await new Promise((resolve) => { const probe = browserKey({ signal: AbortSignal.abort(), output: { write() {} }, onUrl: resolve }); probe.catch(() => {}); });
  assert.match(seen, /^http:\/\/127\.0\.0\.1:\d+\/setup\/[a-f0-9]{64}$/);
  assert.equal(urls, 1);
  const log = { text: '' };
  // Recover the first page's URL from its own output stream by restarting with a capturing output.
  const second = browserKey({ signal: controller.signal, output: { write(text) { log.text += text; const m = text.match(/http:\/\/127\.0\.0\.1:\d+\/setup\/[a-f0-9]+/); if (m) ready(m[0]); } },
    submit: async (key) => { keys.push(key); if (key === 'bad-key') throw Object.assign(new Error('HeyAnon rejected this API key.'), { rejected: true }); return 'codex: saved\nSUMMARY-LINE'; } });
  const url = await link;
  const post = (key) => fetch(url, { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key }) });
  const rejected = await post('bad-key');
  assert.equal(rejected.status, 200);
  const retry = await rejected.text();
  assert.match(retry, /rejected this API key/);
  assert.match(retry, /type="password"/);
  const ok = await post('good-key');
  const outcome = await ok.text();
  assert.match(outcome, /Connected/);
  assert.match(outcome, /SUMMARY-LINE/);
  assert.equal(await second, 'codex: saved\nSUMMARY-LINE');
  assert.deepEqual(keys, ['bad-key', 'good-key']);
  assert.ok(!log.text.includes('good-key'));
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('browser setup expires and supports cancellation without input', async () => {
  await assert.rejects(browserKey({ timeoutMs: 20, output: { write() {} } }), /expired/);
  await assert.rejects(browserKey({ signal: AbortSignal.abort(), output: { write() {} } }), /cancelled/);
});
