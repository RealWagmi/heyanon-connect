import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyCodex } from '../src/codex-notify.mjs';

function websocketFixture({ failMethod, silentMethod } = {}) {
  const sent = [];
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(data) {
      const msg = JSON.parse(data); sent.push(msg);
      if (msg.id && msg.method !== silentMethod) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: msg.id, ...(msg.method === failMethod ? { error: { message: 'secret not for logs' } } : { result: {} }) }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  return { Socket, sent };
}

test('Codex callback is tool output on the supplied thread, never a fabricated user input', async () => {
  const { Socket, sent } = websocketFixture();
  const result = { taskId: 'task-a', state: 'completed', taskExecutorResponse: 'receipt' };
  await notifyCodex('ws://127.0.0.1:4500', 'thread-a', result, { WebSocketImpl: Socket });
  assert.deepEqual(sent.map((m) => m.method), ['initialize', 'initialized', 'thread/resume', 'turn/start']);
  assert.deepEqual(sent.at(-1).params, { threadId: 'thread-a', input: [], toolOutput: { namespace: 'heyanon', name: 'background_task', output: JSON.stringify(result) } });
});

test('Codex callback does not retry ambiguous delivery or send to remote URLs', async () => {
  const { Socket, sent } = websocketFixture({ silentMethod: 'turn/start' });
  await assert.rejects(notifyCodex('ws://127.0.0.1:4500', 'thread-a', {}, { WebSocketImpl: Socket, timeoutMs: 20 }), /Delivery may be unknown/);
  assert.equal(sent.filter((m) => m.method === 'turn/start').length, 1);
  await assert.rejects(notifyCodex('ws://example.com:4500', 'thread-a', {}), /loopback/);
  await assert.rejects(notifyCodex('ws://127.0.0.1.evil.example:4500', 'thread-a', {}), /loopback/);
  const failed = websocketFixture({ failMethod: 'thread/resume' });
  await assert.rejects(notifyCodex('ws://127.0.0.1:4500', 'thread-a', {}, { WebSocketImpl: failed.Socket }), /rejected the callback/);
  assert.ok(!failed.sent.some((m) => m.method === 'turn/start'));
});
