// Dos clientes de la misma base comparten el cupo de un proveedor.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostLedger } from 'hiveagents-runtime/orchestration';

const directory = mkdtempSync(join(tmpdir(), 'kanban-cupos-'));
const options = { databasePath: join(directory, 'cupos.sqlite'), concurrency: { mode: 'limited', maxConcurrent: 1 } };
const writer = new HostLedger(options);
const reviewer = new HostLedger(options);
try {
  const writing = writer.reserve('claude', 'tarjeta-redactor');
  assert.equal(writing.allowed, true);
  try {
    const waiting = reviewer.reserve('claude', 'tarjeta-revisor');
    assert.equal(waiting.allowed, false);
    assert.equal(waiting.reason, 'concurrency-limit');
    console.log('El redactor ocupa el cupo. El revisor recibió:', waiting.reason);
  } finally {
    assert.equal(writer.release(writing.reservation.token).ok, true);
  }
  const reviewing = reviewer.reserve('claude', 'tarjeta-revisor');
  assert.equal(reviewing.allowed, true);
  try {
    assert.equal(reviewer.status('claude').status.active, 1);
  } finally {
    reviewer.release(reviewing.reservation.token);
  }
  assert.equal(writer.status('claude').status.active, 0);
  console.log('El revisor obtuvo el cupo liberado. Cupos activos al terminar: 0.');
} finally {
  reviewer.close();
  writer.close();
  rmSync(directory, { recursive: true, force: true });
}
