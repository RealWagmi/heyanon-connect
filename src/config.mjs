import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import JSON5 from 'json5';
import YAML, { isAlias, isMap, visit } from 'yaml';

export const ENDPOINT = 'https://dev.api.heyanon.ai/mcp';
export const CLIENTS = ['codex', 'claude', 'hermes', 'openclaw'];
export const FRAMEWORKS = ['hermes', 'openclaw'];
export const KEY_ENV = 'HEYANON_API_KEY';
export const KEY_REFERENCE = '${HEYANON_API_KEY}';
// Tools that act on the account or the Anon conversation keep asking for confirmation in
// Claude Code (ask rules). Codex needs nothing: its default approval mode follows the
// server's tool annotations, which mark exactly these tools as not read-only.
export const CONFIRM_TOOLS = ['ask_anon', 'abort', 'background_task_delete', 'scheduled_task_delete'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAuthHeader = (name) => ['authorization', 'x-api-key'].includes(name.toLowerCase());

function expandedPath(path, homeDir) {
  return resolve(path === '~' ? homeDir : path.startsWith('~/') ? join(homeDir, path.slice(2)) : path);
}

export function frameworkHome(client, { homeDir = homedir(), env = process.env } = {}) {
  if (client === 'hermes') return env.HERMES_HOME ? expandedPath(env.HERMES_HOME, homeDir) : join(homeDir, '.hermes');
  if (client !== 'openclaw') throw new Error('Unknown framework.');
  if (env.OPENCLAW_STATE_DIR) return expandedPath(env.OPENCLAW_STATE_DIR, homeDir);
  const profile = env.OPENCLAW_PROFILE;
  if (profile && !/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid OpenClaw profile name.');
  const root = env.OPENCLAW_HOME ? expandedPath(env.OPENCLAW_HOME, homeDir) : homeDir;
  return join(root, profile && profile !== 'default' ? `.openclaw-${profile}` : '.openclaw');
}

export function configPath(client, { homeDir = homedir(), env = process.env } = {}) {
  if (client === 'codex') return join(env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homeDir, '.codex'), 'config.toml');
  if (client === 'claude') {
    // Do not silently edit the default file when a client uses a custom location.
    if (env.CLAUDE_CONFIG_DIR) throw new Error('Custom CLAUDE_CONFIG_DIR is not supported yet. Configure HeyAnon in that profile manually.');
    return join(homeDir, '.claude.json');
  }
  if (client === 'hermes') return join(frameworkHome(client, { homeDir, env }), 'config.yaml');
  if (client === 'openclaw') return env.OPENCLAW_CONFIG_PATH
    ? expandedPath(env.OPENCLAW_CONFIG_PATH, homeDir) : join(frameworkHome(client, { homeDir, env }), 'openclaw.json');
  throw new Error('Choose codex, claude, hermes or openclaw.');
}

function serverSection(client) {
  return client === 'openclaw' ? 'servers' : client === 'claude' ? 'mcpServers' : 'mcp_servers';
}

function decode(client, text) {
  try {
    let document;
    let data;
    if (client === 'hermes') {
      // Keep the parsed document: Hermes configs are edited in place to preserve comments and quoting.
      document = YAML.parseDocument(text ?? '', { merge: true });
      // Do not let parser warnings print fragments of a personal config to stderr.
      if (document.errors.length || document.warnings.length) throw new Error();
      data = document.toJS() ?? {};
    } else {
      data = text === null ? {} : client === 'codex' ? parse(text, { integersAsBigInt: 'asNeeded' })
        : client === 'openclaw' ? JSON5.parse(text) : JSON.parse(text);
    }
    if (!isObject(data)) throw new Error();
    if (client === 'openclaw' && data.mcp !== undefined && !isObject(data.mcp)) throw new Error();
    const servers = (client === 'openclaw' ? data.mcp : data)?.[serverSection(client)];
    // An empty section (`mcp_servers:`) parses as null; the frameworks treat it as empty too.
    if (servers !== undefined && servers !== null && !isObject(servers)) throw new Error();
    return { data, document };
  } catch {
    throw new Error(`Cannot parse the ${client} config. Fix it before running setup; the file was not changed.`);
  }
}

export async function readConfigFile(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Config must be a regular file, not a symbolic or hard link.');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // File errors may contain paths but must never include config contents.
    throw error;
  }
}

export async function readConfig(client, options = {}) {
  return readConfigAt(client, configPath(client, options));
}

export async function readConfigAt(client, path) {
  if (!CLIENTS.includes(client)) throw new Error('Unknown client.');
  const text = await readConfigFile(path);
  const { data, document } = decode(client, text);
  const section = serverSection(client);
  const container = client === 'openclaw' ? data.mcp : data;
  const entry = container?.[section]?.heyanon;
  if (client === 'openclaw' && [data, container, container?.[section], entry].some((node) => isObject(node) && '$include' in node)) {
    throw new Error('HeyAnon settings use an OpenClaw $include. Edit the owning config with OpenClaw; the installer will not flatten included settings.');
  }
  return { client, path, text, data, document, section, entry };
}

