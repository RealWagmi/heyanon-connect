import { CLIENTS, CONFIRM_TOOLS, ENDPOINT, FRAMEWORKS, KEY_ENV, assertChannelEntry, assertHeyAnonEntry, changeConfig, installedKey, readConfig, saveConfigs, validateEndpoint, validateKey } from './config.mjs';
import { checkConnection } from './mcp.mjs';
import { chooseClient, readSecret } from './prompt.mjs';
import { browserKey } from './browser-key.mjs';
import { applySkill, planSkill, recordClaudePermission } from './skill-install.mjs';
import { planClaudePermissions } from './permissions.mjs';
import { VERSION } from './version.mjs';
import { join } from 'node:path';

const HELP = `HeyAnon Connect

Usage: heyanon-connect [install|check|remove] [codex|claude|hermes|openclaw] [--agent]

  install  Add the HeyAnon MCP connection, skill and task waiter (default).
  check    Check the saved connection: MCP discovery and API-key acceptance.
  remove   Remove the HeyAnon connection and the installer-owned skill.
  --agent  Enter the key on a local browser page (automatic without a terminal).

Codex/Claude: the key is saved in the client config. Read-only HeyAnon tools
run without a prompt; these still ask for confirmation:
  ${CONFIRM_TOOLS.join(', ')}
Hermes/OpenClaw: only a HEYANON_API_KEY reference is saved; set that secret in
the framework's own environment.

Get your API key at https://heyanon.ai/.
`;

function report(output, result) {
  output.write(`MCP reachable, ${result.toolCount} tools available (${ENDPOINT}).\n`);
  if (result.keyVerified === true) output.write('API key accepted by HeyAnon.\n');
  else if (result.keyVerified === false) output.write('API key could not be verified right now; check again after restarting the client.\n');
  else output.write('Discovery confirms connectivity, not API-key validity.\n');
}

export async function run(args, { env = process.env, homeDir, input = process.stdin, output = process.stdout, probe = checkConnection, browser = browserKey } = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { output.write(HELP); return; }
  if (args.length === 1 && args[0] === '--version') { output.write(`${VERSION}\n`); return; }
  const words = args.filter((word) => word !== '--agent');
  const browserMode = words.length !== args.length;
  const action = ['install', 'check', 'remove'].includes(words[0]) ? words.shift() : 'install';
  let client = words.shift();
  if (words.length || (client && !CLIENTS.includes(client)) || (browserMode && action !== 'install')) throw new Error(HELP);
  client ??= await chooseClient(input, output);
  const framework = FRAMEWORKS.includes(client);
  const read = async () => {
    const config = await readConfig(client, { env, homeDir });
    assertHeyAnonEntry(config.entry);
    return config;
  };

  if (action === 'check') {
    const config = await read();
    if (!config.entry) throw new Error(`No HeyAnon connection for ${client}. Run install first.`);
    validateEndpoint(config.entry.url);
    report(output, await probe(framework && !env[KEY_ENV] ? undefined : installedKey(config, { env }), { endpoint: ENDPOINT }));
    if (framework) output.write('Check the connection from the running framework too; its secret scope may differ from this shell.\n');
    return;
  }

  // Validate everything before asking for a key, then again after: the client
  // may write its own config while the user is busy with the key page.
  const plan = async () => {
    const config = await read();
    const skill = await planSkill(config, action, { homeDir, env });
    const channelPath = join(skill.path, 'scripts/channel.mjs');
    if (client === 'claude') assertChannelEntry(config, channelPath);
    const permission = client === 'claude' ? await planClaudePermissions(action, { homeDir, previous: skill.claudeRules }) : null;
    if (permission) recordClaudePermission(skill, permission.added);
    return { config, skill, permission, channelPath };
  };
  let state = await plan();
  let key;
  if (action === 'install') {
    output.write(`API key: sign in at https://heyanon.ai/ and copy your key.\nServer: ${ENDPOINT}\n`);
    if (framework) {
      key = env[KEY_ENV] ? validateKey(env[KEY_ENV]) : undefined;
      output.write('Saving only a HEYANON_API_KEY reference. Configure the secret in the framework environment; never send it through chat.\n');
    } else {
      key = validateKey(env[KEY_ENV] || (browserMode || !input.isTTY || !output.isTTY ? await browser({ output }) : await readSecret(input, output)));
      if (!env[KEY_ENV]) state = await plan();
    }
  }
  const { config, skill, permission, channelPath } = state;
  const next = changeConfig(config, action, key, { channelPath });
  if (action === 'install') report(output, await probe(key, { endpoint: ENDPOINT }));

  const transaction = await applySkill(skill);
  let changed;
  try { [changed] = await saveConfigs([{ config, next }, ...(permission ? [permission] : [])]); }
  catch (error) { await transaction.rollback(); throw error; }
  await transaction.finish();
  output.write(`${client}: ${changed ? action === 'remove' ? 'removed' : 'saved' : 'unchanged'} (${config.path})\n`);
  output.write(`HeyAnon skill: ${action === 'remove' ? (skill.previous ? 'removed' : 'not installed') : 'installed'} (${skill.path})\n`);
  if (changed && config.text !== null) output.write(`Previous config: ${config.path}.heyanon-connect.bak (may contain credentials).\n`);
  if (permission && action === 'install') {
    output.write(permission.added.allow
      ? `Claude tool permissions: HeyAnon tools allowed; confirmation prompts for ${permission.confirming.join(', ') || 'none'} (${permission.config.path}). Existing ask/deny rules keep priority.\n`
      : `Claude tool permissions: your existing HeyAnon allow rule was kept; nothing was added (${permission.config.path}).\n`);
  } else if (permission) {
    output.write(`Claude tool permissions: ${permission.added.allow || permission.added.ask.length ? 'installer-added HeyAnon rules removed' : 'no installer-added rules found'}.\n`);
    if (permission.kept.length) output.write(`HeyAnon rules not added by this installer remain in ${permission.config.path}: ${permission.kept.join(', ')}.\n`);
  } else if (action === 'install' && client === 'codex') {
    output.write(config.entry?.default_tools_approval_mode === undefined
      ? 'Codex HeyAnon tools: read-only tools run without a prompt; ask_anon, abort, clear and deletions ask for confirmation (server tool annotations, Codex default mode).\n'
      : `Codex HeyAnon tools: your default_tools_approval_mode = "${config.entry.default_tools_approval_mode}" and per-tool settings were kept.\n`);
  }
  if (action === 'remove') {
    output.write('Restart the client. Removing the connection does not revoke the key; the backup may still contain it.\n');
    return;
  }
  output.write('Restart the client and check its MCP connections.\n');
  if (client === 'claude') output.write('Claude task channel is configured; delivery needs explicit client channel opt-in. The skill waiter works without it.\n');
  if (framework) {
    output.write('The framework must resolve HEYANON_API_KEY before HeyAnon tools can work. The installer does not create or verify the framework secret.\n');
    output.write(client === 'hermes'
      ? 'Set it in the active Hermes profile secret settings or its .env, then /reload-mcp or restart Hermes.\n'
      : 'Expose HEYANON_API_KEY to the OpenClaw Gateway via its service/container secrets or profile .env, then restart that instance. A skill-only API key does not configure MCP authentication.\n');
  }
}
