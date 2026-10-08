import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { run } from '../src/cli.mjs';
import { CONFIRM_TOOLS, ENDPOINT, changeConfig, configPath, readConfig, saveConfig, saveConfigs } from '../src/config.mjs';
import { CLAUDE_HEYANON_ALLOW, CLAUDE_HEYANON_ASK, planClaudePermissions } from '../src/permissions.mjs';
import { skillPath } from '../src/skill-install.mjs';

async function fixture(t) {
  const homeDir = await mkdtemp(join(tmpdir(), 'heyanon-permissions-test-'));
  t.after(() => rm(homeDir, { force: true, recursive: true }));
  return { homeDir, env: { HEYANON_API_KEY: 'permission-test-key' }, output: { write() {} }, probe: async () => ({ toolCount: 22 }) };
}

async function put(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
}
const settingsPath = (options) => join(options.homeDir, '.claude/settings.json');
const settings = async (options) => JSON.parse(await readFile(settingsPath(options), 'utf8'));

test('Codex: a fresh install writes no approval settings; the default mode follows server annotations', async (t) => {
  const options = await fixture(t);
  let printed = '';
  options.output = { write(text) { printed += text; } };
  await run(['codex'], options);
  const config = await readConfig('codex', options);
  assert.equal(config.entry.default_tools_approval_mode, undefined);
  assert.equal(config.entry.tools, undefined);
  assert.deepEqual(Object.keys(config.entry).sort(), ['http_headers', 'url']);
  assert.match(printed, /read-only tools run without a prompt/);
  assert.ok(CONFIRM_TOOLS.includes('ask_anon'));
});

test('Codex keeps explicit restrictions, per-tool settings and global policies', async (t) => {
  const options = await fixture(t);
  options.env.CODEX_HOME = join(options.homeDir, 'custom-codex');
  await put(configPath('codex', options), `approval_policy = "on-request"
sandbox_mode = "workspace-write"
[mcp_servers.other]
url = "https://example.com/mcp"
default_tools_approval_mode = "prompt"
[mcp_servers.heyanon]
url = "${ENDPOINT}"
default_tools_approval_mode = "prompt"
disabled_tools = ["abort"]
[mcp_servers.heyanon.tools.ask]
approval_mode = "prompt"
[mcp_servers.heyanon.tools.ask_anon]
approval_mode = "approve"
`);
  let printed = '';
  options.output = { write(text) { printed += text; } };
  await run(['codex'], options);
  const config = await readConfig('codex', options);
  assert.equal(config.entry.default_tools_approval_mode, 'prompt');
  assert.deepEqual(config.entry.disabled_tools, ['abort']);
  assert.deepEqual(JSON.parse(JSON.stringify(config.entry.tools)), { ask: { approval_mode: 'prompt' }, ask_anon: { approval_mode: 'approve' } });
  assert.match(printed, /default_tools_approval_mode = "prompt" and per-tool settings were kept/);
  assert.equal(config.data.approval_policy, 'on-request');
  assert.equal(config.data.sandbox_mode, 'workspace-write');
  assert.equal(config.data.mcp_servers.other.default_tools_approval_mode, 'prompt');
  await run(['remove', 'codex'], options);
  assert.equal((await readConfig('codex', options)).entry, undefined);
  await assert.rejects(readFile(settingsPath(options)), { code: 'ENOENT' });
});