export function assertHeyAnonEntry(entry) {
  if (entry === undefined) return;
  // Recognize existing HeyAnon connections so reinstall can update their URL.
  if (!isObject(entry) || typeof entry.url !== 'string' || (entry.url !== ENDPOINT && !/^https:\/\/(?:dev\.)?api\.heyanon\.ai\/mcp$/.test(entry.url)) || entry.command !== undefined) {
    throw new Error('The name "heyanon" is already used by a different connection. Rename that entry before continuing.');
  }
  // Shape problems surface here, before any key is requested.
  for (const field of ['headers', 'http_headers', 'env_http_headers', 'tools']) {
    if (entry[field] !== undefined && !isObject(entry[field])) throw new Error(`The existing HeyAnon "${field}" setting must be a table of values.`);
  }
}

// The installer owns a Claude channel entry when it points at the installed channel script,
// whatever Node binary wrote it: Node upgrades must not block updates or removal.
const ownsChannel = (existing, channelPath) => isObject(existing) && Array.isArray(existing.args) && existing.args.length === 1 && existing.args[0] === channelPath;

export function assertChannelEntry(config, channelPath) {
  const existing = config.data[config.section]?.heyanon_events;
  if (existing !== undefined && !ownsChannel(existing, channelPath)) throw new Error('The name "heyanon_events" is already used by a different connection.');
}

export function validateEndpoint(endpoint) {
  if (endpoint !== ENDPOINT) throw new Error('Run install to update the HeyAnon MCP connection.');
  return endpoint;
}

export function validateKey(value) {
  const key = value?.trim();
  if (!key || !/^[\x21-\x7e]+$/.test(key) || key.includes('${')) {
    throw new Error('Enter an API key from https://heyanon.ai/ (one token, without whitespace).');
  }
  return key;
}

export function installedKey(config, { env = process.env } = {}) {
  assertHeyAnonEntry(config.entry);
  const headers = config.entry?.[config.client === 'codex' ? 'http_headers' : 'headers'];
  const key = headers && Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-api-key')?.[1];
  if (FRAMEWORKS.includes(config.client)) {
    if (key !== KEY_REFERENCE && !(config.client === 'hermes' && key === '${env:HEYANON_API_KEY}')) {
      throw new Error('The waiter expects the HEYANON_API_KEY environment reference. For another secret provider, use the framework\'s native MCP tools.');
    }
    if (!env[KEY_ENV]) throw new Error('HEYANON_API_KEY is not available to this process. Run the waiter in the framework environment with that secret injected, or use its native background_task tool. Do not paste the key into chat.');
    return validateKey(env[KEY_ENV]);
  }
  if (typeof key !== 'string') throw new Error(`No saved HeyAnon API key for ${config.client}. Run install first.`);
  return validateKey(key);
}

function withoutAuthHeaders(headers) {
  if (headers !== undefined && !isObject(headers)) throw new Error('The existing HeyAnon headers must be an object.');
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !isAuthHeader(name)));
}

// Hermes reads YAML 1.1: strings it would retype (booleans, sexagesimals, dates, octals) stay quoted.
const YAML11_SCALAR = /^(?:y|yes|n|no|on|off|true|false|null|~|[-+]?\d[\d_]*(?::[0-5]?\d)+|\d{4}-\d\d?-\d\d?(?:[Tt ].*)?|0o?[0-7_]+|0x[\dA-Fa-f_]+|[-+]?\.(?:inf|nan))$/i;

// Hermes: edit the YAML document itself so comments, quoting and anchors outside our entry survive.
function writeHermes(config, entry) {
  const document = config.document.clone();
  const path = ['mcp_servers', 'heyanon'];
  try {
    if (!isMap(document.contents)) document.contents = document.createNode({});
    const servers = document.get('mcp_servers', true);
    // An alias, a merge key or an empty value may stand in for the server map. Materialize
    // the resolved map (toJS already merged it) so the anchor source itself stays untouched.
    if (!isMap(servers) && (servers !== undefined || isObject(config.data.mcp_servers))) {
      document.set('mcp_servers', document.createNode(isObject(config.data.mcp_servers) ? config.data.mcp_servers : {}));
    }
    const map = document.get('mcp_servers', true);
    if (isMap(map) && map.flow && !map.items.length) map.flow = false;
    const existing = document.hasIn(path);
    if (entry === undefined) {
      if (!existing) {
        if (config.entry !== undefined) throw new Error('merge');
        return null;
      }
      document.deleteIn(path);
    } else {
      const node = document.createNode(entry);
      visit(node, { Scalar(_, scalar) { if (typeof scalar.value === 'string' && YAML11_SCALAR.test(scalar.value)) scalar.type = 'QUOTE_DOUBLE'; } });
      const old = existing ? document.getIn(path, true) : undefined;
      if (old && !isAlias(old)) { node.comment = old.comment; node.commentBefore = old.commentBefore; }
      document.setIn(path, node);
    }
    // Keep the file's own indentation width; the parser does not record it.
    const indent = /^( +)\S/m.exec(config.text ?? '')?.[1].length || 2;
    return document.toString({ lineWidth: 0, indent });
  } catch (error) {
    if (error.message === 'merge') throw new Error('The heyanon entry comes from a YAML merge key or alias in config.yaml. Edit that map manually.');
    throw new Error('Cannot edit the hermes config: the heyanon entry or its server map is anchored or aliased elsewhere. Edit config.yaml manually.');
  }
}

