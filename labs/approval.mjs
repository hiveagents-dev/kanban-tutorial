import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerInbox, SystemInbox } from 'hiveagents-runtime/orchestration';

const directory = mkdtempSync(join(tmpdir(), 'kanban-aprobacion-'));
const databasePath = join(directory, 'inbox.sqlite');
const actionKind = 'card.export';
const system = new SystemInbox({
  databasePath, systemId: 'kanban', irreversibleActions: [actionKind],
  display: { [actionKind]: [{ label: 'Título', path: ['title'] }] },
});
const owner = new OwnerInbox({ databasePath });
try {
  const payload = { title: 'Guía para revisar', revision: 2 };
  const request = system.request({ actionKind, payload, requestedBy: 'kanban:redactor' });
  assert.equal(request.ok, true);
  const use = { requestId: request.requestId, actionKind, payload, by: 'kanban:exportador' };
  assert.equal(system.consume(use).reason, 'not-approved');

  // En una app, esta operación la dispara la persona después de revisar el contenido.
  const { requestId, actionHash } = request;
  assert.equal(owner.approve({ requestId, actionHash, by: 'operador-demo' }).ok, true);
  assert.equal(system.consume({ ...use, payload: { ...payload, revision: 3 } }).reason, 'action-changed');
  assert.equal(system.consume(use).ok, true);
  assert.equal(system.consume(use).reason, 'already-used');
  console.log('Se autorizó la revisión 2 una vez. La revisión 3 y el segundo uso fueron rechazados.');
} finally {
  owner.close();
  system.close();
  rmSync(directory, { recursive: true, force: true });
}
