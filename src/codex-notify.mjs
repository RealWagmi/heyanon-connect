import { VERSION } from './version.mjs';

// Optional adapter for an application that owns a Codex App Server session.
// It does not attach to an arbitrary running CLI or impersonate a user message.
export async function notifyCodex(url, threadId, result, { WebSocketImpl = WebSocket, timeoutMs = 15_000 } = {}) {
  let address;
  try { address = new URL(url); } catch { throw new Error('Invalid Codex App Server URL.'); }
  if (address.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(address.hostname) || address.username || address.password || address.search || address.hash) {
    throw new Error('Use an explicit loopback Codex App Server WebSocket URL.');
  }
  if (!threadId || typeof threadId !== 'string') throw new Error('A Codex thread ID is required.');
  const socket = new WebSocketImpl(address.href);
  let id = 0;
  const waiting = new Map();
  const fail = () => {
    for (const { reject } of waiting.values()) reject(new Error('Codex callback connection failed. Delivery may be unknown; do not retry automatically.'));
    waiting.clear();
  };
  const timer = setTimeout(() => { fail(); socket.close(); }, timeoutMs);
  socket.addEventListener('error', fail);
  socket.addEventListener('close', fail);
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const request = waiting.get(message.id);
    if (!request) return;
    waiting.delete(message.id);
    if (message.error) request.reject(new Error('Codex rejected the callback. Check App Server version and thread ID.'));
    else request.resolve(message.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    waiting.set(requestId, { resolve, reject });
    try { socket.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })); }
    catch { fail(); }
  });
  try {
    await new Promise((resolve, reject) => {
      // Include startup in the same timeout/error lifecycle.
      waiting.set('open', { resolve, reject });
      socket.addEventListener('open', () => { waiting.delete('open'); resolve(); }, { once: true });
    });
    await rpc('initialize', { clientInfo: { name: 'heyanon-connect', version: VERSION }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));
    await rpc('thread/resume', { threadId });
    await rpc('turn/start', { threadId, input: [], toolOutput: { namespace: 'heyanon', name: 'background_task', output: JSON.stringify(result) } });
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}