export function changeConfig(config, action, key, { channelPath } = {}) {
  assertHeyAnonEntry(config.entry);
  const { data, section, client } = config;
  // OpenClaw's native registry is mcp.servers, not the Claude mcpServers map.
  const container = client === 'openclaw' ? (action === 'remove' ? data.mcp : data.mcp ??= {}) : data;
  if (container?.[section]) container[section] = { ...container[section] };
  if (action === 'remove') {
    let changed = false;
    if (client === 'claude' && channelPath && data[section]?.heyanon_events !== undefined) {
      assertChannelEntry(config, channelPath);
      delete data[section].heyanon_events;
      changed = true;
    }
    if (container?.[section]?.heyanon !== undefined) {
      delete container[section].heyanon;
      changed = true;
    }
    if (client === 'hermes') return writeHermes(config, undefined);
    return changed ? encode(client, data) : null;
  }
  const entry = { ...config.entry, url: ENDPOINT };
  if (client === 'codex') {
    // No approval settings are written: Codex's default mode auto-approves read-only
    // tools and asks before the rest, based on the server's annotations. User settings stay.
    entry.http_headers = { ...withoutAuthHeaders(entry.http_headers), 'X-API-Key': validateKey(key) };
    // The typed key becomes the only credential: Codex prefers env/helper headers over static ones.
    delete entry.bearer_token;
    delete entry.bearer_token_env_var;
    delete entry.http_headers_helper;
    if (entry.env_http_headers) entry.env_http_headers = withoutAuthHeaders(entry.env_http_headers);
  } else if (client === 'claude') {
    if (channelPath) {
      assertChannelEntry(config, channelPath);
      data[section] ??= {};
      data[section].heyanon_events = { ...data[section].heyanon_events, type: 'stdio', command: process.execPath, args: [channelPath] };
    }
    entry.type = 'http';
    entry.headers = { ...withoutAuthHeaders(entry.headers), 'X-API-Key': validateKey(key) };
    delete entry.headersHelper;
  } else {
    // Remote onboarding never copies a raw key into MCP config or skill files.
    // Refuse to replace a deliberately configured secret provider or OAuth flow.
    const savedKey = Object.entries(entry.headers ?? {}).find(([name]) => name.toLowerCase() === 'x-api-key')?.[1];
    const hasAuthorization = Object.keys(entry.headers ?? {}).some((name) => name.toLowerCase() === 'authorization');
    if ((savedKey !== undefined && savedKey !== KEY_REFERENCE && savedKey !== '${env:HEYANON_API_KEY}') || hasAuthorization || entry.auth || entry.oauth) {
      throw new Error('HeyAnon already uses another credential configuration. Keep it and configure the skill manually, or remove that connection before installing.');
    }
    entry.headers = { ...withoutAuthHeaders(entry.headers), 'X-API-Key': KEY_REFERENCE };
    if (client === 'openclaw') entry.transport = 'streamable-http';
  }
  if (client === 'hermes') return writeHermes(config, entry);
  container[section] ??= {};
  container[section].heyanon = entry;
  return encode(client, data);
}

function encode(client, data) {
  return client === 'codex' ? stringify(data) : `${JSON.stringify(data, null, 2)}\n`;
}

async function atomicWrite(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function saveConfig(config, next) {
  if (next === null || next === config.text) return false;
  await mkdir(dirname(config.path), { recursive: true, mode: 0o700 });
  const unchanged = async () => {
    if (await readConfigFile(config.path) !== config.text) {
      throw new Error('The client config changed during setup. Run setup again.');
    }
  };
  await unchanged();
  if (config.text !== null) await atomicWrite(`${config.path}.heyanon-connect.bak`, config.text);
  await unchanged();
  await atomicWrite(config.path, next);
  return true;
}

// Claude keeps MCP connections and permissions in separate files. If the
// second write fails, restore the first without overwriting concurrent edits.
export async function saveConfigs(plans, { save = saveConfig } = {}) {
  const written = [];
  const changed = [];
  try {
    for (const plan of plans) {
      const didChange = await save(plan.config, plan.next);
      changed.push(didChange);
      if (didChange) written.push(plan);
    }
    return changed;
  } catch (error) {
    let rollbackFailed = false;
    for (const { config, next } of written.reverse()) {
      try {
        if (await readConfigFile(config.path) !== next) throw new Error('Concurrent change');
        if (config.text === null) await rm(config.path);
        else await atomicWrite(config.path, config.text);
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new Error('Setup failed and a changed config could not be restored safely. Review the config files and their .heyanon-connect.bak backups.');
    throw error;
  }
}
