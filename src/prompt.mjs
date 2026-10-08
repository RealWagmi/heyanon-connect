import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

export async function chooseClient(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('Specify a client: codex, claude, hermes or openclaw.');
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question('Connect: 1) Codex  2) Claude Code  3) Hermes  4) OpenClaw [1]: ')).trim().toLowerCase();
    const client = { '': 'codex', '1': 'codex', '2': 'claude', '3': 'hermes', '4': 'openclaw', codex: 'codex', claude: 'claude', hermes: 'hermes', openclaw: 'openclaw' }[answer];
    if (!client) throw new Error('Choose codex, claude, hermes or openclaw.');
    return client;
  } finally {
    prompt.close();
  }
}

export function readSecret(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run in a terminal to enter the key, or rerun with --agent to use the local key page.');
  }
  output.write('HeyAnon API key (hidden): ');
  emitKeypressEvents(input);
  const previousRaw = input.isRaw ?? false;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let secret = '';
    const finish = (error) => {
      input.off('keypress', onKey);
      input.off('end', onEnd);
      input.setRawMode(previousRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(secret);
    };
    const onEnd = () => finish(new Error('Key input ended.'));
    const onKey = (text, key = {}) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return finish(new Error('Cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') secret = secret.slice(0, -1);
      else if (key.ctrl && key.name === 'u') secret = '';
      else if (!key.ctrl && !key.meta && text && /^[\x20-\x7e]+$/.test(text)) secret += text;
    };
    input.on('keypress', onKey);
    input.once('end', onEnd);
  });
}
