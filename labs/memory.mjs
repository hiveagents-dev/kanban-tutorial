// Desde apps/kanban-desktop: node labs/memory.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSystemMemory, measureMemory } from 'hiveagents-runtime/orchestration';
import { memoryProviderFromPorts } from 'hiveagents-runtime/orchestration/memory';
import { memoryTools } from 'hiveagents-runtime/memory-tools';

const directory = await mkdtemp(join(tmpdir(), 'hive-memory-'));
const scope = { tenant: 'editorial', namespace: 'kanban', subject: 'tarjeta-pagos' };
const store = new SqliteSystemMemory({ systemId: scope.tenant, databasePath: join(directory, 'memory.sqlite') });
try {
  await store.enable({ by: 'taller' });
  const provider = memoryProviderFromPorts({ recall: store, persistence: store, captureGate: 'store-promotes' });
  const tools = memoryTools({ provider, scope, cwd: directory, propose: true });
  const search = tools.find(tool => tool.name === 'memory_search');
  const propose = tools.find(tool => tool.name === 'memory_propose');

  // El laboratorio invoca los callbacks en proceso con contexto de Control simulado.
  // En una app con Control registrado, el transporte aporta este contexto y comprueba authorize.
  const context = {
    scope: { provider: 'codex', transport: 'control', cwd: directory, sessionId: 'taller', authorityEpoch: 'local' },
    deadline: Date.now() + 30_000,
    signal: new AbortController().signal,
  };
  async function invoke(tool, input) {
    assert.equal(await tool.authorize(input, context), true);
    return tool.execute(input, context);
  }

  const note = 'Pagos solicita que la guía use el término «liquidación semanal».';
  const query = { query: 'liquidación semanal' };
  const candidate = await invoke(propose, { title: 'Vocabulario de Pagos', text: note });
  assert.equal(candidate.status, 'candidate');
  assert.deepEqual((await invoke(search, query)).items, []);
  console.log('La propuesta quedó guardada. La búsqueda todavía devuelve 0 lecciones.');

  // Una prueba léxica reproducible mide esta propuesta con y sin memoria y con todo el historial.
  const [episode] = await store.list({ scope });
  assert.equal(episode.record.id, candidate.id);
  const report = await measureMemory({
    id: 'vocabulario-pagos', tasks: [{ id: 'termino', input: 'liquidación semanal' }],
    candidateDigests: [episode.contentDigest],
    recall: () => [episode.record.text],
    history: () => ['La guía tiene una sección de contacto.', note],
    run: (task, { context: entries }) => ({ passed: entries.some(entry => entry.includes(task.input)) }),
  });
  assert.equal(report.verdict.passed, true);
  const approval = await store.promote({ scope, id: candidate.id, gate: report.gate, by: 'editor' });
  assert.equal(approval.promoted, true);
  assert.deepEqual((await invoke(search, query)).items.map(item => item.text), [note]);
  console.log('La propuesta superó el control léxico y el editor la promovió. La tarjeta puede recuperarla.');

  const other = { ...scope, subject: 'tarjeta-envios' };
  const [otherSearch] = memoryTools({ provider, scope: other, cwd: directory });
  assert.deepEqual((await invoke(otherSearch, query)).items, []);
  assert.equal(await search.authorize({ ...query, scope: other }, context), false);

  await store.rollback({ scope, id: candidate.id, by: 'editor', reason: 'Terminó la vigencia del término.' });
  assert.deepEqual((await invoke(search, query)).items, []);
  console.log('La otra tarjeta tenía 0 resultados. Tras revertir la promoción, ambas tienen 0.');
} finally {
  store.close();
  await rm(directory, { recursive: true, force: true });
}
