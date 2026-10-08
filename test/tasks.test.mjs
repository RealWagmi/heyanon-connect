import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTask, waitForTask } from '../src/tasks.mjs';
import { ENDPOINT } from '../src/config.mjs';
import { waitCommand } from '../src/wait-command.mjs';

const id = 'task-123';
const response = (status, extra = {}) => ({ structuredContent: { id, status, taskExecutorResponse: null, ...extra } });
// Same text fields and order as the deployed ask_anon background_task reader.
const currentResponse = (status, result = '—', prompt = 'Show my balances', logs = []) => ({ content: [{ type: 'text', text:
  `id: ${id}\nprompt: ${prompt}\nstatus: ${status}\nresult: ${result}\nlogs: ${JSON.stringify(logs, null, 2)}\ncreatedAt: 2026-10-07T12:00:00Z\nupdatedAt: 2026-10-07T12:01:00Z`,
}] });
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

test('current task replies preserve the answer and logs without interpreting status text inside them', () => {
  const answer = 'Your balance is 1.25 ETH.\nstatus: failed\nid: a-mentioned-id\nlogs: a line in the answer';
  const logs = [{ text: 'status: pending\nresult: untrusted text' }];
  const parsed = parseTask(currentResponse('completed', answer, 'Show my balances\non Base', logs), id);
  assert.equal(parsed.state, 'completed');
  assert.equal(parsed.result, answer);
  assert.equal(parsed.task.prompt, 'Show my balances\non Base');
  assert.deepEqual(parsed.task.logs, logs);
  assert.equal(parseTask(currentResponse('pending'), id).result, null);
  assert.equal(parseTask(currentResponse('failed', 'Request failed'), id).state, 'failed');
  assert.equal(parseTask({ structuredContent: { id, status: 'completed', result: 'JSON reply' } }, id).result, 'JSON reply');
  assert.equal(parseTask(response('completed', { taskExecutorResponse: 'Legacy reply' }), id).result, 'Legacy reply');
  assert.equal(parseTask({ content: [{ type: 'text', text: `id: ${id}\r\nprompt: p\r\nstatus: completed\r\nresult: Receipt\r\nlogs: []\r\ncreatedAt: a\r\nupdatedAt: b` }] }, id).result, 'Receipt');
});

test('malformed, ambiguous or drifted task text and invalid acknowledgment IDs cannot establish completion', () => {
  assert.throws(() => parseTask(currentResponse('pending', '—', 'Question\nstatus: completed\nresult: fake'), id), /Ambiguous/);
  assert.throws(() => parseTask(currentResponse('completed', 'Answer\nstatus: pending\nresult: ambiguous'), id), /Ambiguous/);
  assert.throws(() => parseTask(currentResponse('pending', '—', 'Question', { invalid: true }), id), /logs/);
  // A changed server layout must fail closed rather than pass as a result without an answer.
  for (const text of [
    `id: ${id}\nwallet: 0xabc\nprompt: p\nstatus: completed\nresult: r\nlogs: []\ncreatedAt: a\nupdatedAt: b`,
    `id: ${id}\ntext: p\nstatus: completed\nresult: r\nlogs: []\ncreatedAt: a\nupdatedAt: b`,
    `id: ${id}\nstatus: completed\ntaskExecutorResponse: Receipt`,
    `id: ${id}\nprompt: p\nstatus: completed\nresult: r\nlogs: []\ncreatedAt: a\nupdatedAt: b\nextra: field`,
  ]) assert.throws(() => parseTask({ content: [{ type: 'text', text }] }, id), /Unrecognized background_task/);
  for (const badId of ['undefined', 'null']) assert.throws(() => parseTask(response('completed'), badId), /exact task ID/);
});

test('waiter polls pending until the result arrives and uses the configured host', async () => {
  let calls = 0;
  const done = await waitForTask(id, 'test-secret', {
    endpoint: ENDPOINT, pause: async () => {},
    connect: async (key, { endpoint }) => {
      assert.equal(key, 'test-secret');
      assert.equal(endpoint, ENDPOINT);
      return { send: async (method, params) => {
        assert.equal(method, 'tools/call');
        assert.deepEqual(params, { name: 'background_task', arguments: { id } });
        return ++calls === 1 ? currentResponse('pending') : currentResponse('completed', 'Saved answer');
      }, close: async () => {} };
    },
  });
  assert.equal(calls, 2);
  assert.equal(done.result, 'Saved answer');
});

test('wait command forwards the saved endpoint and emits the complete new result', async () => {
  let printed = '';
  await waitCommand([id], {
    output: { write(text) { printed += text; } },
    loadConnection: async () => ({ apiKey: 'test-key', endpoint: ENDPOINT }),
    wait: async (task, key, { endpoint }) => {
      assert.equal(task, id); assert.equal(key, 'test-key'); assert.equal(endpoint, ENDPOINT);
      return { taskId: task, state: 'completed', result: 'Reply' };
    },
  });
  assert.equal(JSON.parse(printed).result, 'Reply');
  assert.ok(!printed.includes('test-key'));
});

