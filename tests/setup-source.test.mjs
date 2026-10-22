import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyVerificationSource } from '../scripts/verification-source.mjs';

test('fresh-install source copies regular project files without following editor links or private/generated paths', (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'unspammed-source-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'source');
  const destination = join(temporary, 'clean');
  const external = join(temporary, 'external');
  mkdirSync(source);
  mkdirSync(external);
  writeFileSync(join(external, 'private.env'), 'FAKE_PRIVATE_SENTINEL');
  const files = {
    'package.json': '{"name":"source-fixture"}',
    'src/app.ts': 'export const fixture = true;',
    '.do/app.yaml': 'name: fixture',
    '.env.example': 'TELEGRAM_BOT_TOKEN=',
    'deploy/vm/app.env.example': 'PUBLIC_URL=',
    '.env': 'FAKE_INSTALLED_SECRET',
    'app.env.custom': 'FAKE_CUSTOM_SECRET',
    'deploy/vm/.env.production': 'FAKE_NESTED_SECRET',
    'wrangler.production.jsonc': 'FAKE_PRIVATE_CONFIG',
    '.watchtower/runtime.env': 'FAKE_RUNTIME_SECRET',
    '.tmp/private.env': 'FAKE_TEMP_SECRET',
    '.agents/config.md': 'editor metadata',
    '.claude/config.md': 'editor metadata',
  };
  for (const [file, contents] of Object.entries(files)) {
    const parts = file.split('/');
    mkdirSync(join(source, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(source, file), contents);
  }
  mkdirSync(join(source, '.claude/skills'));
  symlinkSync(external, join(source, '.claude/skills/fixture'));
  symlinkSync(external, join(source, 'linked-directory'));
  symlinkSync(join(external, 'private.env'), join(source, 'linked-file.ts'));
  symlinkSync(join(external, 'missing'), join(source, 'broken-link.ts'));
  const entries = [
    ...Object.keys(files),
    '.claude/skills/fixture',
    'linked-directory/private.env',
    'linked-file.ts',
    'broken-link.ts',
    'missing.ts',
    '../external/private.env',
    join(external, 'private.env'),
    'package.json',
  ];
  const fifo = join(source, 'special.ts');
  if (spawnSync('mkfifo', [fifo]).status === 0) entries.push('special.ts');
  const copied = copyVerificationSource(source, destination, entries);
  const expected = [
    'package.json',
    'src/app.ts',
    '.do/app.yaml',
    '.env.example',
    'deploy/vm/app.env.example',
  ];
  assert.deepEqual(copied, expected);
  for (const file of expected)
    assert.equal(readFileSync(join(destination, file), 'utf8'), files[file]);
  for (const file of entries.filter(
    (file) => !expected.includes(file) && !file.startsWith('..') && !file.startsWith('/'),
  ))
    assert.equal(existsSync(join(destination, file)), false, file);
  assert.equal(readFileSync(join(external, 'private.env'), 'utf8'), 'FAKE_PRIVATE_SENTINEL');
});
