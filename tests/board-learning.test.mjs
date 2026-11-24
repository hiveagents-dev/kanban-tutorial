import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Runtime } from 'hiveagents-runtime';
import { fixtureRuntime } from '../labs/fixtures/learning-cycle-provider.mjs';
import { evaluateWriter } from '../scripts/train-routing.mjs';
import { createBoardLearning, learningTask, openBoardLearning, turnBudget } from '../src/board-learning.mjs';

const fixtureProvider = 'kanban-fixture';
const task = {
  card: { id: 'a1', title: 'Conciliar cupos', brief: 'Calculá la suma de 3 y 4.', requiredTerms: ['Resultado'] },
  feedback: '',
};

async function harness(t, output) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kanban-writer-learning-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = fixtureRuntime().registration(fixtureProvider);
  let launches = 0;
  function adapter(source) {
    return {
      ...source,
      async auth() {
        return { authenticated: true, state: 'authenticated', source: 'subscription' };
      },
      async execute(request) {
        launches++;
        const text = output(request.modelId, JSON.parse(request.prompt));
        return {
          completed: true, failed: false, refused: false, sessionId: 'kanban-learning-fixture',
          text, events: [], nativeEvents: [],
        };
      },
    };
  }
  const runtime = new Runtime({ providers: [{
    ...original,
    exec: {
      ...original.exec,
      adapter: adapter(original.exec.adapter),
      withTarget: target => adapter(original.exec.withTarget(target)),
    },
  }] });
  const profile = {
    provider: fixtureProvider,
    options: { permissions: { mode: 'analyze' } },
    candidates: original.modelCatalog.map(model => fixtureProvider + '/' + model.id),
  };
  const args = { databasePath: join(directory, 'evidence.sqlite'), runtime, profile, cwd: directory };
  return { open: () => openBoardLearning(args), launches: () => launches };
}

test('el router mide dos modelos del catálogo con comprobaciones externas y conserva el incumbente', async t => {
  const fixture = await harness(t, (model, { card }) => {
    assert.equal(card.brief, task.card.brief);
    assert.equal(card.expectedLines, undefined);
    return JSON.stringify({ markdown: model === 'base' ? 'Resultado: 70' : 'Resultado: 7' });
  });
  const study = fixture.open();
  let domain;
  try {
    const { actions } = await study.preflight(task);
    assert.equal(fixture.launches(), 0);
    assert.deepEqual(actions.map(arm => arm.model), ['kanban-fixture/base', 'kanban-fixture/especialista']);
    const budget = turnBudget(2);
    const outcomes = [];
    for (const arm of actions) {
      const result = await study.run(task, { evaluationArmId: arm.id, budget }, ['Resultado: 7']);
      outcomes.push(result.observation.quality.passed);
    }
    assert.deepEqual(outcomes, [false, true]);
    assert.equal(budget.used(), 2);
    assert.equal(fixture.launches(), 2);
    const shadow = await study.shadow(task);
    assert.equal(shadow.rows.length, 2);
    assert.equal((await study.router.inspect()).active, null);
    domain = study.domainId;
  } finally {
    study.close();
  }
  const restored = fixture.open();
  try {
    const observed = await restored.store.observations(domain, { split: 'train', limit: 10 });
    assert.equal(observed.length, 2);
    assert.ok(!JSON.stringify(observed).includes(task.card.brief));
    assert.equal((await restored.router.inspect()).generation, 0);
  } finally {
    restored.close();
  }
});

test('un texto con cercas o propiedades adicionales cuenta como fallo aunque incluya los términos', async t => {
  const fixture = await harness(t, model => model === 'base'
    ? '```json\n{"markdown":"Resultado: 7"}\n```'
    : '{"markdown":"Resultado: 7","approved":true}');
  const study = fixture.open();
  try {
    const { actions } = await study.preflight(task);
    for (const arm of actions) {
      const result = await study.run(task, { evaluationArmId: arm.id }, ['Resultado: 7']);
      assert.deepEqual({ ...result.observation.quality }, { state: 'verified', value: 0, passed: false });
    }
  } finally {
    study.close();
  }
});

test('la memoria y el feedback cambian la entrada medida sin cambiar las features por consigna', () => {
  const first = learningTask(task);
  const second = learningTask({ ...task, feedback: 'Incluí el control de cupos.' });
  assert.notEqual(first.inputDigest, second.inputDigest);
  assert.deepEqual(first.features, second.features);
});

test('el modo aprendido sólo toma turnos del redactor en el perfil habilitado', async () => {
  const learning = createBoardLearning({ provider: 'claude' });
  assert.equal(await learning.write({ role: 'plan' }), undefined);
  assert.equal(await learning.write({ role: 'write', profile: { provider: 'codex' } }), undefined);
  assert.equal(await learning.write({ role: 'write', profile: { provider: 'claude', explicit: true } }), undefined);
});

test('el presupuesto admite un trabajo por vez y exige cancelación antes de reservar', () => {
  const budget = turnBudget(1);
  const controller = new AbortController();
  const held = budget.acquire(controller.signal);
  assert.throws(() => budget.acquire(controller.signal), /presupuesto/);
  held.release();
  assert.throws(() => budget.acquire(controller.signal), /presupuesto/);
  controller.abort();
  assert.throws(() => budget.acquire(controller.signal), { name: 'AbortError' });
  assert.equal(budget.used(), 1);
});


test('la evaluación reserva 2 casos fijos y 6 nuevos y conserva la política en empate', async t => {
  const fixture = await harness(t, () => JSON.stringify({ markdown: 'Resultado: no comprobado\nControl: no comprobado' }));
  const study = fixture.open();
  try {
    const preflight = await study.preflight(task);
    await assert.rejects(evaluateWriter(study, preflight, 16), /8 casos de entrenamiento/);
    assert.equal(fixture.launches(), 0);
    for (let index = 0; index < 8; index++) {
      const item = { ...task, card: { ...task.card, id: 'train-' + index, brief: task.card.brief + ' ' + index } };
      for (const arm of preflight.actions) await study.run(item, { evaluationArmId: arm.id }, ['Resultado: 1']);
    }
    assert.equal(fixture.launches(), 16);
    await assert.rejects(evaluateWriter(study, preflight, 15), /16 turnos/);
    assert.equal(fixture.launches(), 16);
    const evaluation = await evaluateWriter(study, preflight, 16);
    assert.equal(evaluation.status, 'kept');
    assert.equal(evaluation.turns, 16);
    assert.equal(evaluation.shadow.rows, 16);
    assert.equal(evaluation.fixed.verifiedCells, 4);
    assert.equal(evaluation.fresh.verifiedCells, 12);
    assert.equal((await study.router.inspect()).active, null);
    assert.equal(fixture.launches(), 32);
  } finally {
    study.close();
  }
});
