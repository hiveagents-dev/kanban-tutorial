import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileContext, ConstraintAuthority, ConstraintStore, ContextBudgetError, deliverPinned, requirePinned,
} from 'hiveagents-runtime/orchestration';

const dir = mkdtempSync(join(tmpdir(), 'kanban-contexto-'));
const authority = ConstraintAuthority.create();
const store = ConstraintStore.create(authority, { databasePath: join(dir, 'reglas.sqlite') });
try {
  store.pin(authority, {
    scope: 'kanban', id: 'formato', text: 'La entrega es un documento Markdown.', expectedVersion: 0, setBy: 'editor',
  });
  const request = {
    constraints: store, scopes: ['kanban'], require: [{ scope: 'kanban', id: 'formato', minVersion: 1 }],
    task: { instructions: 'Redactá una guía de inicio.', history: [{ id: 'viejo', role: 'user', text: 'Borrador descartado. '.repeat(60) }] },
    budget: { maxBytes: 400 },
  };
  const compiled = compileContext(request);
  assert.equal(compiled.pinned.carried[0].id, 'formato');
  assert.deepEqual(compiled.omitted.history, ['viejo']);
  assert.throws(() => compileContext({ ...request, budget: { maxBytes: 1 } }), ContextBudgetError);
  const delivery = requirePinned(deliverPinned({ options: { model: 'claude/sonnet' }, pinned: compiled.pinned, turn: 'fresh' }));
  assert.equal(delivery.status, 'pinned');
  console.log('Regla conservada:', compiled.pinned.text, '\nHistorial omitido:', compiled.omitted.history.join(', '));
  console.log('Opciones del agente preparadas. No se envió ningún turno.');
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
