import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { run } from '../src/cli.mjs';
import { planSkill, applySkill, skillPath } from '../src/skill-install.mjs';
import { ENDPOINT, readConfig, saveConfig, changeConfig } from '../src/config.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const homeDir = await mkdtemp(join(tmpdir(), 'heyanon-skill-test-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return { homeDir, env: { HEYANON_API_KEY: 'private-install-test' }, output: { write() {} }, probe: async () => ({ toolCount: 22 }) };
}

test('installed waiter and channel run independently of the checkout, read rotated native keys and are removed together', async (t) => {
  const options = await fixture(t);
  await run(['claude'], options);
  const config = await readConfig('claude', options);
  const skill = skillPath('claude', options.homeDir);
  assert.equal(config.data.mcpServers.heyanon_events.command, process.execPath);
  assert.deepEqual(config.data.mcpServers.heyanon_events.args, [join(skill, 'scripts/channel.mjs')]);
  assert.ok(!(await readFile(join(skill, 'connection.json'), 'utf8')).includes(options.env.HEYANON_API_KEY));
  const { stdout } = await exec(process.execPath, [join(skill, 'scripts/wait.mjs'), '--help'], { cwd: options.homeDir });
  assert.match(stdout, /TASK_ID/);
  const { credentials } = await import(pathToFileURL(join(skill, 'runtime/credentials.mjs')).href);
  assert.deepEqual(await credentials(), { apiKey: options.env.HEYANON_API_KEY, endpoint: ENDPOINT });
  await saveConfig(config, changeConfig(config, 'install', 'rotated-install-test'));
  assert.deepEqual(await credentials(), { apiKey: 'rotated-install-test', endpoint: ENDPOINT });
  // Exercise the installed CLI all the way through MCP with an isolated fake
  // transport. The helper's dependency paths must resolve from its own folder.
  const mock = join(options.homeDir, 'mock-fetch.mjs');
  await writeFile(mock, `globalThis.fetch = async (_url, options) => {
    if (_url !== '${ENDPOINT}') throw new Error('Wrong endpoint');
    if (options.headers['X-API-Key'] !== 'rotated-install-test') throw new Error('Wrong key');
    const message = JSON.parse(options.body);
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} } };
    else if (message.method === 'tools/call' && message.params.name === 'background_task' && message.params.arguments.id === 'task-a') result = { content: [{ type: 'text', text: 'id: task-a\\nprompt: Show my balances\\nstatus: completed\\nresult: static receipt\\nlogs: []\\ncreatedAt: 2026-10-07T12:00:00Z\\nupdatedAt: 2026-10-07T12:01:00Z' }] };
    else throw new Error('Unexpected tool');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  };\n`);
  const done = await exec(process.execPath, ['--import', pathToFileURL(mock).href, join(skill, 'scripts/wait.mjs'), 'task-a'], { cwd: options.homeDir });
  assert.equal(JSON.parse(done.stdout).result, 'static receipt');
  assert.ok(!done.stdout.includes('rotated-install-test'));
  await run(['remove', 'claude'], options);
  await assert.rejects(readFile(join(skill, 'SKILL.md')), { code: 'ENOENT' });
  assert.equal((await readConfig('claude', options)).data.mcpServers.heyanon_events, undefined);
});

test('agent mode obtains a key through the browser adapter and supports installer updates', async (t) => {
  const options = await fixture(t);
  let called = 0;
  options.env = {};
  options.browser = async ({ submit }) => { called++; return submit('browser-test'); };
  await run(['install', 'codex', '--serve'], options);
  await run(['install', 'codex', '--serve'], options);
  assert.equal(called, 2);
  assert.equal((await readConfig('codex', options)).entry.http_headers['X-API-Key'], 'browser-test');
});

test('the skill text points at its installed location', async (t) => {
  const options = await fixture(t);
  // A home path with replacement-pattern characters must be copied literally.
  options.homeDir = await mkdtemp(join(options.homeDir, 'home-$&-'));
  await run(['codex'], options);
  const skill = skillPath('codex', options.homeDir);
  for (const name of ['SKILL.md', 'references/delivery.md']) {
    const text = await readFile(join(skill, name), 'utf8');
    assert.ok(text.includes(join(skill, 'scripts/wait.mjs')), name);
    assert.ok(!text.includes('/absolute/path/to/this/skill'), name);
  }
});

test('custom and modified skills are preserved without changing configurations', async (t) => {
  const options = await fixture(t);
  const path = join(skillPath('codex', options.homeDir), 'SKILL.md');
  await run(['codex'], options);
  const before = (await readConfig('codex', options)).text;
  await writeFile(path, '# User customization\n');
  for (const action of ['install', 'remove']) await assert.rejects(run([action, 'codex'], options), /custom or has been edited/);
  assert.equal((await readConfig('codex', options)).text, before);
  assert.equal(await readFile(path, 'utf8'), '# User customization\n');
});

test('desktop junk files inside the skill do not block updates or removal', async (t) => {
  const options = await fixture(t);
  const skill = skillPath('codex', options.homeDir);
  await run(['codex'], options);
  await writeFile(join(skill, '.DS_Store'), 'finder');
  await writeFile(join(skill, 'scripts/.DS_Store'), 'finder');
  await run(['codex'], options);
  await writeFile(join(skill, '.DS_Store'), 'finder');
  await run(['remove', 'codex'], options);
  await assert.rejects(readFile(join(skill, 'SKILL.md')), { code: 'ENOENT' });
});

test('skill replacement can roll back if config save fails', async (t) => {
  const options = await fixture(t);
  await run(['codex'], options);
  const config = await readConfig('codex', options);
  const plan = await planSkill(config, 'install', options);
  const manifest = join(plan.path, '.heyanon-connect.json');
  const before = await readFile(manifest, 'utf8');
  const applied = await applySkill(plan);
  await applied.rollback();
  assert.equal(await readFile(manifest, 'utf8'), before);
});

test('conflicting Claude channel does not change either MCP config or skill', async (t) => {
  const options = await fixture(t);
  await mkdir(options.homeDir, { recursive: true });
  const path = join(options.homeDir, '.claude.json');
  const original = JSON.stringify({ mcpServers: { heyanon_events: { command: 'custom-command' } } });
  await writeFile(path, original);
  await assert.rejects(run(['claude'], options), /different connection/);
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(readFile(join(skillPath('claude', options.homeDir), 'SKILL.md')), { code: 'ENOENT' });
});

test('the Claude channel entry survives a Node upgrade: reinstall refreshes it and removal deletes it', async (t) => {
  const options = await fixture(t);
  await run(['claude'], options);
  const path = join(options.homeDir, '.claude.json');
  const age = async () => {
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.mcpServers.heyanon_events.command = '/old/node/bin/node';
    await writeFile(path, JSON.stringify(data));
  };
  await age();
  await run(['claude'], options);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).mcpServers.heyanon_events.command, process.execPath);
  await age();
  await run(['remove', 'claude'], options);
  const data = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(data.mcpServers.heyanon_events, undefined);
  assert.equal(data.mcpServers.heyanon, undefined);
});

test('the installed waiter honors native Codex tool restrictions', async (t) => {
  const options = await fixture(t);
  await run(['codex'], options);
  const { credentials } = await import(pathToFileURL(join(skillPath('codex', options.homeDir), 'runtime/credentials.mjs')).href);
  const config = await readConfig('codex', options);
  config.entry.disabled_tools = ['background_task'];
  await saveConfig(config, changeConfig(config, 'install', options.env.HEYANON_API_KEY));
  await assert.rejects(credentials(), /disabled in this client/);
});
