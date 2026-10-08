import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { run } from '../src/cli.mjs';
import { changeConfig, configPath, ENDPOINT, frameworkHome, installedKey, KEY_REFERENCE, readConfig, saveConfig } from '../src/config.mjs';
import { skillPath } from '../src/skill-install.mjs';

const exec = promisify(execFile);
async function fixture(t, client) {
  const homeDir = await mkdtemp(join(tmpdir(), 'heyanon-framework-test-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const profile = join(homeDir, 'active-profile');
  const env = client === 'hermes' ? { HERMES_HOME: profile }
    : { OPENCLAW_STATE_DIR: profile, OPENCLAW_CONFIG_PATH: join(homeDir, 'config/custom.json5') };
  let printed = '';
  const keys = [];
  const options = {
    homeDir, env, output: { write(text) { printed += text; } },
    input: { isTTY: false },
    browser: async () => { throw new Error('Remote installation must not open a browser.'); },
    probe: async (key) => { keys.push(key); return { toolCount: 22 }; },
  };
  const path = configPath(client, options);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(profile, { recursive: true });
  return { options, path, profile, keys, log: () => printed };
}

for (const client of ['hermes', 'openclaw']) {
  test(`${client}: reference-only setup preserves native config, filters and secret files`, async (t) => {
    const { options, path, profile, keys, log } = await fixture(t, client);
    const original = client === 'hermes'
      ? `# Operator config\nmodel: local-model\nbanner: "no"\nterminal:\n  env_passthrough: [EXISTING_KEY]\nmcp_servers:\n  other:\n    url: https://other.example/mcp\n  heyanon:\n    url: ${ENDPOINT}\n    enabled: false\n    tools:\n      exclude: [ask]\n    headers:\n      X-Region: EU\n`
      : `// Operator config\n{ tools: { deny: ['browser'] }, mcp: { sessionIdleTtlMs: 600000, servers: {
        other: { url: 'https://other.example/mcp' },
        heyanon: { url: '${ENDPOINT}', enabled: false, toolFilter: { exclude: ['ask'] }, headers: { 'X-Region': 'EU' } },
      } } }`;
    await writeFile(path, original);
    const secretFile = join(profile, '.env');
    await writeFile(secretFile, 'HEYANON_API_KEY=secret-file-must-stay-untouched\n');
    const before = structuredClone((await readConfig(client, options)).data);
    options.env.HEYANON_API_KEY = 'secret-visible-only-to-process';
    await run(['install', client, '--agent'], options);
    assert.deepEqual(keys, [options.env.HEYANON_API_KEY]);
    assert.equal(await readFile(`${path}.heyanon-connect.bak`, 'utf8'), original);
    const saved = await readConfig(client, options);
    if (client === 'hermes') {
      const text = await readFile(path, 'utf8');
      assert.match(text, /^# Operator config\n/);
      assert.match(text, /\nbanner: "no"\n/);
      assert.equal(saved.data.banner, 'no');
    }
    assert.equal(saved.entry.headers['X-API-Key'], KEY_REFERENCE);
    assert.equal(saved.entry.headers['X-Region'], 'EU');
    assert.equal(saved.entry.enabled, false);
    if (client === 'hermes') assert.deepEqual(saved.entry.tools, { exclude: ['ask'] });
    else {
      assert.equal(saved.entry.transport, 'streamable-http');
      assert.deepEqual(saved.entry.toolFilter, { exclude: ['ask'] });
      assert.equal(saved.data.mcp.sessionIdleTtlMs, 600000);
      assert.equal(saved.data.mcpServers, undefined);
    }
    const oldOther = client === 'hermes' ? before.mcp_servers.other : before.mcp.servers.other;
    assert.deepEqual(client === 'hermes' ? saved.data.mcp_servers.other : saved.data.mcp.servers.other, oldOther);
    if (client === 'hermes') assert.deepEqual(saved.data.terminal, before.terminal);
    else assert.deepEqual(saved.data.tools, before.tools);
    const skill = skillPath(client, options.homeDir, options.env);
    const skillText = await readFile(join(skill, 'SKILL.md'), 'utf8');
    assert.match(skillText, client === 'hermes' ? /required_environment_variables:/ : /"primaryEnv":"HEYANON_API_KEY"/);
    const { credentials } = await import(pathToFileURL(join(skill, 'runtime/credentials.mjs')).href);
    await assert.rejects(credentials(undefined, { env: options.env }), /disabled/);
    assert.ok(!(await readFile(path, 'utf8')).includes(options.env.HEYANON_API_KEY));
    assert.ok(!log().includes(options.env.HEYANON_API_KEY));
    assert.ok(!log().includes('secret-file-must-stay-untouched'));
    const manifest = JSON.parse(await readFile(join(skill, 'connection.json'), 'utf8'));
    assert.deepEqual(manifest, { client, configPath: path });
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    const content = await readFile(path, 'utf8');
    await run(['install', client], options);
    assert.equal(await readFile(path, 'utf8'), content);
    await run(['remove', client], options);
    assert.equal((await readConfig(client, options)).entry, undefined);
    assert.equal(await readFile(secretFile, 'utf8'), 'HEYANON_API_KEY=secret-file-must-stay-untouched\n');
    await assert.rejects(readFile(join(skill, 'SKILL.md')), { code: 'ENOENT' });
    assert.equal(keys.length, 2, 'Removal never probes or asks for a key.');
  });

  test(`${client}: remote onboarding needs neither key nor interactive input, and check is discovery-only`, async (t) => {
    const { options, path, keys, log } = await fixture(t, client);
    await run(['install', client, '--agent'], options);
    assert.deepEqual(keys, [undefined]);
    assert.match(log(), /must resolve HEYANON_API_KEY/);
    assert.match(await readFile(path, 'utf8'), /\$\{HEYANON_API_KEY\}/);
    assert.deepEqual((await readdir(options.homeDir)).sort(), client === 'hermes' ? ['active-profile'] : ['active-profile', 'config']);
    await run(['check', client], options);
    assert.deepEqual(keys, [undefined, undefined]);
    assert.match(log(), /secret scope may differ/);
    options.env.HEYANON_API_KEY = 'rotated-framework-key';
    await run(['check', client], options);
    assert.equal(keys.at(-1), 'rotated-framework-key');
    assert.ok(!log().includes('rotated-framework-key'));
    assert.ok(!(await readFile(path, 'utf8')).includes('rotated-framework-key'));
  });

  test(`${client}: installed waiter runs outside checkout with injected secret and refuses missing secrets or filters`, async (t) => {
    const { options, path } = await fixture(t, client);
    await run(['install', client], options);
    const skill = skillPath(client, options.homeDir, options.env);
    const { credentials } = await import(pathToFileURL(join(skill, 'runtime/credentials.mjs')).href);
    await assert.rejects(credentials(undefined, { env: {} }), /not available to this process/);
    assert.deepEqual(await credentials(undefined, { env: { HEYANON_API_KEY: 'first-secret' } }), { apiKey: 'first-secret', endpoint: ENDPOINT });
    assert.deepEqual(await credentials(undefined, { env: { HEYANON_API_KEY: 'next-secret' } }), { apiKey: 'next-secret', endpoint: ENDPOINT });
    const mock = join(options.homeDir, 'mock-fetch.mjs');
    await writeFile(mock, `globalThis.fetch = async (_url, options) => {
      if (options.headers['X-API-Key'] !== 'injected-secret') throw new Error('Wrong key');
      const message = JSON.parse(options.body);
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} } };
      else if (message.method === 'tools/call' && message.params.name === 'background_task' && message.params.arguments.id === 'remote-task') result = { structuredContent: { id: 'remote-task', status: 'completed', taskExecutorResponse: 'Saved result' } };
      else throw new Error('Unexpected request');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };\n`);
    const done = await exec(process.execPath, ['--import', pathToFileURL(mock).href, join(skill, 'scripts/wait.mjs'), 'remote-task'], {
      cwd: options.homeDir, env: { ...process.env, ...options.env, HEYANON_API_KEY: 'injected-secret' },
    });
    assert.equal(JSON.parse(done.stdout).taskExecutorResponse, 'Saved result');
    assert.ok(!done.stdout.includes('injected-secret'));
    const config = await readConfig(client, options);
    if (client === 'hermes') config.entry.tools = { exclude: ['background_*'] };
    else config.entry.toolFilter = { exclude: ['background_*'] };
    await saveConfig(config, changeConfig(config, 'install'));
    await assert.rejects(credentials(undefined, { env: { HEYANON_API_KEY: 'secret' } }), /filters/);
    assert.ok(!(await readFile(path, 'utf8')).includes('injected-secret'));
  });

  test(`${client}: a failed discovery makes no config or skill changes`, async (t) => {
    const { options, path } = await fixture(t, client);
    options.probe = async () => { throw new Error('offline'); };
    await assert.rejects(run(['install', client, '--agent'], options), /offline/);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await assert.rejects(readFile(join(skillPath(client, options.homeDir, options.env), 'SKILL.md')), { code: 'ENOENT' });
  });

  test(`${client}: invalid native config does not leak contents or get overwritten`, async (t) => {
    const { options, path } = await fixture(t, client);
    const broken = client === 'hermes' ? 'model: [SECRET_NOT_TO_PRINT' : '{ token: "SECRET_NOT_TO_PRINT",';
    await writeFile(path, broken);
    await assert.rejects(run(['install', client], options), (error) => {
      assert.match(error.message, /Cannot parse/);
      assert.ok(!error.message.includes('SECRET_NOT_TO_PRINT'));
      return true;
    });
    assert.equal(await readFile(path, 'utf8'), broken);
  });
}

test('remote profile paths follow the service configuration, including separate OpenClaw config and state directories', () => {
  const homeDir = '/tmp/test-service';
  assert.equal(frameworkHome('hermes', { homeDir, env: {} }), '/tmp/test-service/.hermes');
  assert.equal(configPath('hermes', { homeDir, env: { HERMES_HOME: '~/hermes-work' } }), '/tmp/test-service/hermes-work/config.yaml');
  const env = { OPENCLAW_HOME: '~/claw-home', OPENCLAW_PROFILE: 'telegram' };
  assert.equal(configPath('openclaw', { homeDir, env }), '/tmp/test-service/claw-home/.openclaw-telegram/openclaw.json');
  env.OPENCLAW_STATE_DIR = '/tmp/test-state';
  env.OPENCLAW_CONFIG_PATH = '/tmp/test-config/openclaw.json5';
  assert.equal(configPath('openclaw', { homeDir, env }), '/tmp/test-config/openclaw.json5');
  assert.equal(skillPath('openclaw', homeDir, env), '/tmp/test-state/skills/heyanon');
  assert.throws(() => frameworkHome('openclaw', { env: { OPENCLAW_PROFILE: '../../other' } }), /profile name/);
});

test('OpenClaw include-owned settings and existing custom secret providers are preserved', async (t) => {
  const { options, path } = await fixture(t, 'openclaw');
  const includes = [{ $include: './base.json5' }, { mcp: { $include: './mcp.json5' } }, { mcp: { servers: { $include: './servers.json5' } } }, { mcp: { servers: { heyanon: { $include: './heyanon.json5' } } } }];
  for (const data of includes) {
    const original = JSON.stringify(data);
    await writeFile(path, original);
    await assert.rejects(run(['install', 'openclaw'], options), /\$include/);
    assert.equal(await readFile(path, 'utf8'), original);
  }
  for (const headers of [{ 'X-API-Key': { source: 'store', provider: 'default', id: 'existing' } }, { Authorization: 'already-configured' }]) {
    const original = JSON.stringify({ mcp: { servers: { heyanon: { url: ENDPOINT, headers } } } });
    await writeFile(path, original);
    await assert.rejects(run(['install', 'openclaw'], options), /another credential configuration/);
    assert.equal(await readFile(path, 'utf8'), original);
  }
});

test('environment references are never transmitted as literal credentials', () => {
  for (const client of ['hermes', 'openclaw']) {
    const config = { client, entry: { url: ENDPOINT, headers: { 'X-API-Key': KEY_REFERENCE } } };
    assert.throws(() => installedKey(config, { env: {} }), /not available/);
    assert.throws(() => installedKey(config, { env: { HEYANON_API_KEY: '${ANOTHER_VARIABLE}' } }), /Enter an API key/);
    assert.equal(installedKey(config, { env: { HEYANON_API_KEY: 'test-injected-value' } }), 'test-injected-value');
  }
});

test('Hermes YAML aliases do not cause changes outside the MCP registry', async (t) => {
  const { options, path } = await fixture(t, 'hermes');
  await writeFile(path, `server_defaults: &defaults\n  other:\n    url: https://other.example/mcp\nmcp_servers: *defaults\n`);
  const config = await readConfig('hermes', options);
  await saveConfig(config, changeConfig(config, 'install'));
  const saved = await readConfig('hermes', options);
  assert.equal(saved.entry.headers['X-API-Key'], KEY_REFERENCE);
  assert.deepEqual(saved.data.server_defaults, { other: { url: 'https://other.example/mcp' } });
  const tagged = 'credential: !custom SECRET_NOT_TO_PRINT\n';
  await writeFile(path, tagged);
  await assert.rejects(readConfig('hermes', options), { message: 'Cannot parse the hermes config. Fix it before running setup; the file was not changed.' });
  assert.equal(await readFile(path, 'utf8'), tagged);
});

test('Hermes merge keys, aliases, empty sections and quoted keywords are handled in place', async (t) => {
  const { options, path } = await fixture(t, 'hermes');
  // mcp_servers provided only through a top-level merge key: the merged servers must survive.
  await writeFile(path, 'base: &base\n  mcp_servers:\n    other: { url: https://other.example/mcp }\n<<: *base\nmodel: m\n');
  await run(['install', 'hermes'], options);
  let saved = await readConfig('hermes', options);
  assert.equal(saved.data.mcp_servers.other.url, 'https://other.example/mcp');
  assert.equal(saved.entry.headers['X-API-Key'], KEY_REFERENCE);
  assert.match(await readFile(path, 'utf8'), /^base: &base\n/);
  // An entry that only comes from a merge inside the map cannot be removed by the installer.
  await writeFile(path, `shared: &shared\n  heyanon: { url: '${ENDPOINT}', headers: { X-API-Key: '\${HEYANON_API_KEY}' } }\nmcp_servers:\n  <<: *shared\n`);
  await assert.rejects(run(['remove', 'hermes'], options), /merge key or alias/);
  // Four-space files keep their indentation.
  await writeFile(path, 'mcp_servers:\n    other:\n        url: https://other.example/mcp\n');
  await run(['install', 'hermes'], options);
  assert.match(await readFile(path, 'utf8'), /\n    heyanon:\n        url: /);
  // An empty section is valid YAML and is treated as an empty map.
  await writeFile(path, 'model: m\nmcp_servers:\n');
  await run(['install', 'hermes'], options);
  assert.match(await readFile(path, 'utf8'), /^model: m\nmcp_servers:\n  heyanon:\n/);
  await run(['remove', 'hermes'], options);
  assert.equal((await readConfig('hermes', options)).entry, undefined);
  // Quoted YAML 1.1 keywords inside the existing entry stay quoted; comments on the entry survive.
  await writeFile(path, `mcp_servers:\n  heyanon:\n    url: ${ENDPOINT}\n    headers:\n      X-Flag: "no"\n      X-Time: "1:30"\n    # trailing note\n  other:\n    url: https://other.example/mcp\n`);
  await run(['install', 'hermes'], options);
  const text = await readFile(path, 'utf8');
  assert.match(text, /X-Flag: "no"\n/);
  assert.match(text, /X-Time: "1:30"\n/);
  assert.match(text, /# trailing note/);
  saved = await readConfig('hermes', options);
  assert.equal(saved.entry.headers['X-Flag'], 'no');
  assert.equal(saved.data.mcp_servers.other.url, 'https://other.example/mcp');
});
