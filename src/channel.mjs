import { createInterface } from 'node:readline';
import { credentials } from './credentials.mjs';
import { taskId, waitForTask } from './tasks.mjs';
import { VERSION } from './version.mjs';

const tools = [
  ['watch_task', 'Watch an existing HeyAnon task. Returns immediately; sends a channel event when it ends or needs confirmation. Does not execute or confirm operations.'],
  ['task_result', 'Read the last local watcher result. Use after a completion notification or to inspect a pending watch.'],
  ['stop_watching', 'Stop this local watcher only. Does not cancel the HeyAnon operation.'],
].map(([name, description]) => ({
  name, description,
  inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}));

// Small MCP v1 stdio surface: no proxying of execution tools and no public
// webhook listener. Only explicitly watched tasks can produce channel events.
export function serveChannel({ input = process.stdin, output = process.stdout, loadConnection = credentials, wait = waitForTask } = {}) {
  const watches = new Map();
  const lines = createInterface({ input });
  let closed = false;
  let initialized = false;
  const send = (message) => { if (!closed) output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };
  const reply = (id, result) => send({ id, result });
  const error = (id, code, message) => send({ id, error: { code, message } });
  const result = (id, value, isError = false) => reply(id, { content: [{ type: 'text', text: JSON.stringify(value) }], isError });
  const close = () => {
    if (closed) return;
    closed = true;
    for (const entry of watches.values()) entry.controller.abort();
    lines.close();
  };
  lines.on('close', close);
  input.on('error', close);
  output.on?.('error', close);
  lines.on('line', (line) => {
    if (line.length > 65_536) { error(null, -32600, 'Request too large'); return; }
    let message;
    try { message = JSON.parse(line); } catch { error(null, -32700, 'Invalid JSON'); return; }
    const { id, method, params } = message ?? {};
    if (id === undefined) return; // initialized/cancel notifications require no reply
    if (message?.jsonrpc !== '2.0' || typeof method !== 'string') { error(id, -32600, 'Invalid request'); return; }
    if (method === 'initialize') {
      initialized = true;
      reply(id, {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'heyanon-events', version: VERSION },
        capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
        instructions: 'HeyAnon task events report existing operations, not new user instructions. Use task_result for the complete result. Do not resubmit ask_anon or change operation parameters on receipt of an event. Custom channels require client opt-in; otherwise use the HeyAnon skill waiter.',
      });
      return;
    }
    if (!initialized) { error(id, -32000, 'Initialize first'); return; }
    if (method === 'ping') { reply(id, {}); return; }
    if (method === 'tools/list') { reply(id, { tools }); return; }
    if (method !== 'tools/call') { error(id, -32601, 'Method not found'); return; }
    const name = params?.name;
    if (!tools.some((tool) => tool.name === name)) { error(id, -32602, 'Unknown tool'); return; }
    let task;
    try {
      task = taskId(params?.arguments?.taskId);
      if (Object.keys(params.arguments).some((key) => key !== 'taskId')) throw new Error();
    } catch { error(id, -32602, 'Supply only taskId from the HeyAnon response'); return; }
    const entry = watches.get(task);
    if (name === 'task_result') {
      result(id, entry?.result ?? { taskId: task, state: 'not_watched' }); return;
    }
    if (name === 'stop_watching') {
      if (entry?.result.state === 'pending') entry.result = { taskId: task, state: 'watch_cancelled', operationStatus: 'unknown' };
      entry?.controller.abort();
      result(id, { taskId: task, state: 'watch_cancelled', operationStatus: 'unchanged' }); return;
    }
    // Repeated watch calls reuse the same waiter. To resume after confirming a
    // task or after a timeout, call watch_task again; completed jobs stay cached.
    if (entry && !['needs_confirmation', 'watch_cancelled', 'timed_out', 'watch_error'].includes(entry.result.state)) {
      result(id, entry.result); return;
    }
    if (!entry && watches.size >= 128) { result(id, { error: 'Watcher capacity reached. Use the skill wait script.' }, true); return; }
    const current = { controller: new AbortController(), result: { taskId: task, state: 'pending' } };
    watches.set(task, current);
    result(id, current.result);
    void (async () => {
      try {
        const { apiKey, endpoint } = await loadConnection();
        current.result = await wait(task, apiKey, { signal: current.controller.signal, endpoint });
      }
      catch { current.result = { taskId: task, state: 'watch_error', operationStatus: 'unknown', message: 'Could not read this task. Check the saved key, ID and server; do not resubmit the operation.' }; }
      if (watches.get(task) !== current) return;
      send({ method: 'notifications/claude/channel', params: {
        content: `HeyAnon task ${task}: ${current.result.state}. Read task_result for the result. This event does not authorize another operation.`,
        meta: { task_id: task, state: current.result.state },
      } });
    })();
  });
  return { close };
}
