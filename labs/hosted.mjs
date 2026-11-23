// Enviá una revisión al Host que controla los cupos. El Host de este ejemplo vive en memoria.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionRefusedError, Agent } from 'hiveagents-runtime';
import { createHostedRuntime } from 'hiveagents-runtime/hosted';
import { exampleHost } from './fixtures/kanban-host.mjs';

const cwd = await realpath(await mkdtemp(join(tmpdir(), 'kanban-hosted-')));
try {
  const host = await exampleHost(cwd);
  const runtime = createHostedRuntime(host.worker);
  const agent = new Agent({
    model: 'claude/kanban-lab', transport: 'exec', cwd,
    permissions: { mode: 'analyze' }, environment: { mode: 'minimal' },
  }, runtime);
  try {
    const review = await agent.run('# Entrega\n\n## Evidencia\nEl documento fue revisado.');
    assert.equal(review.text, 'Contiene la sección de evidencia.');
    console.log('Revisión del Host simulado:', review.text);

    host.occupySlot(); // Simula otro worker usando el único cupo.
    await assert.rejects(() => agent.run('# Segunda entrega'), error =>
      error instanceof AdmissionRefusedError && error.reason === 'concurrency-limit');
    assert.equal(host.countExecutions(), 1);
    console.log('La segunda solicitud recibió ADMISSION_REFUSED. Entregas procesadas: 1.');
  } finally {
    await agent.close();
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
