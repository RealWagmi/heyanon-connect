import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENTS, CONFIRM_TOOLS, ENDPOINT, FRAMEWORKS, KEY_ENV, assertChannelEntry, assertHeyAnonEntry, changeConfig, installedKey, readConfig, saveConfigs, validateEndpoint, validateKey } from './config.mjs';
import { checkConnection } from './mcp.mjs';
import { chooseClient, readSecret } from './prompt.mjs';
import { browserKey } from './browser-key.mjs';
import { applySkill, planSkill, recordClaudePermission } from './skill-install.mjs';
import { planClaudePermissions } from './permissions.mjs';
import { VERSION } from './version.mjs';

const HELP = `HeyAnon Connect

Usage: heyanon-connect [install|check|remove] [codex|claude|hermes|openclaw] [--agent]

  install  Add the HeyAnon MCP connection, skill and task waiter (default).
  check    Check the saved connection: MCP discovery and API-key acceptance.
  remove   Remove the HeyAnon connection and the installer-owned skill.
  --agent  Print a link to a local key page and exit; the page finishes the
           setup (automatic when there is no terminal).

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

// Agent mode: a detached copy of the installer serves the key page and finishes
// the setup on its own, so the calling command returns at once with the link.
async function detachedPage(client, output) {
  const script = fileURLToPath(new URL('../bin/heyanon-connect.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, 'install', client, '--serve'], { detached: true, cwd: homedir(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const url = await new Promise((resolve, reject) => {
    child.once('message', (message) => (message?.url ? resolve(message.url) : reject(new Error(message?.error ?? 'The key page could not be started.'))));
    child.once('exit', () => reject(new Error('The key page could not be started.')));
  });
  child.disconnect();
  child.unref();
  output.write(`Give the user this link to enter the HeyAnon API key:\n${url}\nThe page works for 15 minutes on this machine only and shows the setup result after the key is entered.\nThen verify with: heyanon-connect check ${client}\n`);
}

export async function run(args, { env = process.env, homeDir, input = process.stdin, output = process.stdout, probe = checkConnection, browser = browserKey, page = detachedPage } = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { output.write(HELP); return; }
  if (args.length === 1 && args[0] === '--version') { output.write(`${VERSION}\n`); return; }
  const words = args.filter((word) => !['--agent', '--serve'].includes(word));
  const browserMode = args.includes('--agent');
  const serveMode = args.includes('--serve');
  const action = ['install', 'check', 'remove'].includes(words[0]) ? words.shift() : 'install';
  let client = words.shift();
  if (words.length || (client && !CLIENTS.includes(client)) || ((browserMode || serveMode) && action !== 'install')) throw new Error(HELP);
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

  // The skill is planned once (its sources may be a temporary download); the
  // configs are re-read right before writing, because the client may change
  // them while the user is busy with the key.
  const skill = await planSkill(await read(), action, { homeDir, env });
  const channelPath = join(skill.path, 'scripts/channel.mjs');
  const planConfig = async () => {
    const config = await read();
    if (client === 'claude') assertChannelEntry(config, channelPath);
    const permission = client === 'claude' ? await planClaudePermissions(action, { homeDir, previous: skill.claudeRules }) : null;
    if (permission) recordClaudePermission(skill, permission.added);
    return { config, permission };
  };
  let { config, permission } = await planConfig();

  const complete = async (key, out) => {
    const next = changeConfig(config, action, key, { channelPath });
    if (action === 'install') report(out, await probe(key, { endpoint: ENDPOINT }));
    const transaction = await applySkill(skill);
    let changed;
    try { [changed] = await saveConfigs([{ config, next }, ...(permission ? [permission] : [])]); }
    catch (error) { await transaction.rollback(); throw error; }
    await transaction.finish();
    out.write(`${client}: ${changed ? action === 'remove' ? 'removed' : 'saved' : 'unchanged'} (${config.path})\n`);
    out.write(`HeyAnon skill: ${action === 'remove' ? (skill.previous ? 'removed' : 'not installed') : 'installed'} (${skill.path})\n`);
    if (changed && config.text !== null) out.write(`Previous config: ${config.path}.heyanon-connect.bak (may contain credentials).\n`);
    if (permission && action === 'install') {
      out.write(permission.added.allow
        ? `Claude tool permissions: HeyAnon tools allowed; confirmation prompts for ${permission.confirming.join(', ') || 'none'} (${permission.config.path}). Existing ask/deny rules keep priority.\n`
        : `Claude tool permissions: your existing HeyAnon allow rule was kept; nothing was added (${permission.config.path}).\n`);
    } else if (permission) {
      out.write(`Claude tool permissions: ${permission.added.allow || permission.added.ask.length ? 'installer-added HeyAnon rules removed' : 'no installer-added rules found'}.\n`);
      if (permission.kept.length) out.write(`HeyAnon rules not added by this installer remain in ${permission.config.path}: ${permission.kept.join(', ')}.\n`);
    } else if (action === 'install' && client === 'codex') {
      out.write(config.entry?.default_tools_approval_mode === undefined
        ? 'Codex HeyAnon tools: read-only tools run without a prompt; ask_anon, abort, clear and deletions ask for confirmation (server tool annotations, Codex default mode).\n'
        : `Codex HeyAnon tools: your default_tools_approval_mode = "${config.entry.default_tools_approval_mode}" and per-tool settings were kept.\n`);
    }
    if (action === 'remove') {
      out.write('Restart the client. Removing the connection does not revoke the key; the backup may still contain it.\n');
      return;
    }
    out.write('Restart the client and check its MCP connections.\n');
    if (client === 'claude') out.write('Claude task channel is configured; delivery needs explicit client channel opt-in. The skill waiter works without it.\n');
    if (framework) {
      out.write('The framework must resolve HEYANON_API_KEY before HeyAnon tools can work. The installer does not create or verify the framework secret.\n');
      out.write(client === 'hermes'
        ? 'Set it in the active Hermes profile secret settings or its .env, then /reload-mcp or restart Hermes.\n'
        : 'Expose HEYANON_API_KEY to the OpenClaw Gateway via its service/container secrets or profile .env, then restart that instance. A skill-only API key does not configure MCP authentication.\n');
    }
  };

  if (action === 'remove') { await complete(undefined, output); return; }
  output.write(`API key: sign in at https://heyanon.ai/ and copy your key.\nServer: ${ENDPOINT}\n`);
  if (framework) {
    output.write('Saving only a HEYANON_API_KEY reference. Configure the secret in the framework environment; never send it through chat.\n');
    await complete(env[KEY_ENV] ? validateKey(env[KEY_ENV]) : undefined, output);
    return;
  }
  if (env[KEY_ENV]) { await complete(validateKey(env[KEY_ENV]), output); return; }
  if (!browserMode && !serveMode && input.isTTY && output.isTTY) {
    const key = validateKey(await readSecret(input, output));
    ({ config, permission } = await planConfig());
    await complete(key, output);
    return;
  }
  if (!serveMode) { await page(client, output); return; }
  // Serving process: the page collects the key, finishes the setup and shows the summary.
  await browser({
    output,
    onUrl: (url) => { if (process.connected) process.send({ url }); },
    submit: async (key) => {
      ({ config, permission } = await planConfig());
      const lines = [];
      await complete(key, { write: (text) => lines.push(text) });
      return lines.join('');
    },
  });
}