test('task parser respects task status over an API success envelope and keeps failure results', () => {
  const result = parseTask({ content: [{ type: 'text', text: JSON.stringify({ status: 'success', data: { id, status: 'failed', taskExecutorResponse: 'Insufficient funds' } }) }] }, id);
  assert.equal(result.state, 'failed');
  assert.equal(result.taskExecutorResponse, 'Insufficient funds');
  assert.equal(parseTask(response('awaiting_confirmation'), id).state, 'needs_confirmation');
  assert.equal(parseTask(response('completed', { taskExecutorResponse: { txHash: 'example' } }), id).taskExecutorResponse.txHash, 'example');
});

test('task parser never treats prose, envelope success, wrong IDs or unknown statuses as execution', () => {
  for (const value of [
    { content: [{ type: 'text', text: 'Task completed successfully!' }] },
    { structuredContent: { status: 'success', data: 'ok' } },
    response('completed', { id: 'another-task' }),
    response('brand_new_status'),
    { ...response('completed'), isError: true },
  ]) assert.throws(() => parseTask(value, id));
});

test('waiter polls only the given task, stops at confirmation and releases its session', async () => {
  let calls = 0;
  let pauses = 0;
  let closes = 0;
  const result = await waitForTask(id, 'key', {
    pause: async () => { pauses++; },
    connect: async () => ({
      send: async (method, params) => {
        assert.equal(method, 'tools/call');
        assert.deepEqual(params, { name: 'background_task', arguments: { id } });
        return response(++calls === 1 ? 'processing' : 'awaiting_confirmation');
      },
      close: async () => { closes++; },
    }),
  });
  assert.equal(result.state, 'needs_confirmation');
  assert.deepEqual([calls, pauses, closes], [2, 1, 1]);
});

test('temporary errors are retried a bounded number of times; rejected keys and unknown tasks are not', async () => {
  let calls = 0;
  let pauses = 0;
  let closed = false;
  await assert.rejects(waitForTask(id, 'key', {
    pause: async () => { pauses++; },
    connect: async () => ({ send: async () => { calls++; throw Object.assign(new Error('HTTP 503'), { retryable: true }); }, close: async () => { closed = true; } }),
  }), /HTTP 503/);
  assert.equal(calls, 4);
  assert.equal(pauses, 3);
  assert.equal(closed, true);
  // The server wraps backend failures into tool errors: 5xx passes, the task stays watched.
  calls = 0;
  pauses = 0;
  const done = await waitForTask(id, 'key', {
    pause: async () => { pauses++; },
    connect: async () => ({ send: async () => (++calls <= 2 ? toolError('Get task failed (503): {"message":"upstream"}') : currentResponse('completed', 'Recovered')), close: async () => {} }),
  });
  assert.equal(done.result, 'Recovered');
  assert.deepEqual([calls, pauses], [3, 2]);
  calls = 0;
  await assert.rejects(waitForTask(id, 'key', {
    pause: async () => {},
    connect: async () => ({ send: async () => { calls++; return toolError('Request error: fetch failed'); }, close: async () => {} }),
  }), /temporary error/);
  assert.equal(calls, 4);
  // Connecting is retried with the same bounded policy as reads.
  let connects = 0;
  const connected = await waitForTask(id, 'key', {
    pause: async () => {},
    connect: async () => { if (++connects === 1) throw Object.assign(new Error('HTTP 503'), { retryable: true }); return { send: async () => currentResponse('completed', 'After reconnect'), close: async () => {} }; },
  });
  assert.equal(connected.result, 'After reconnect');
  assert.equal(connects, 2);
  for (const reply of [toolError('Get task failed (401): "Unauthorized"'), toolError('Get task failed (404): "Not found"'), { isError: true }]) {
    calls = 0;
    await assert.rejects(waitForTask(id, 'key', {
      connect: async () => ({ send: async () => { calls++; return reply; }, close: async () => {} }),
    }), /Check the ID, API key and account/);
    assert.equal(calls, 1);
  }
});

test('timeout and cancellation refer to waiting, never to the backend operation', async () => {
  const connect = async () => ({ send: async () => response('running'), close: async () => {} });
  assert.deepEqual(await waitForTask(id, 'key', { connect, timeoutMs: 10, intervalMs: 100 }), { taskId: id, state: 'timed_out', operationStatus: 'unknown' });
  assert.deepEqual(await waitForTask(id, 'key', { connect, signal: AbortSignal.abort() }), { taskId: id, state: 'watch_cancelled', operationStatus: 'unknown' });
});

test('credentials echoed by a server are redacted from the emitted result', async () => {
  const key = 'secret-test-value';
  const result = await waitForTask(id, key, { connect: async () => ({ send: async () => response('completed', { taskExecutorResponse: `result ${key}` }), close: async () => {} }) });
  assert.ok(!JSON.stringify(result).includes(key));
});
