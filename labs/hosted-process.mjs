// El Host conserva el ejecutable, la política y los cupos. Los workers viven en procesos Node separados.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalHost } from './fixtures/hosted-local-host.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'hive-hosted-process-')));
const firstOutput = Promise.withResolvers();
const releaseResult = Promise.withResolvers();
let host;

try {
  const allowedPath = join(root, 'allowed');
  const outsidePath = join(root, 'outside');
  await Promise.all([mkdir(allowedPath), mkdir(outsidePath)]);
  host = await openLocalHost({
    directory: root, cwd: allowedPath,
    // El primer CLI ya emitió texto. Demoramos la entrega al worker para observar el cupo ocupado.
    async onFirstOutput() {
      firstOutput.resolve();
      await releaseResult.promise;
    },
  });
  const first = host.runWorker({ kind: 'review', markdown: '# Tarea\n\n## Evidencia\nRevisada.' });
  const deadline = AbortSignal.timeout(5_000);
  const firstStarted = Promise.race([
    firstOutput.promise,
    first.then(result => { throw new Error('El primer worker salió antes de emitir texto', { cause: result }); }),
    new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('El primer CLI no emitió texto')), { once: true })),
  ]);
  await firstStarted;
  assert.deepEqual(host.status(), { dispatches: 1, capacityRefusals: 0, scopeRefusals: 0, active: 1 });

  const denied = await host.runWorker({ kind: 'review', markdown: '# Segunda tarea' });
  assert.equal(denied.status, 'ADMISSION_REFUSED');
  assert.equal(denied.reason, 'concurrency-limit');
  assert.match(denied.receiptDigest, /^[a-f0-9]{64}$/u);
  assert.equal(host.status().dispatches, 1);
  console.log('Segundo worker rechazado por cupo. Despachos al CLI: 1.');

  releaseResult.resolve();
  assert.deepEqual(await first, { status: 'completed', text: 'Contiene la sección de evidencia.' });
  assert.equal(host.status().active, 0);
  console.log('Primer worker completado. Cupos activos: 0.');

  const outside = await host.runWorker({ kind: 'check-host-scope', cwd: outsidePath });
  assert.equal(outside.status, 'EXECUTION_HALTED');
  assert.equal(host.status().dispatches, 1);
  console.log('Directorio fuera de la receta rechazado antes del despacho.');

  const retry = await host.runWorker({ kind: 'review', markdown: '# Segunda tarea' });
  assert.deepEqual(retry, { status: 'completed', text: 'Falta la sección de evidencia.' });
  assert.deepEqual(host.status(), { dispatches: 2, scopeRefusals: 1, capacityRefusals: 1, active: 0 });
  console.log('Nuevo worker admitido. Despachos al CLI: 2. Cupos activos: 0.');
} finally {
  releaseResult.resolve();
  await host?.close();
  await rm(root, { recursive: true, force: true });
}
