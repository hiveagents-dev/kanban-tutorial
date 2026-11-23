import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore, tutorialCard } from '../src/store.mjs';

function state(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-store-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return { store: openStore(dir), path: join(dir, 'board.json'), dir };
}

test('un tablero vacío y uno guardado sobreviven al reinicio', t => {
  const { store, dir } = state(t);
  assert.equal(store.exists(), false);
  assert.deepEqual(store.load(), []);
  const card = {
    ...tutorialCard, id: 'a1', status: 'pending', attempts: 0,
    events: [{ at: '2026-11-23T12:00:00Z', role: 'system', message: 'Creada' }], checks: [], artifact: '',
  };
  store.save([card]);
  assert.deepEqual(openStore(dir).load(), [card]);
  store.save([]);
  assert.equal(openStore(dir).exists(), true);
  assert.deepEqual(openStore(dir).load(), []);
});

test('datos dañados o de otra versión se conservan en disco', t => {
  const { store, path } = state(t);
  for (const input of ['{', '{"version":3,"cards":[]}', '{"version":1,"cards":[{}]}']) {
    writeFileSync(path, input);
    assert.throws(() => store.load());
    assert.equal(readFileSync(path, 'utf8'), input);
  }
});
