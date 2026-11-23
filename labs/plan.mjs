// Desde apps/kanban-desktop: node labs/plan.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyWaves, DependencyCycleError } from 'hiveagents-runtime/orchestration/graph';
import { validatePlan, estimatePlan, runWorkflowPlan, fileDynamicJournal } from 'hiveagents-runtime/orchestration/dynamic';

// La app puede habilitar una tarjeta cuando se completan las tarjetas de las que depende.
const cards = [
  { id: 'guia', dependencies: ['glosario'] },
  { id: 'glosario', draft: 'Reintentar devuelve la tarjeta a Pendientes.' },
];
const waves = dependencyWaves(cards);
assert.deepEqual(waves.map(wave => wave.map(card => card.id)), [['glosario'], ['guia']]);
assert.throws(() => dependencyWaves([cards[0], { ...cards[1], dependencies: ['guia'] }]), DependencyCycleError);
const card = waves[0][0];
console.log('Primera tarjeta habilitada:', card.id);

const limits = { permissions: 'analyze', maxAgents: 2, concurrency: 1 };
const plan = validatePlan({
  format: 1,
  meta: { name: 'Revisión de tarjeta', description: 'Comprobar un término y decidir si el borrador lo incluye.' },
  steps: [
    { id: 'comprobar', kind: 'agent', prompt: 'Revisá el borrador. {{args.borrador}}' },
    { id: 'dictamen', kind: 'agent', prompt: 'Resumí el control anterior. {{steps.comprobar}}' },
  ],
  result: 'dictamen',
}, limits);
const args = { borrador: card.draft };
const estimate = estimatePlan(plan, args, limits);
assert.equal(estimate.agents, 2);
console.log('El plan prevé', estimate.agents, 'llamadas en', estimate.waves, 'etapas.');

// Este runner local hace el chequeo sin CLIs ni credenciales. El motor y el journal son los del SDK.
const calls = [];
const runner = {
  async run({ options, prompt, signal }) {
    signal.throwIfAborted();
    calls.push(options.label);
    if (options.label === 'comprobar') {
      return { text: prompt.includes('Reintentar') ? 'Término presente' : 'Término ausente' };
    }
    return { text: prompt.includes('Término presente') ? 'Control aprobado' : 'Falta el término' };
  },
};

const directory = await mkdtemp(join(tmpdir(), 'hive-plan-'));
try {
  // La misma tarjeta, versión del plan y argumentos identifican esta revisión.
  const options = { runId: 'revision-glosario-v1', runner, limits, args };
  const stop = new AbortController();
  const first = await runWorkflowPlan(plan, {
    ...options, journal: fileDynamicJournal(directory), signal: stop.signal,
    onEvent(event) {
      if (event.type === 'agent.finished' && event.result.label === 'comprobar') stop.abort();
    },
  });
  assert.equal(first.status, 'aborted');
  assert.deepEqual(calls, ['comprobar']);

  const resumed = await runWorkflowPlan(plan, { ...options, journal: fileDynamicJournal(directory) });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.result, 'Control aprobado');
  assert.deepEqual(calls, ['comprobar', 'dictamen']);
  assert.deepEqual(resumed.agents.map(call => [call.label, call.cached]), [['comprobar', true], ['dictamen', false]]);
  console.log('Al reabrir el journal se recuperó «comprobar» y sólo se ejecutó «dictamen».', resumed.result);
} finally {
  await rm(directory, { recursive: true, force: true });
}
