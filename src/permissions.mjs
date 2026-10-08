import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIRM_TOOLS, readConfigFile } from './config.mjs';

export const CLAUDE_HEYANON_ALLOW = 'mcp__heyanon__*';
export const CLAUDE_HEYANON_ASK = CONFIRM_TOOLS.map((tool) => `mcp__heyanon__${tool}`);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const serialize = (data) => `${JSON.stringify(data, null, 2)}\n`;

// `previous` is what the installer recorded as its own rules on an earlier run:
// allow (boolean) and ask (array, or undefined for installs made before ask rules existed).
export async function planClaudePermissions(action, { homeDir = homedir(), previous = { allow: false, ask: undefined } } = {}) {
  const path = join(homeDir, '.claude/settings.json');
  const text = await readConfigFile(path);
  let data;
  try {
    data = text === null ? {} : JSON.parse(text);
    if (!isObject(data) || (data.permissions !== undefined && !isObject(data.permissions))) throw new Error();
    for (const key of ['allow', 'ask', 'deny']) {
      const rules = data.permissions?.[key];
      if (rules !== undefined && (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string'))) throw new Error();
    }
  } catch {
    throw new Error('Cannot parse Claude permissions in settings.json. Fix the file before running setup; it was not changed.');
  }
  const config = { path, text };
  const rules = (key) => data.permissions?.[key] ?? [];
  // Only rules that still exist can be ours; the user may have removed some by hand.
  const added = { allow: previous.allow && rules('allow').includes(CLAUDE_HEYANON_ALLOW), ask: (previous.ask ?? []).filter((rule) => rules('ask').includes(rule)) };
  const before = JSON.stringify(data);
  if (action === 'remove') {
    if (added.allow) data.permissions.allow = rules('allow').filter((rule) => rule !== CLAUDE_HEYANON_ALLOW);
    if (added.ask.length) data.permissions.ask = rules('ask').filter((rule) => !added.ask.includes(rule));
    for (const key of ['allow', 'ask']) if (data.permissions?.[key]?.length === 0) delete data.permissions[key];
    if (data.permissions && !Object.keys(data.permissions).length) delete data.permissions;
  } else if (added.allow || !rules('allow').some((rule) => [CLAUDE_HEYANON_ALLOW, 'mcp__heyanon'].includes(rule))) {
    // The installer owns the server-wide allow rule; a rule the user wrote is left exactly as is.
    data.permissions ??= {};
    if (!added.allow) data.permissions.allow = [...rules('allow'), CLAUDE_HEYANON_ALLOW];
    added.allow = true;
    if (previous.ask === undefined) {
      // First time with ask rules: actions keep a confirmation prompt; explicit ask/deny rules stay.
      const missing = CLAUDE_HEYANON_ASK.filter((rule) => !rules('ask').includes(rule) && !rules('deny').includes(rule));
      if (missing.length) data.permissions.ask = [...rules('ask'), ...missing];
      added.ask = missing;
    }
  }
  const final = (key) => data.permissions?.[key] ?? [];
  // What the client will actually do after this run, for the summary line.
  const confirming = CONFIRM_TOOLS.filter((tool) => ['ask', 'deny'].some((key) => final(key).includes(`mcp__heyanon__${tool}`)));
  const kept = action === 'remove' ? [CLAUDE_HEYANON_ALLOW, 'mcp__heyanon', ...CLAUDE_HEYANON_ASK].filter((rule) => final('allow').includes(rule) || final('ask').includes(rule)) : [];
  return { config, next: JSON.stringify(data) === before ? text : serialize(data), added, confirming, kept };
}
