import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('bootstrap forwards arguments and deletes downloaded files on success or failure', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'heyanon-bootstrap-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const downloads = join(root, 'downloads');
  await mkdir(bin);
  await mkdir(downloads);
  const fixtures = {
    mktemp: '#!/bin/sh\nmkdir "$CONNECT_TEST_DOWNLOADS/work"\nprintf "%s\\n" "$CONNECT_TEST_DOWNLOADS/work"\n',
    curl: '#!/bin/sh\nwhile [ "$#" -gt 1 ]; do shift; done\n: > "$1"\n',
    tar: '#!/bin/sh\nwhile [ "$#" -gt 1 ]; do shift; done\nmkdir "$1/bin"\n: > "$1/bin/heyanon-connect.mjs"\n',
    npm: '#!/bin/sh\ntest "$1" = ci\n',
    node: '#!/bin/sh\n[ "$1" = -e ] && exit 0\ntest -f "$1" || exit 99\nshift\nprintf "CLI: %s %s\\n" "$1" "$2"\nexit "$CONNECT_TEST_EXIT"\n',
  };
  for (const [name, script] of Object.entries(fixtures)) await writeFile(join(bin, name), script, { mode: 0o700 });
  const script = fileURLToPath(new URL('../install.sh', import.meta.url));
  for (const code of [0, 1]) {
    const result = spawnSync('bash', [script, 'check', 'codex'], {
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CONNECT_TEST_DOWNLOADS: downloads, CONNECT_TEST_EXIT: String(code) }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stdout, /CLI: check codex/);
    await assert.rejects(access(join(downloads, 'work')), { code: 'ENOENT' });
  }
});