test('Claude install adds the allow rule and confirmation prompts once; removal restores the file', async (t) => {
  const options = await fixture(t);
  const original = {
    theme: 'dark',
    permissions: { allow: ['Read', 'mcp__other__*'], ask: ['mcp__heyanon__ask'], deny: ['mcp__heyanon__abort'], defaultMode: 'default' },
  };
  await put(settingsPath(options), original);
  const before = await readFile(settingsPath(options), 'utf8');
  await run(['claude'], options);
  const added = CLAUDE_HEYANON_ASK.filter((rule) => rule !== 'mcp__heyanon__abort');
  assert.deepEqual(await settings(options), { ...original, permissions: { ...original.permissions, allow: [...original.permissions.allow, CLAUDE_HEYANON_ALLOW], ask: ['mcp__heyanon__ask', ...added] } });
  assert.equal(await readFile(`${settingsPath(options)}.heyanon-connect.bak`, 'utf8'), before);
  if (process.platform !== 'win32') assert.equal((await stat(settingsPath(options))).mode & 0o777, 0o600);
  await run(['claude'], options);
  assert.equal((await settings(options)).permissions.allow.filter((rule) => rule === CLAUDE_HEYANON_ALLOW).length, 1);
  // The user drops one of the installed prompts; a reinstall respects that and removal takes only the rest.
  const edited = await settings(options);
  edited.permissions.ask = edited.permissions.ask.filter((rule) => rule !== 'mcp__heyanon__clear');
  await put(settingsPath(options), edited);
  await run(['claude'], options);
  assert.deepEqual((await settings(options)).permissions.ask, edited.permissions.ask);
  await run(['remove', 'claude'], options);
  assert.deepEqual(await settings(options), original);
});

for (const rule of [CLAUDE_HEYANON_ALLOW, 'mcp__heyanon']) {
  test(`Claude leaves pre-existing ${rule} permission untouched on install and removal`, async (t) => {
    const options = await fixture(t);
    const original = `{"permissions": {"allow": ["${rule}"]}, "theme": "dark"}\n`;
    await put(settingsPath(options), original);
    await run(['claude'], options);
    await run(['claude'], options);
    await run(['remove', 'claude'], options);
    assert.equal(await readFile(settingsPath(options), 'utf8'), original);
  });
}

test('Claude upgrades a 0.4.1 install: ask rules are added once and the marker records them', async (t) => {
  const options = await fixture(t);
  await put(settingsPath(options), { permissions: { allow: ['Read'] } });
  await run(['claude'], options);
  const markerPath = join(skillPath('claude', options.homeDir), '.heyanon-connect.json');
  // Rebuild the 0.4.1 state: allow rule owned by the installer, no ask rules, no ask field in the marker.
  await put(settingsPath(options), { permissions: { allow: ['Read', CLAUDE_HEYANON_ALLOW] } });
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  marker.version = '0.4.1';
  delete marker.claudeAskAdded;
  await put(markerPath, marker);
  await run(['claude'], options);
  assert.deepEqual((await settings(options)).permissions, { allow: ['Read', CLAUDE_HEYANON_ALLOW], ask: CLAUDE_HEYANON_ASK });
  const upgraded = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(upgraded.claudeAllowAdded, true);
  assert.deepEqual(upgraded.claudeAskAdded, CLAUDE_HEYANON_ASK);
  await run(['remove', 'claude'], options);
  assert.deepEqual(await settings(options), { permissions: { allow: ['Read'] } });
});

test('Claude takes over the allow rule after the user removed their own and then adds the prompts', async (t) => {
  const options = await fixture(t);
  let printed = '';
  options.output = { write(text) { printed += text; } };
  await put(settingsPath(options), { permissions: { allow: [CLAUDE_HEYANON_ALLOW] } });
  await run(['claude'], options);
  assert.match(printed, /existing HeyAnon allow rule was kept/);
  assert.deepEqual(await settings(options), { permissions: { allow: [CLAUDE_HEYANON_ALLOW] } });
  await put(settingsPath(options), { permissions: { allow: ['Read'] } });
  printed = '';
  await run(['claude'], options);
  assert.match(printed, /confirmation prompts for ask_anon, abort, clear, background_task_delete, scheduled_task_delete/);
  assert.deepEqual((await settings(options)).permissions, { allow: ['Read', CLAUDE_HEYANON_ALLOW], ask: CLAUDE_HEYANON_ASK });
  await run(['remove', 'claude'], options);
  assert.deepEqual(await settings(options), { permissions: { allow: ['Read'] } });
});

test('Claude checks and removal with no owned permission do not create settings', async (t) => {
  const options = await fixture(t);
  const config = await readConfig('claude', options);
  await saveConfig(config, changeConfig(config, 'install', options.env.HEYANON_API_KEY));
  await run(['check', 'claude'], options);
  await run(['remove', 'claude'], options);
  await assert.rejects(readFile(settingsPath(options)), { code: 'ENOENT' });
});

