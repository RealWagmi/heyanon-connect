import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { validateKey } from './config.mjs';

// The agent gets only a short-lived link. The key goes directly from the user's
// browser to this process, never through command arguments or chat history.
export async function browserKey({ output = process.stdout, timeoutMs = 15 * 60_000, signal } = {}) {
  const nonce = randomBytes(32).toString('hex');
  const path = `/setup/${nonce}`;
  let origin;
  let settle;
  let done = false;
  const pending = new Promise((resolve, reject) => {
    settle = (error, key) => {
      if (done) return;
      done = true;
      if (error) reject(error); else resolve(key);
    };
  });
  // Attach a handler before listen: cancellation can arrive during startup.
  pending.catch(() => {});
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    // Loopback names only, same port: forwarded links are often opened as localhost.
    const port = server.address().port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!hosts.includes(req.headers.host) || req.url !== path || done) {
      res.writeHead(404).end('Not found'); return;
    }
    if (req.method === 'GET') {
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect HeyAnon</title>
<style>body{font:18px system-ui;max-width:520px;margin:12vh auto;padding:24px}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin-top:16px}</style>
<h1>Connect HeyAnon</h1><p>Get your API key at <a href="https://heyanon.ai/" target="_blank" rel="noreferrer">heyanon.ai</a>, then paste it here. The key is saved in your agent's personal MCP settings.</p>
<form method="post" action="${path}"><label>API key<input name="key" type="password" autocomplete="off" required maxlength="16384" autofocus></label><button>Continue setup</button></form></html>`);
      return;
    }
    if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}` || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
      res.writeHead(403).end('Request rejected'); return;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 32_768) { res.writeHead(413).end('Request too large'); return; }
      }
      const key = validateKey(new URLSearchParams(body).get('key'));
      // Do not echo user input, even on validation failures.
      res.end('<p>Key received. Return to your agent to see the setup result. You can close this page.</p>');
      settle(null, key);
    } catch {
      res.writeHead(400).end('Enter a valid API key and try again.');
    }
  });
  server.requestTimeout = 15_000;
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
    origin = `http://127.0.0.1:${server.address().port}`;
    output.write(`Open this local page to enter your HeyAnon key:\n${origin}${path}\nWaiting for key entry (15 minutes). Keep this process running.\n`);
    return await pending;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    server.close();
    server.closeIdleConnections();
  }
}
