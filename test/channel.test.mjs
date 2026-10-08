import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ENDPOINT } from '../src/config.mjs';
import { serveChannel } from '../src/channel.mjs';

test('channel watches once, emits a completion notification, and retains results for reading', async (t) => {
  const input = new PassThrough();
  const messages = [];
  let calls = 0;
  let complete;
  const server = serveChannel({ input, output: { write(text) { messages.push(JSON.parse(text)); } }, loadConnection: async () => ({ apiKey: 'test-key', endpoint: ENDPOINT }), wait: async (id, key, { endpoint }) => {
    assert.equal(endpoint, ENDPOINT);
    assert.equal(key, 'test-key'); calls++;
    return new Promise((resolve) => { complete = () => resolve({ taskId: id, state: 'completed', taskExecutorResponse: 'receipt' }); });
  } });
  t.after(() => server.close());
  const send = (id, method, params) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  send(1, 'initialize', {});
  assert.deepEqual(messages[0].result.capabilities.experimental, { 'claude/channel': {} });
  send(2, 'tools/list', {});
  assert.deepEqual(messages[1].result.tools.map((x) => x.name), ['watch_task', 'task_result', 'stop_watching']);
  send(3, 'tools/call', { name: 'watch_task', arguments: { taskId: 'a' } });
  send(4, 'tools/call', { name: 'watch_task', arguments: { taskId: 'a' } });
  await setImmediate();
  assert.equal(calls, 1);
  complete();
  await setImmediate();
  const events = messages.filter((m) => m.method === 'notifications/claude/channel');
  assert.equal(events.length, 1);
  assert.equal(events[0].params.meta.task_id, 'a');
  send(5, 'tools/call', { name: 'task_result', arguments: { taskId: 'a' } });
  assert.equal(JSON.parse(messages.at(-1).result.content[0].text).taskExecutorResponse, 'receipt');
  send(6, 'tools/call', { name: 'ask', arguments: {} });
  assert.equal(messages.at(-1).error.code, -32602);
});

test('closing the channel aborts local watches without emitting events after shutdown', async () => {
  const input = new PassThrough();
  const messages = [];
  let stopped = false;
  const server = serveChannel({ input, output: { write(text) { messages.push(JSON.parse(text)); } }, loadConnection: async () => ({ apiKey: 'test', endpoint: ENDPOINT }), wait: async (taskId, _key, { signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { stopped = true; resolve({ taskId, state: 'watch_cancelled' }); });
  }) });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'watch_task', arguments: { taskId: 'a' } } }) + '\n');
  await setImmediate();
  server.close();
  await setImmediate();
  assert.equal(stopped, true);
  assert.equal(messages.filter((m) => m.method).length, 0);
});

test('stopping then resuming a watch does not let the old callback overwrite the new result', async (t) => {
  const input = new PassThrough();
  const messages = [];
  const finish = [];
  const server = serveChannel({ input, output: { write(text) { messages.push(JSON.parse(text)); } }, loadConnection: async () => ({ apiKey: 'test', endpoint: ENDPOINT }), wait: async () => new Promise((resolve) => { finish.push(resolve); }) });
  t.after(() => server.close());
  let id = 1;
  const call = (name) => input.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: { taskId: 'a' } } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize' }) + '\n');
  call('watch_task');
  await setImmediate();
  call('stop_watching');
  call('watch_task');
  await setImmediate();
  finish[0]({ taskId: 'a', state: 'watch_cancelled' });
  finish[1]({ taskId: 'a', state: 'completed', taskExecutorResponse: 'latest' });
  await setImmediate();
  assert.equal(messages.filter((m) => m.method).length, 1);
  call('task_result');
  assert.equal(JSON.parse(messages.at(-1).result.content[0].text).taskExecutorResponse, 'latest');
});