test('invalid Claude permissions fail before key input or any change', async (t) => {
  const options = await fixture(t);
  options.env = {};
  options.browser = async () => { assert.fail('No secret should be requested'); };
  for (const original of ['INVALID PRIVATE_VALUE', '{"permissions":{"allow":"Read"}}', '{"permissions":{"ask":[null]}}']) {
    await put(settingsPath(options), original);
    await assert.rejects(run(['claude', '--agent'], options), (error) => {
      assert.match(error.message, /Cannot parse Claude permissions/);
      assert.ok(!error.message.includes('PRIVATE_VALUE'));
      return true;
    });
    assert.equal(await readFile(settingsPath(options), 'utf8'), original);
    await assert.rejects(readFile(configPath('claude', options)), { code: 'ENOENT' });
    await assert.rejects(readFile(join(skillPath('claude', options.homeDir), 'SKILL.md')), { code: 'ENOENT' });
  }
});

test('linked Claude permission files are refused without following the link', { skip: process.platform === 'win32' }, async (t) => {
  const options = await fixture(t);
  const target = join(options.homeDir, 'other.json');
  await put(target, '{}');
  await mkdir(dirname(settingsPath(options)), { recursive: true });
  await symlink(target, settingsPath(options));
  await assert.rejects(planClaudePermissions('install', options), /regular file/);
  assert.equal(await readFile(target, 'utf8'), '{}');
});

test('failed discovery preserves permission files and leaves skills uninstalled', async (t) => {
  const options = await fixture(t);
  const original = '{"permissions":{"ask":["mcp__heyanon__*"]}}';
  await put(settingsPath(options), original);
  options.probe = async () => { throw new Error('offline'); };
  await assert.rejects(run(['claude'], options), /offline/);
  assert.equal(await readFile(settingsPath(options), 'utf8'), original);
  await assert.rejects(readFile(configPath('claude', options)), { code: 'ENOENT' });
  await assert.rejects(readFile(join(skillPath('claude', options.homeDir), 'SKILL.md')), { code: 'ENOENT' });
});

for (const existing of [false, true]) {
  test(`concurrent Claude permission change rolls back ${existing ? 'existing' : 'new'} MCP config and skill`, async (t) => {
    const options = await fixture(t);
    const path = configPath('claude', options);
    const original = '{"theme":"dark"}';
    if (existing) await put(path, original);
    const concurrent = '{"permissions":{"deny":["mcp__heyanon__*"]}}';
    options.probe = async () => { await put(settingsPath(options), concurrent); return { toolCount: 22 }; };
    await assert.rejects(run(['claude'], options), /changed during setup/);
    if (existing) assert.equal(await readFile(path, 'utf8'), original);
    else await assert.rejects(readFile(path), { code: 'ENOENT' });
    assert.equal(await readFile(settingsPath(options), 'utf8'), concurrent);
    await assert.rejects(readFile(join(skillPath('claude', options.homeDir), 'SKILL.md')), { code: 'ENOENT' });
  });
}

test('a client write during key entry is picked up instead of failing the install', async (t) => {
  const options = await fixture(t);
  options.env = {};
  const path = configPath('claude', options);
  await put(path, '{"theme":"dark"}');
  options.browser = async () => { await put(path, '{"theme":"light"}'); return 'entered-after-write'; };
  await run(['claude'], options);
  const config = await readConfig('claude', options);
  assert.equal(config.data.theme, 'light');
  assert.equal(config.entry.headers['X-API-Key'], 'entered-after-write');
});

test('transaction rollback never overwrites an externally changed first config', async (t) => {
  const options = await fixture(t);
  const path = join(options.homeDir, 'first.json');
  await put(path, 'original');
  const plans = [{ config: { path, text: 'original' }, next: 'written' }, { config: { path: join(options.homeDir, 'second.json'), text: null }, next: 'new' }];
  const save = async (config, next) => {
    if (config.path === path) return saveConfig(config, next);
    await put(path, 'external edit');
    throw new Error('second write failed');
  };
  await assert.rejects(saveConfigs(plans, { save }), /could not be restored safely/);
  assert.equal(await readFile(path, 'utf8'), 'external edit');
  assert.equal(await readFile(`${path}.heyanon-connect.bak`, 'utf8'), 'original');
});
