import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {name: string; bin: Record<string, string>; private?: boolean; files: string[]; dependencies: Record<string, string>};

test('package: publishable, one bin that points at a built file with a shebang', async () => {
  assert.equal(manifest.private, undefined, 'a private package cannot be published');
  assert.equal(manifest.name, 'agy-mcp-bridge');
  assert.deepEqual(Object.keys(manifest.bin), ['agy-mcp-bridge']);
  const target = path.join(root, manifest.bin['agy-mcp-bridge']);
  assert.ok((await readFile(target, 'utf8')).startsWith('#!/usr/bin/env node\n'));
  assert.ok(manifest.dependencies['@modelcontextprotocol/client'], 'the check command needs the client at runtime');
});
test('package: the declared license has a matching LICENSE file that npm will ship', async () => {
  assert.equal((manifest as unknown as {license?: string}).license, 'MIT');
  const text = await readFile(path.join(root, 'LICENSE'), 'utf8');
  assert.match(text, /^MIT License\r?\n/);
  assert.match(text, /^Copyright \(c\) \d{4} \S.+$/m, 'has a copyright line with a holder');
  assert.match(text, /Permission is hereby granted, free of charge/);
});
test('package: npm pack contains what the CLI needs and nothing else', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {cwd: root, encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(result.status, 0, result.stderr);
  const files = (JSON.parse(result.stdout) as {files: {path: string}[]}[])[0].files.map(file => file.path.replace(/\\/g, '/'));
  for (const needed of ['dist/src/cli.js', 'dist/src/index.js', 'dist/src/paths.js', 'dist/src/update.js', 'dist/scripts/check.js', 'dist/scripts/delegation.js',
    'dist/scripts/install-skill.js', 'ui/index.html', 'ui/app.js', 'ui/app.css', 'ui/favicon.svg', 'skills/antigravity-bridge/SKILL.md',
    'skills/mission-orchestrator/SKILL.md', 'README.md', 'LICENSE', 'package.json']) {
    assert.ok(files.includes(needed), `missing ${needed}`);
  }
  for (const file of files) {
    assert.ok(!file.startsWith('dist/tests/'), `test file shipped: ${file}`);
    assert.ok(!file.endsWith('.map'), `source map shipped: ${file}`);
    assert.ok(!/(^|\/)(\.bridge-state|test-results|node_modules)\//.test(file), `local state shipped: ${file}`);
    assert.notEqual(file, 'config/workspaces.json', 'a local config must never be published');
    assert.ok(!file.includes('fake-agy'));
    assert.ok(!/(token|\.env)/i.test(path.basename(file)), `suspicious file: ${file}`);
  }
  assert.ok(!files.includes('docs/HANDOFF.md'), 'the working handoff note is for this repository, not for whoever installs the package');
  assert.ok(files.includes('docs/HARDENING.md'), 'the published package still carries its security notes');
});
