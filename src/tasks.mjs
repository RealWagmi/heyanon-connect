import { setTimeout as sleep } from 'node:timers/promises';
import { connectMcp, replyText } from './mcp.mjs';
import { ENDPOINT, validateEndpoint, validateKey } from './config.mjs';

export function taskId(value) {
  if (typeof value !== 'string' || ['undefined', 'null'].includes(value) || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error('Supply the exact task ID returned by HeyAnon.');
  return value;
}

const states = new Map([
  ...['pending', 'queued', 'created', 'running', 'processing', 'in_progress'].map((s) => [s, 'pending']),
  ['awaiting_confirmation', 'needs_confirmation'],
  ...['completed', 'done', 'success', 'succeeded'].map((s) => [s, 'completed']),
  ...['failed', 'error'].map((s) => [s, 'failed']),
  ...['cancelled', 'canceled'].map((s) => [s, 'cancelled']),
]);

// The HeyAnon server renders background_task as named text fields in a fixed
// order (see heyanon-mcp src/tools/background-task.ts). Parse only that exact
// layout, never words like "done" inside the executor's free text, and fail
// closed on anything else so a changed server format cannot pass as a result.
function textTask(text) {
  const normalized = text.trim().replaceAll('\r\n', '\n');
  if (!/^id: [a-zA-Z0-9_-]+\nprompt: /u.test(normalized)) return null;
  const trailer = /\ncreatedAt: ([^\n]+)\nupdatedAt: ([^\n]+)$/u.exec(normalized);
  const logsAt = normalized.lastIndexOf('\nlogs: ');
  if (!trailer || logsAt < 0 || logsAt >= trailer.index) throw new Error('Unrecognized background_task fields. Read the task in the client; do not resubmit it.');
  let logs;
  try { logs = JSON.parse(normalized.slice(logsAt + '\nlogs: '.length, trailer.index)); } catch { /* Report malformed data below. */ }
  if (!Array.isArray(logs)) throw new Error('Unrecognized background_task logs.');
  const body = normalized.slice(0, logsAt);
  const markers = [...body.matchAll(/^status: ([^\n]+)\nresult: ?/gm)];
  if (markers.length !== 1) throw new Error('Ambiguous background_task status. Read the task in the client; do not resubmit it.');
  const marker = markers[0];
  const header = /^id: ([a-zA-Z0-9_-]+)\nprompt: ([\s\S]*)\n$/u.exec(body.slice(0, marker.index));
  if (!header) throw new Error('Unrecognized background_task header.');
  const result = body.slice(marker.index + marker[0].length);
  return { id: header[1], prompt: header[2], status: marker[1], result: result === '—' ? null : result, logs, createdAt: trailer[1], updatedAt: trailer[2] };
}

export function parseTask(reply, id) {
  taskId(id);
  if (reply?.isError) {
    // The server wraps backend failures into tool errors. Upstream 429/5xx and
    // transport errors may pass; a rejected key or unknown ID will not.
    const temporary = /Get task failed \((429|5\d\d)\)|^Request error:/m.test(replyText(reply));
    const error = new Error(temporary ? 'HeyAnon could not read the task right now: the server reported a temporary error.' : 'HeyAnon could not read the task. Check the ID, API key and account.');
    error.retryable = temporary;
    throw error;
  }
  const payloads = [reply?.structuredContent];
  for (const item of reply?.content ?? []) {
    if (item.type !== 'text' || typeof item.text !== 'string') continue;
    try { payloads.push(JSON.parse(item.text.replace(/^```(?:json)?\s*\n([\s\S]*)\n```\s*$/, '$1'))); }
    catch { payloads.push(textTask(item.text)); }
  }
  for (const payload of payloads) {
    // Accept explicit JSON task objects and ordinary API envelopes. Prefer the
    // nested task over an envelope's status: "success" only describes HTTP/API.
    const candidates = [payload?.data?.task, payload?.data, payload?.task, payload?.result, payload];
    for (const value of candidates) {
      if (!value || Array.isArray(value) || typeof value.status !== 'string') continue;
      const returnedId = value.id ?? value.taskId ?? value._id;
      if (returnedId !== undefined && returnedId !== id) throw new Error('HeyAnon returned a different task ID.');
      if (returnedId === undefined && !Object.hasOwn(value, 'taskExecutorResponse')) continue;
      const state = states.get(value.status.toLowerCase());
      if (!state) throw new Error('Unrecognized HeyAnon task status. Read background_task once and report the status; do not resubmit the operation.');
      return {
        taskId: id, state, status: value.status,
        result: value.result ?? value.taskExecutorResponse ?? null,
        ...(Object.hasOwn(value, 'taskExecutorResponse') ? { taskExecutorResponse: value.taskExecutorResponse } : {}),
        task: value,
      };
    }
  }
  throw new Error('Unrecognized background_task response. Read it once in the client; do not resubmit the operation.');
}

export async function waitForTask(id, apiKey, {
  timeoutMs = 3_600_000, intervalMs = 5_000, signal,
  connect = connectMcp, pause = sleep, endpoint = ENDPOINT,
} = {}) {
  taskId(id);
  apiKey = validateKey(apiKey);
  validateEndpoint(endpoint);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error('Task timeout must be between 1 ms and 24 hours.');
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
  let client;
  try {
    let failures = 0;
    while (true) {
      combined.throwIfAborted();
      let result;
      try {
        // Connecting is retried like a read. This is the only account tool the waiter
        // can call: never repeat ask, confirm a task or cancel an operation while waiting.
        client ??= await connect(apiKey, { signal: combined, endpoint });
        result = parseTask(await client.send('tools/call', { name: 'background_task', arguments: { id } }), id);
        failures = 0;
      } catch (error) {
        if (!error.retryable || ++failures > 3) throw error;
        await pause(Math.min(timeoutMs, Math.max(intervalMs * failures, error.retryAfterMs ?? 0)), undefined, { signal: combined });
        continue;
      }
      if (result.state !== 'pending') return JSON.parse(JSON.stringify(result).replaceAll(apiKey, '[REDACTED]'));
      await pause(intervalMs, undefined, { signal: combined });
    }
  } catch (error) {
    if (combined.aborted) return { taskId: id, state: signal?.aborted ? 'watch_cancelled' : 'timed_out', operationStatus: 'unknown' };
    throw error;
  } finally {
    await client?.close();
  }
}
