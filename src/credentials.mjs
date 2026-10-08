import { readFile } from 'node:fs/promises';
import { FRAMEWORKS, installedKey, readConfigAt } from './config.mjs';

// connection.json contains only a client name and config path, never the key.
// Always read the current native config so key rotation takes effect immediately.
export async function credentials(connectionUrl = new URL('../connection.json', import.meta.url), { env = process.env } = {}) {
  let connection;
  try { connection = JSON.parse(await readFile(connectionUrl, 'utf8')); }
  catch { throw new Error('Run HeyAnon Connect install to set up this skill first.'); }
  const config = await readConfigAt(connection.client, connection.configPath);
  if (config.entry?.enabled === false || config.entry?.disabled_tools?.includes('background_task') ||
    (Array.isArray(config.entry?.enabled_tools) && !config.entry.enabled_tools.includes('background_task'))) {
    throw new Error('Background task reading is disabled in this client configuration.');
  }
  // The helper cannot reproduce a host's full policy/glob language. Keep filtered
  // remote connections on the host's own MCP path instead of bypassing filters.
  if (FRAMEWORKS.includes(config.client) && (config.entry?.tools || config.entry?.toolFilter)) {
    throw new Error('This connection has framework tool filters. Use the framework\'s native background_task tool so those filters remain enforced.');
  }
  return { apiKey: installedKey(config, { env }), endpoint: config.entry.url };
}
