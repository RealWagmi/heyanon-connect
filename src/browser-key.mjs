import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { validateKey } from './config.mjs';

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect HeyAnon</title>
<style>body{font:18px system-ui;max-width:560px;margin:12vh auto;padding:24px}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin-top:16px}.error{color:#b00020}pre{white-space:pre-wrap;font-size:14px;background:#f4f4f4;padding:12px}</style>
${body}</html>`;
const form = (path, error) => page(`<h1>Connect HeyAnon</h1><p>Get your API key at <a href="https://heyanon.ai/" target="_blank" rel="noreferrer">heyanon.ai</a>, then paste it here. The key is saved in your agent's own MCP settings; it never goes through the chat.</p>
${error ? `<p class="error">${escape(error)}</p>` : ''}<form method="post" action="${path}"><label>API key<input name="key" type="password" autocomplete="off" required maxlength="16384" autofocus></label><button>Connect</button></form>`);

// The agent gets only a short-lived link. The key goes directly from the user's
// browser to this process, never through command arguments or chat history.
// With `submit`, the page runs the rest of the setup and shows its outcome.
export async function browserKey({ output = process.stdout, timeoutMs = 15 * 60_000, signal, submit, onUrl } = {}) {
  const nonce = randomBytes(32).toString('hex');
  const path = `/setup/${nonce}`;
  let settle;
  let done = false;
  let busy = false;
  const pending = new Promise((resolve, reject) => {
    settle = (error, value) => {
      if (done) return;
      done = true;
      if (error) reject(error); else resolve(value);
    };
  });
  // Attach a handler before listen: cancellation can arrive during startup.
  pending.catch(() => {});
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    // Loopback names only, same port: forwarded links are often opened as localhost.
    const port = server.address().port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!hosts.includes(req.headers.host) || req.url !== path || done) {
      res.writeHead(404).end('Not found'); return;
    }
    if (req.method === 'GET') { res.end(form(path)); return; }
    // The unguessable path is the real protection. Browsers may send "Origin: null"
    // or no Origin at all; only a different real origin is refused.
    const origin = req.headers.origin;
    if (req.method !== 'POST' || (origin && origin !== 'null' && origin !== `http://${req.headers.host}`) || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
      res.writeHead(403).end('Request rejected'); return;
    }
    if (busy) { res.end(page('<p>Setup is already running. Wait a moment and reload this page.</p>')); return; }
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 32_768) { res.writeHead(413).end('Request too large'); return; }
    }
    let key;
    // Do not echo user input, even on validation failures.
    try { key = validateKey(new URLSearchParams(body).get('key')); }
    catch { res.writeHead(400).end(form(path, 'Enter a valid API key: one token without spaces.')); return; }
    if (!submit) {
      res.end(page('<p>Key received. Return to your agent to see the setup result. You can close this page.</p>'));
      settle(null, key);
      return;
    }
    busy = true;
    try {
      const summary = await submit(key);
      res.end(page(`<h1>Connected</h1><p>HeyAnon is set up. Restart or reload your agent to use it. You can close this page.</p><pre>${escape(summary)}</pre>`));
      settle(null, summary);
    } catch (error) {
      if (error?.rejected) { res.end(form(path, `${error.message} Try again.`)); busy = false; return; }
      res.end(page(`<h1>Setup failed</h1><p class="error">${escape(error?.message ?? 'Setup failed.')}</p><p>Run the setup command again.</p>`));
      settle(error);
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  const abort = () => settle(new Error('Key entry cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => settle(new Error('Key entry expired. Run setup again.')), timeoutMs);
  try {
    if (signal?.aborted) abort();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    server.on('error', () => settle(new Error('Local setup page failed.')));
    const url = `http://127.0.0.1:${server.address().port}${path}`;
    onUrl?.(url);
    output.write(`Open this local page to enter your HeyAnon key:\n${url}\nWaiting for key entry (15 minutes).\n`);
    return await pending;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    server.close();
    server.closeIdleConnections();
  }
}
