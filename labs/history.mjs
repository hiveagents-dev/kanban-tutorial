// Guardá el estado durable de una tarjeta separadamente de su documento y volvé a abrirlo.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogExecutionDatabase, createRunHistory } from 'hiveagents-runtime/orchestration/log';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = await mkdtemp(join(tmpdir(), 'kanban-history-'));
const config = { databasePath: join(directory, 'history.sqlite'), systemId: 'kanban' };
const identity = { systemId: config.systemId, generation: 1, runId: 'guia', agentId: 'redactor',
  harness: { id: 'tutorial', version: '1', digest: digest(await readFile(new URL(import.meta.url))) } };
const inputDigest = digest('Explicá qué guarda una tarjeta terminada.');
const start = { requestId: 'encargar-guia', identity, inputDigest };
const draftPath = join(directory, 'guia.md');

let database;
try {
  database = new LogExecutionDatabase(config);
  const history = createRunHistory({ database });
  const accepted = await history.begin(start);
  assert.equal(accepted.kind, 'started');
  const document = '# Tarjeta terminada\n\nConserva la entrega y los resultados de la revisión.\n';
  await writeFile(draftPath, document);
  await history.complete(accepted.run, { requestId: 'aprobar-guia', outputDigest: digest(document) });

  // Otra tarjeta se interrumpe antes de que el productor confirme qué ocurrió.
  const pending = { ...start, requestId: 'encargar-glosario', identity: { ...identity, runId: 'glosario' } };
  await history.begin(pending);
  database.close();
  database = new LogExecutionDatabase(config);
  const reopened = createRunHistory({ database });

  const completed = await reopened.recover(identity);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outputDigest, digest(await readFile(draftPath)));
  const repeated = await reopened.begin({ ...pending, requestId: 'inspeccionar-glosario' });
  assert.equal(repeated.kind, 'existing');
  assert.equal(repeated.record.status, 'unknown');
  assert.ok(!Object.hasOwn(repeated, 'run'));
  console.table((await reopened.list({ generation: 1 })).map(record => ({
    tarjeta: record.identity.runId, estado: record.status,
  })));
  console.log('La huella de la guía coincide. El glosario requiere reconciliación antes de repetir trabajo.');
} finally {
  database?.close();
  await rm(directory, { recursive: true, force: true });
}
