import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = new URL('../labs/', import.meta.url);
const catalog = readFileSync(new URL('README.md', directory), 'utf8');

test('cada entrada pública de la beta instalada tiene un consumidor enlazado que la importa', () => {
  const metadata = new URL('../package.json', import.meta.resolve('hiveagents-runtime'));
  const sdk = JSON.parse(readFileSync(metadata, 'utf8'));
  const expected = Object.keys(sdk.exports).map(key => sdk.name + key.slice(1));
  const documented = [];
  for (const row of catalog.matchAll(/^\| `(hiveagents-runtime[^`]*)` \| \[[^\]]+\]\(([^)]+)\)/gm)) {
    const [, entry, link] = row;
    documented.push(entry);
    const source = readFileSync(new URL(link, directory), 'utf8');
    assert.ok(source.includes(`from '${entry}'`), `${link} debe importar ${entry}`);
  }
  assert.deepEqual(documented.sort(), expected.sort());
});

for (const lab of ['custom-cli', 'plan', 'capacity', 'context', 'approval', 'memory', 'history', 'learning', 'hosted']) {
  test('laboratorio local: ' + lab, () => {
    const file = fileURLToPath(new URL(lab + '.mjs', directory));
    execFileSync(process.execPath, [file], { stdio: 'inherit', timeout: 30_000 });
  });
}
