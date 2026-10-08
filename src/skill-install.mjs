import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORKS, frameworkHome } from './config.mjs';
import { VERSION } from './version.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const marker = '.heyanon-connect.json';
const runtime = ['version', 'config', 'mcp', 'credentials', 'tasks', 'wait-command', 'codex-notify', 'channel'];
// Files desktop environments drop into any directory; they are neither hashed nor preserved.
const junk = (name) => ['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(name) || name.startsWith('._');

export function skillPath(client, homeDir = homedir(), env = process.env) {
  if (FRAMEWORKS.includes(client)) return join(frameworkHome(client, { homeDir, env }), 'skills/heyanon');
  return join(homeDir, client === 'codex' ? '.agents/skills/heyanon' : '.claude/skills/heyanon');
}

async function filesIn(root, dir = root) {
  const files = new Map();
  for (const name of (await readdir(dir)).sort()) {
    if (junk(name)) continue;
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('HeyAnon skill files must be regular files or directories.');
    if (info.isDirectory()) for (const entry of await filesIn(root, path)) files.set(...entry);
    else files.set(relative(root, path).replaceAll('\\', '/'), await readFile(path));
  }
  return files;
}

function digest(files) {
  const hash = createHash('sha256');
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (name !== marker) hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return hash.digest('hex');
}

async function existingSkill(path, client) {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('Existing HeyAnon skill is not a regular directory.');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const files = await filesIn(path);
  let info;
  try { info = JSON.parse(files.get(marker)?.toString()); } catch { /* An unrelated user skill is not ours to overwrite. */ }
  if (info?.owner !== 'heyanon-connect' || info.client !== client || info.digest !== digest(files)) {
    throw new Error('An existing HeyAnon skill is custom or has been edited. Move it aside before installing/removing; no skill files were changed.');
  }
  return info;
}

export async function planSkill(config, action, { homeDir, env, sourceRoot = project } = {}) {
  const path = skillPath(config.client, homeDir, env);
  const installed = await existingSkill(path, config.client);
  const previous = installed?.digest ?? null;
  const claudeRules = { allow: installed?.claudeAllowAdded === true, ask: installed?.claudeAskAdded };
  if (action === 'remove') return { path, previous, client: config.client, files: null, claudeRules };
  const files = await filesIn(join(sourceRoot, 'skills/heyanon'));
  // Native metadata lets the framework provide the secret to a host-side waiter.
  // No key is copied into the skill or connection manifest.
  const requirements = config.client === 'hermes'
    ? 'required_environment_variables:\n  - name: HEYANON_API_KEY\n    prompt: HeyAnon API key\n    help: Get your own key at https://heyanon.ai/\n    required_for: HeyAnon account tools and task waiting\n'
    : config.client === 'openclaw'
      ? 'metadata: {"openclaw":{"requires":{"bins":["node"],"env":["HEYANON_API_KEY"]},"primaryEnv":"HEYANON_API_KEY"}}\n'
      : '';
  if (requirements) files.set('SKILL.md', Buffer.from(files.get('SKILL.md').toString().replace('\n---\n', `\n${requirements}---\n`)));
  // The skill text refers to its own scripts by the real installed path.
  for (const [name, bytes] of files) if (name.endsWith('.md')) files.set(name, Buffer.from(bytes.toString().replaceAll('/absolute/path/to/this/skill', () => path)));
  files.set('connection.json', Buffer.from(`${JSON.stringify({ client: config.client, configPath: config.path }, null, 2)}\n`));
  for (const name of runtime) files.set(`runtime/${name}.mjs`, await readFile(join(sourceRoot, `src/${name}.mjs`)));
  // Copy the installed, lockfile-pinned native config parsers. No npm invocation
  // or download at skill execution time; the bootstrap checkout can be removed.
  for (const dependency of ['smol-toml', 'yaml', 'json5']) {
    for (const [name, bytes] of await filesIn(join(sourceRoot, `node_modules/${dependency}`))) files.set(`node_modules/${dependency}/${name}`, bytes);
  }
  files.set(marker, Buffer.from(`${JSON.stringify({ owner: 'heyanon-connect', client: config.client, version: VERSION, digest: digest(files) }, null, 2)}\n`));
  return { path, previous, client: config.client, files, claudeRules };
}

export function recordClaudePermission(plan, added) {
  if (plan.client !== 'claude' || !plan.files) return;
  const info = JSON.parse(plan.files.get(marker).toString());
  info.claudeAllowAdded = added.allow;
  // Ask rules are tracked only while the installer owns the allow rule, so taking it
  // over later (the user removed their own rule) adds them like a first install.
  if (added.allow) info.claudeAskAdded = added.ask; else delete info.claudeAskAdded;
  plan.files.set(marker, Buffer.from(`${JSON.stringify(info, null, 2)}\n`));
}

export async function applySkill(plan) {
  const { path, previous, client, files } = plan;
  if (((await existingSkill(path, client))?.digest ?? null) !== previous) throw new Error('The HeyAnon skill changed during setup. Run setup again.');
  if (!files && !previous) return { rollback: async () => {}, finish: async () => {} };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const backup = `${path}.${randomUUID()}.previous`;
  try {
    if (files) {
      await mkdir(temporary, { mode: 0o700 });
      for (const [name, bytes] of files) {
        const target = join(temporary, name);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600 });
      }
    }
    if (((await existingSkill(path, client))?.digest ?? null) !== previous) throw new Error('The HeyAnon skill changed during setup.');
    if (previous) await rename(path, backup);
    try { if (files) await rename(temporary, path); }
    catch (error) { if (previous) await rename(backup, path); throw error; }
    return {
      rollback: async () => { if (files) await rm(path, { recursive: true }); if (previous) await rename(backup, path); },
      finish: async () => { if (previous) await rm(backup, { recursive: true }); },
    };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
