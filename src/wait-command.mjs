import { credentials } from './credentials.mjs';
import { notifyCodex } from './codex-notify.mjs';
import { taskId, waitForTask } from './tasks.mjs';

export async function waitCommand(args, { output = process.stdout, loadConnection = credentials, wait = waitForTask, notify = notifyCodex } = {}) {
  const [id, ...words] = args;
  if (id === '--help') {
    output.write('node scripts/wait.mjs TASK_ID [--timeout-seconds 3600] [--codex-url ws://127.0.0.1:PORT --thread-id ID]\n');
    return;
  }
  taskId(id);
  const flags = {};
  while (words.length) {
    const name = words.shift();
    const value = words.shift();
    if (!['--timeout-seconds', '--codex-url', '--thread-id'].includes(name) || !value || flags[name]) throw new Error('Invalid wait arguments. Use --help.');
    flags[name] = value;
  }
  if (Boolean(flags['--codex-url']) !== Boolean(flags['--thread-id'])) throw new Error('Specify both --codex-url and --thread-id.');
  const timeoutMs = Number(flags['--timeout-seconds'] ?? 3600) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86_400_000) throw new Error('Timeout must be 1–86400 seconds.');
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const { apiKey, endpoint } = await loadConnection();
    const result = await wait(id, apiKey, { signal: stop.signal, timeoutMs, endpoint });
    output.write(`${JSON.stringify(result)}\n`);
    if (flags['--codex-url']) await notify(flags['--codex-url'], flags['--thread-id'], result);
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
