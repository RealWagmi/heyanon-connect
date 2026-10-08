import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parse } from 'smol-toml';
import { ENDPOINT, changeConfig, configPath, installedKey, readConfig, saveConfig } from '../src/config.mjs';

async function fixture(t, client, text) {
  const homeDir = await mkdtemp(join(tmpdir(), 'heyanon-config-test-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const options = { homeDir, env: {} };
  const path = configPath(client, options);
  await mkdir(dirname(path), { recursive: true });
  if (text !== undefined) await writeFile(path, text);
  return { options, path };
}

for (const client of ['codex', 'claude']) {
  test(`${client}: installs, replaces the key, and removes only HeyAnon`, async (t) => {
    const original = client === 'codex'
      ? '# Personal settings\nmodel = "test-model"\napproval_policy = "on-request"\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n'
      : JSON.stringify({ theme: 'dark', projects: { '/repo': { hasTrustDialogAccepted: false } }, mcpServers: { other: { type: 'http', url: 'https://example.com/mcp' } } });
    const { options, path } = await fixture(t, client, original);
    const decoded = client === 'codex' ? parse(original) : JSON.parse(original);
    let config = await readConfig(client, options);
    await saveConfig(config, changeConfig(config, 'install', 'first-test-key'));
    assert.equal(await readFile(`${path}.heyanon-connect.bak`, 'utf8'), original);
    config = await readConfig(client, options);
    assert.equal(installedKey(config), 'first-test-key');
    assert.equal(config.entry.url, ENDPOINT);
    if (client === 'claude') assert.equal(config.entry.type, 'http');
    else assert.equal(config.data.approval_policy, 'on-request');
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(`${path}.heyanon-connect.bak`)).mode & 0o777, 0o600);
    }
    await saveConfig(config, changeConfig(config, 'install', 'second-test-key'));
    config = await readConfig(client, options);
    assert.equal(installedKey(config), 'second-test-key');
    assert.ok(!(await readFile(path, 'utf8')).includes('first-test-key'));
    await saveConfig(config, changeConfig(config, 'remove'));
    config = await readConfig(client, options);
    assert.equal(config.entry, undefined);
    assert.deepEqual(config.data, decoded);
    assert.equal(await saveConfig(config, changeConfig(config, 'remove')), false);
  });

  test(`${client}: missing config is created and invalid config is untouched`, async (t) => {
    const { options, path } = await fixture(t, client);
    const config = await readConfig(client, options);
    await saveConfig(config, changeConfig(config, 'install', 'test-key'));
    assert.equal(installedKey(await readConfig(client, options)), 'test-key');
    await writeFile(path, 'INVALID SECRET_NOT_TO_LOG = [');
    await assert.rejects(readConfig(client, options), (error) => {
      assert.match(error.message, /Cannot parse/);
      assert.ok(!error.message.includes('SECRET_NOT_TO_LOG'));
      return true;
    });
    assert.equal(await readFile(path, 'utf8'), 'INVALID SECRET_NOT_TO_LOG = [');
  });
}

test('preserves Codex tool restrictions, auth-free headers and large integers', async (t) => {
  const text = `big = 9223372036854775807\n[mcp_servers.heyanon]\nurl = "${ENDPOINT}"\nenabled = false\ndisabled_tools = ["ask"]\nbearer_token = "legacy-inline-token"\nbearer_token_env_var = "OLD_KEY"\nhttp_headers_helper = "old-helper"\n[mcp_servers.heyanon.http_headers]\nAuthorization = "Bearer old"\nX-Region = "EU"\n[mcp_servers.heyanon.env_http_headers]\nx-api-key = "OLD_KEY"\nX-Other = "OTHER_HEADER"\n`;
  const { options, path } = await fixture(t, 'codex', text);
  const config = await readConfig('codex', options);
  await saveConfig(config, changeConfig(config, 'install', 'new-key'));
  const current = await readConfig('codex', options);
  assert.equal(current.data.big, 9223372036854775807n);
  assert.equal(current.entry.enabled, false);
  assert.deepEqual(current.entry.disabled_tools, ['ask']);
  assert.equal(current.entry.http_headers['X-Region'], 'EU');
  assert.equal(current.entry.http_headers.Authorization, undefined);
  assert.equal(current.entry.bearer_token, undefined);
  assert.equal(current.entry.bearer_token_env_var, undefined);
  assert.ok(!(await readFile(path, 'utf8')).includes('legacy-inline-token'));
  assert.equal(current.entry.http_headers_helper, undefined);
  assert.deepEqual({ ...current.entry.env_http_headers }, { 'X-Other': 'OTHER_HEADER' });
});

test('malformed header or tool tables in an existing entry are refused before any change', async (t) => {
  const { options, path } = await fixture(t, 'codex', `[mcp_servers.heyanon]\nurl = "${ENDPOINT}"\ntools = ["ask_anon"]\n`);
  const config = await readConfig('codex', options);
  assert.throws(() => changeConfig(config, 'install', 'key'), /"tools" setting must be a table/);
  assert.match(await readFile(path, 'utf8'), /tools = \[/);
});

test('refuses conflicting servers, linked files and concurrent changes', async (t) => {
  const { options, path } = await fixture(t, 'claude', JSON.stringify({ mcpServers: { heyanon: { type: 'http', url: 'https://other.example/mcp' } } }));
  const conflict = await readConfig('claude', options);
  assert.throws(() => changeConfig(conflict, 'install', 'key'), /different connection/);
  assert.throws(() => changeConfig(conflict, 'remove'), /different connection/);
  await writeFile(path, '{}');
  const config = await readConfig('claude', options);
  const next = changeConfig(config, 'install', 'key');
  await writeFile(path, '{"anotherChange":true}');
  await assert.rejects(saveConfig(config, next), /changed during setup/);
  assert.equal(await readFile(path, 'utf8'), '{"anotherChange":true}');
  if (process.platform !== 'win32') {
    const target = join(options.homeDir, 'target.json');
    await writeFile(target, '{}');
    await rm(path);
    await symlink(target, path);
    await assert.rejects(readConfig('claude', options), /regular file/);
    assert.equal(await readFile(target, 'utf8'), '{}');
  }
});

test('honors Codex configuration directory and rejects unsupported Claude profiles', () => {
  assert.equal(configPath('codex', { env: { CODEX_HOME: '/tmp/custom-codex' } }), '/tmp/custom-codex/config.toml');
  assert.throws(() => configPath('claude', { env: { CLAUDE_CONFIG_DIR: '/tmp/custom-claude' } }), /Custom CLAUDE_CONFIG_DIR/);
});
