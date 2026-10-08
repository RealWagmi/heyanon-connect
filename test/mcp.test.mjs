import assert from 'node:assert/strict';
import test from 'node:test';
import { ENDPOINT } from '../src/config.mjs';
import { checkConnection, readReply } from '../src/mcp.mjs';

const json = (id, result, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'Content-Type': 'application/json', ...headers } });

test('discovery and session cleanup use the fixed endpoint; other credential destinations are rejected', async () => {
  const seen = [];
  const result = await checkConnection('test-private-key', { endpoint: ENDPOINT, fetchImpl: async (url, options) => {
    assert.equal(url, ENDPOINT);
    seen.push(options.method);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const body = JSON.parse(options.body);
    if (body.method === 'initialize') return json(body.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} } }, { 'mcp-session-id': 'test-session' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(body.method, 'tools/list');
    return json(body.id, { tools: [{ name: 'ask_anon' }, { name: 'ask_gemma' }, { name: 'background_task' }] });
  } });
  assert.equal(result.toolCount, 3);
  assert.equal(result.keyVerified, undefined);
  assert.equal(seen.at(-1), 'DELETE');
  for (const endpoint of ['https://api.heyanon.ai/mcp', 'https://dev.api.heyanon.ai/mcp', 'https://other.example/mcp'].filter((url) => url !== ENDPOINT)) {
    await assert.rejects(checkConnection('test-private-key', { endpoint, fetchImpl: async () => { assert.fail('Must not send credentials'); } }), /Run install/);
  }
});

test('checks lifecycle and pagination without invoking any tools; releases the session', async () => {
  const seen = [];
  const result = await checkConnection('private-test-key', { fetchImpl: async (url, options) => {
    assert.equal(url, ENDPOINT);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-API-Key'], 'private-test-key');
    if (options.method === 'DELETE') { seen.push('DELETE'); return new Response(null, { status: 204 }); }
    const body = JSON.parse(options.body);
    seen.push(body.method);
    if (body.method === 'initialize') return json(body.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} } }, { 'mcp-session-id': 'test-session' });
    assert.equal(options.headers['Mcp-Session-Id'], 'test-session');
    assert.equal(options.headers['MCP-Protocol-Version'], '2025-03-26');
    if (body.method === 'notifications/initialized') {
      assert.equal(body.id, undefined);
      return new Response(null, { status: 202 });
    }
    assert.equal(body.method, 'tools/list');
    return body.params.cursor ? json(body.id, { tools: [{ name: 'second' }] }) : json(body.id, { tools: [{ name: 'first' }], nextCursor: 'next' });
  } });
  assert.deepEqual(result, { toolCount: 2, tools: ['first', 'second'] });
  assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
});

test('a present key is proven with one read-only wallet_list call; rejections never echo the body', async () => {
  const seen = [];
  const fetchImpl = (status) => async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.params?.name ? `${body.method}:${body.params.name}` : body.method);
    if (body.method === 'initialize') return json(body.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return json(body.id, { tools: [{ name: 'wallet_list' }, { name: 'ask_anon' }] });
    assert.deepEqual(body.params, { name: 'wallet_list', arguments: {} });
    return json(body.id, status === 200
      ? { content: [{ type: 'text', text: 'Your wallets:\n- main | evm: 0xabc' }] }
      : { content: [{ type: 'text', text: `GET /wallet/wallet-manager\nStatus: ${status}\n\nsecret-body-text` }], isError: true });
  };
  assert.deepEqual(await checkConnection('k', { fetchImpl: fetchImpl(200) }), { toolCount: 2, tools: ['wallet_list', 'ask_anon'], keyVerified: true });
  assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call:wallet_list']);
  await assert.rejects(checkConnection('k', { fetchImpl: fetchImpl(401) }), (error) => {
    assert.match(error.message, /rejected this API key/);
    assert.ok(!error.message.includes('secret-body-text'));
    return true;
  });
  assert.equal((await checkConnection('k', { fetchImpl: fetchImpl(503) })).keyVerified, false);
  // A status mentioned inside a backend body is not the status line.
  assert.equal((await checkConnection('k', { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'tools/call') return json(body.id, { content: [{ type: 'text', text: 'GET /wallet/wallet-manager\nStatus: 502\n\n{"message":"upstream said Status: 401"}' }], isError: true });
    return fetchImpl(200)(_url, options);
  } })).keyVerified, false);
  // Transport failures during the probe do not blame the key and do not abort the install.
  assert.equal((await checkConnection('k', { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'tools/call') return new Response('down', { status: 503 });
    return fetchImpl(200)(_url, options);
  } })).keyVerified, false);
  seen.length = 0;
  assert.equal((await checkConnection(undefined, { fetchImpl: fetchImpl(401) })).keyVerified, undefined);
  assert.ok(!seen.includes('tools/call:wallet_list'));
});

test('SSE parses split chunks, ignores notifications and closes an open stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      const data = ': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notification"}\r\n\r\ndata: {"jsonrpc":"2.0","id":7,\r\ndata: "result":{"tools":[{"name":"ping"}]}}\r\n\r\n';
      for (let start = 0; start < data.length; start += 3) controller.enqueue(new TextEncoder().encode(data.slice(start, start + 3)));
      // Deliberately do not close: readReply must cancel after the matching id.
    },
    cancel() { cancelled = true; },
  });
  const result = await readReply(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), 7);
  assert.deepEqual(result, { tools: [{ name: 'ping' }] });
  assert.equal(cancelled, true);
});

test('errors do not expose response bodies or credentials', async () => {
  const secret = 'private-test-key';
  for (const fetchImpl of [
    async () => new Response(secret, { status: 401 }),
    async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: secret } })),
    async () => new Response(secret),
    async () => { throw new Error(secret); },
  ]) {
    await assert.rejects(checkConnection(secret, { fetchImpl }), (error) => {
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

test('reports a timeout without leaking transport errors; cancellation is not retryable but a network failure is', async () => {
  await assert.rejects(checkConnection('test', { signal: AbortSignal.abort(), fetchImpl: async () => { throw new Error('aborted'); } }), (error) => {
    assert.match(error.message, /timed out/);
    assert.equal(error.retryable, false);
    return true;
  });
  await assert.rejects(checkConnection('test', { fetchImpl: async () => { throw new Error('ECONNRESET'); } }), (error) => {
    assert.match(error.message, /Cannot reach/);
    assert.equal(error.retryable, true);
    return true;
  });
});

test('a stalled reply body is abandoned when the caller cancels, even if fetch ignores the signal', async () => {
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'initialize') return json(body.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    // Never produces data and never closes; the request signal is deliberately ignored.
    return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  try {
    await assert.rejects(checkConnection('k', { fetchImpl, signal: controller.signal }), /timed out or was cancelled/);
  } finally { clearTimeout(timer); }
  assert.ok(Date.now() - started < 5000);
});

test('rejects response id mismatches and endless pagination', async () => {
  await assert.rejects(readReply(json(999, {}), 1), /Unexpected MCP response/);
  await assert.rejects(checkConnection('test', { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'initialize') return json(body.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return json(body.id, { tools: [], nextCursor: 'same' });
  } }), /invalid pagination/);
});
