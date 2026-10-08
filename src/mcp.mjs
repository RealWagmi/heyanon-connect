import { ENDPOINT, validateEndpoint } from './config.mjs';
import { VERSION } from './version.mjs';

function resultOf(message, id) {
  if (message?.jsonrpc !== '2.0' || message.id !== id) throw new Error('Unexpected MCP response.');
  if (message.error) throw new Error('MCP rejected the request. Check your API key and server availability.');
  if (!message.result || typeof message.result !== 'object') throw new Error('MCP returned an invalid result.');
  return message.result;
}

// Streamable HTTP may return JSON or SSE. Stop after the matching reply even if
// the server keeps the event stream open for later notifications. The body is read
// through its reader and cancelled on abort ourselves: fetch may stop honouring its
// signal once a body is already streaming.
export async function readReply(response, id, signal) {
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  const reader = response.body?.getReader();
  if (!reader) throw new Error(sse ? 'MCP returned an empty event stream.' : 'MCP returned invalid JSON.');
  const onAbort = () => { reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    if (signal?.aborted) onAbort();
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 4 * 1024 * 1024) throw new Error('MCP response is too large.');
      if (!sse) {
        if (!done) continue;
        let message;
        try { message = JSON.parse(buffer); } catch { throw new Error('MCP returned invalid JSON.'); }
        return resultOf(message, id);
      }
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let message;
        try { message = JSON.parse(data); } catch { throw new Error('MCP returned an invalid event.'); }
        if (message?.id === id) return resultOf(message, id);
      }
      if (done) throw new Error('MCP closed the event stream without a reply.');
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
  }
}

export async function connectMcp(apiKey, { fetchImpl = fetch, signal, endpoint = ENDPOINT } = {}) {
  validateEndpoint(endpoint);
  const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  let requestId = 0;
  const send = async (method, params, notification = false) => {
    const requestSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    const id = notification ? undefined : ++requestId;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', headers: { ...headers }, redirect: 'error', signal: requestSignal,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    } catch {
      const error = new Error(requestSignal.aborted ? 'MCP request timed out or was cancelled.' : 'Cannot reach the HeyAnon MCP server.');
      // Network failures and per-request timeouts may pass; a cancellation does not.
      error.retryable = !signal?.aborted;
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const error = new Error(`MCP request failed (HTTP ${response.status}). Check your API key and server availability.`);
      error.retryable = response.status === 429 || response.status >= 500;
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        error.retryAfterMs = Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) || 0;
      }
      throw error;
    }
    if (response.headers.has('mcp-session-id')) headers['Mcp-Session-Id'] = response.headers.get('mcp-session-id');
    if (notification) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    try { return await readReply(response, id, requestSignal); }
    catch (error) {
      if (!requestSignal.aborted) throw error;
      const timeout = new Error('MCP request timed out or was cancelled.');
      timeout.retryable = !signal?.aborted;
      throw timeout;
    }
  };

  const close = async () => {
    if (headers['Mcp-Session-Id']) {
      try { const response = await fetchImpl(endpoint, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(3_000) }); await response.body?.cancel(); } catch { /* Optional session cleanup. */ }
    }
  };
  try {
    const info = await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'heyanon-connect', version: VERSION } });
    if (typeof info.protocolVersion !== 'string' || !info.capabilities?.tools) throw new Error('Server does not advertise MCP tools.');
    headers['MCP-Protocol-Version'] = info.protocolVersion;
    await send('notifications/initialized', undefined, true);
    return { send, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export const replyText = (reply) => (reply?.content ?? []).map((item) => (typeof item?.text === 'string' ? item.text : '')).join('\n');

export async function checkConnection(apiKey, options = {}) {
  const { send, close } = await connectMcp(apiKey, options);
  try {
    const tools = new Set();
    const cursors = new Set();
    let cursor;
    do {
      const page = await send('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(page.tools) || page.tools.some((tool) => typeof tool?.name !== 'string')) throw new Error('MCP returned an invalid tool list.');
      for (const tool of page.tools) tools.add(tool.name);
      cursor = page.nextCursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || cursors.size >= 50)) throw new Error('MCP returned invalid pagination.');
      cursors.add(cursor);
    } while (cursor);
    if (!tools.size) throw new Error('MCP returned no tools.');
    const result = { toolCount: tools.size, tools: [...tools] };
    if (apiKey && tools.has('wallet_list')) {
      // Discovery works without a key. One read-only account call proves the key; its content is discarded.
      let reply;
      try { reply = await send('tools/call', { name: 'wallet_list', arguments: {} }); }
      catch { result.keyVerified = false; return result; }
      // The server reports the backend status on its own line; a body may mention other codes.
      if (reply.isError && /^Status: 40[13]$/m.test(replyText(reply))) throw new Error('HeyAnon rejected this API key. Get your key at https://heyanon.ai/ and run setup again.');
      result.keyVerified = !reply.isError;
    }
    return result;
  } finally {
    await close();
  }
}
