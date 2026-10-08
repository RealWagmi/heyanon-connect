import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { run } from '../src/cli.mjs';
import { readSecret } from '../src/prompt.mjs';
import { CLIENTS, ENDPOINT, readConfig, saveConfig } from '../src/config.mjs';
import { skillPath } from '../src/skill-install.mjs';
import { VERSION } from '../src/version.mjs';

async function home(t) {
  const homeDir = await mkdtemp(join(tmpdir(), 'heyanon-cli-test-'));
  t.after(() => rm(homeDir, { force: true, recursive: true }));
  return homeDir;
}

test('the version constant matches package.json', async () => {
  assert.equal(VERSION, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  let printed = '';
  await run(['--version'], { output: { write(text) { printed += text; } } });
  assert.equal(printed, `${VERSION}\n`);
});

for (const client of CLIENTS) test(`${client}: install and reinstall use the fixed endpoint and update an existing URL`, async (t) => {
  const homeDir = await home(t);
  const seen = [];
  const options = { homeDir, env: { HEYANON_API_KEY: 'endpoint-test-key' }, output: { write() {} }, probe: async (_key, { endpoint }) => {
    seen.push(endpoint); return { toolCount: 19 };
  } };
  await run(['install', client], options);
  assert.equal((await readConfig(client, options)).entry.url, ENDPOINT);
  await run(['install', client], options);
  await run(['check', client], options);
  assert.deepEqual(seen, [ENDPOINT, ENDPOINT, ENDPOINT]);

  const installed = await readConfig(client, options);
  const previousEndpoint = ['https://api.heyanon.ai/mcp', 'https://dev.api.heyanon.ai/mcp'].find((url) => url !== ENDPOINT);
  await saveConfig(installed, installed.text.replace(ENDPOINT, previousEndpoint));
  await assert.rejects(run(['check', client], options), /Run install/);
  assert.equal(seen.length, 3);
  await run(['install', client], options);
  assert.equal((await readConfig(client, options)).entry.url, ENDPOINT);
  assert.deepEqual(seen, [ENDPOINT, ENDPOINT, ENDPOINT, ENDPOINT]);
  await run(['remove', client], options);
  assert.equal((await readConfig(client, options)).entry, undefined);
});

test('unsupported options and the removed "both" target are rejected before config or network access', async () => {
  const options = { probe: async () => { assert.fail('Must not contact a server'); } };
  for (const args of [
    ['install', 'codex', '--server'],
    ['install', 'codex', '--server', 'https://example.com/mcp'],
    ['check', 'codex', '--server', 'anything'],
    ['both'],
    ['install', 'both', '--agent'],
    ['check', 'codex', '--agent'],
    ['remove', 'codex', '--agent'],
  ]) await assert.rejects(run(args, options), /Usage:/);
});

test('CLI installs, checks and removes a local client without printing the key', async (t) => {
  const homeDir = await home(t);
  let printed = '';
  const output = { write(text) { printed += text; } };
  const secret = 'test-private-key';
  const env = { HEYANON_API_KEY: secret };
  let checks = 0;
  const probe = async (key) => { assert.equal(key, secret); checks++; return { toolCount: 22, keyVerified: true }; };
  const options = { homeDir, env, output, probe };
  for (const client of ['codex', 'claude']) {
    await run([client], options);
    await run(['check', client], options);
    await run(['remove', client], options);
  }
  assert.equal(checks, 4);
  assert.match(printed, /API key accepted/);
  assert.match(printed, /https:\/\/heyanon.ai\//);
  assert.ok(!printed.includes(secret));
  for (const path of [join(homeDir, '.codex/config.toml'), join(homeDir, '.claude.json')]) assert.ok(!(await readFile(path, 'utf8')).includes(secret));
});

test('discovery failure or a rejected key leaves the configuration and skill untouched', async (t) => {
  const homeDir = await home(t);
  for (const message of ['unreachable', 'HeyAnon rejected this API key']) {
    const options = { homeDir, env: { HEYANON_API_KEY: 'test' }, output: { write() {} }, probe: async () => { throw new Error(message); } };
    await assert.rejects(run(['codex'], options), new RegExp(message));
    await assert.rejects(readFile(join(homeDir, '.codex/config.toml')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(skillPath('codex', homeDir), 'SKILL.md')), { code: 'ENOENT' });
  }
});

test('without a terminal the installer hands out a detached key page and writes nothing itself', async (t) => {
  const homeDir = await home(t);
  const pages = [];
  let printed = '';
  const options = {
    homeDir, env: { HEYANON_API_KEY: '' }, input: { isTTY: false }, output: { write(text) { printed += text; } },
    probe: async () => { assert.fail('No probe before the key'); }, browser: async () => { assert.fail('No in-process page'); },
    page: async (client, out) => { pages.push(client); out.write('LINK-LINE\n'); },
  };
  await run(['install', 'codex'], options);
  assert.deepEqual(pages, ['codex']);
  assert.match(printed, /LINK-LINE/);
  await assert.rejects(readFile(join(homeDir, '.codex/config.toml')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(skillPath('codex', homeDir), 'SKILL.md')), { code: 'ENOENT' });
});

test('the serving process completes the setup from the page and returns the summary to it', async (t) => {
  const homeDir = await home(t);
  let summary;
  const options = {
    homeDir, env: { HEYANON_API_KEY: '' }, input: { isTTY: false }, output: { write() {} },
    probe: async () => ({ toolCount: 22, keyVerified: true }),
    browser: async ({ submit, onUrl }) => { assert.equal(typeof onUrl, 'function'); summary = await submit('page-test-key'); return summary; },
  };
  await run(['install', 'codex', '--serve'], options);
  assert.match(summary, /API key accepted/);
  assert.match(summary, /codex: saved/);
  assert.equal((await readConfig('codex', options)).entry.http_headers['X-API-Key'], 'page-test-key');
});

test('rejects key arguments and supports help without user interaction', async () => {
  let printed = '';
  const output = { write(text) { printed += text; } };
  await run(['--help'], { output });
  assert.match(printed, /HEYANON_API_KEY/);
  await assert.rejects(run(['codex', '--key', 'not-for-argv'], { output }), /Usage:/);
});

test('secret input is hidden, handles editing and restores terminal mode', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (enabled) => { input.isRaw = enabled; };
  let printed = '';
  const output = { isTTY: true, write(text) { printed += text; } };
  const pending = readSecret(input, output);
  for (const letter of 'private') input.emit('keypress', letter, { name: letter });
  input.emit('keypress', '\x7f', { name: 'backspace' });
  input.emit('keypress', 'X', { name: 'x' });
  input.emit('keypress', '\r', { name: 'return' });
  assert.equal(await pending, 'privatX');
  assert.equal(printed, 'HeyAnon API key (hidden): \n');
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('keypress'), 0);
});

test('Ctrl+C cancels hidden input and restores terminal mode', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (enabled) => { input.isRaw = enabled; };
  const pending = readSecret(input, { isTTY: true, write() {} });
  input.emit('keypress', '\x03', { ctrl: true, name: 'c' });
  await assert.rejects(pending, /Cancelled/);
  assert.equal(input.isRaw, false);
});
