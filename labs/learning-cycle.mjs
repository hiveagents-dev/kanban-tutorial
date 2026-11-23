import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LEARNING_POLICY, LearningRouter, SqliteLearningStore,
  inputDigest, learningDigest, learningDomainDigest, sealLearningRecord,
} from 'hiveagents-runtime/routing/learning';
import { fixtureDefinition, fixtureRuntime } from './fixtures/learning-cycle-provider.mjs';

const policy = DEFAULT_LEARNING_POLICY;
const timeoutMs = 10_000;
const [moduleCode, adapterCode, fixtureCode] = await Promise.all([
  readFile(new URL(import.meta.url), 'utf8'),
  readFile(new URL('./fixtures/learning-cycle-provider.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./fixtures/learning-cycle-cli.mjs', import.meta.url), 'utf8'),
]);
const domain = {
  id: 'kanban-learning-cycle-v1',
  sourceDigest: learningDigest([moduleCode, adapterCode, fixtureCode]),
  scorerDigest: learningDigest(verify.toString()),
  protocolDigest: learningDigest({ policy, timeoutMs, run: 'fixture-independent-turns-v1' }),
};
const domainId = learningDomainDigest(domain);

function card(id, field, state, priority, title = 'Tarea editorial') {
  const document = 'Tarjeta ' + id + ' ' + title + '\nEstado: ' + state + '\nPrioridad: ' + priority;
  const text = JSON.stringify({ document, field });
  return {
    expected: field === 'Prioridad' ? priority : state,
    task: { id, version: '1', text, inputDigest: inputDigest(text),
      features: { schema: 'campo-v1', values: field === 'Prioridad' ? [1, 0] : [0, 1] } },
  };
}

// Each input has its own identity. The oracle keeps the expected value outside the prompt.
const training = [
  card('a1', 'Prioridad', 'pendiente', 'alta'), card('a2', 'Prioridad', 'en-curso', 'normal'),
  card('a3', 'Prioridad', 'cerrada', 'baja'), card('a4', 'Prioridad', 'en-curso', 'alta'),
  card('a5', 'Prioridad', 'pendiente', 'normal'), card('a6', 'Prioridad', 'revisión', 'alta'),
  card('a7', 'Prioridad', 'cerrada', 'normal'), card('a8', 'Prioridad', 'en-curso', 'baja'),
];
const fixed = [card('f1', 'Estado', 'cerrada', 'alta'), card('f2', 'Prioridad', 'pendiente', 'baja')];
const freshSuites = {
  incompleto: [
    ['Actualizar licencia', 'cerrada', 'alta'], ['Revisar el perfil', 'revisión', 'baja'],
    ['Mover una imagen', 'pendiente', 'alta'], ['Comparar tablas', 'en-curso', 'normal'],
    ['Archivar notas', 'revisión', 'normal'], ['Guardar la minuta', 'cerrada', 'baja'],
  ],
  promocion: [
    ['Preparar la guía de incorporación', 'revisión', 'alta'], ['Corregir enlace del manual', 'pendiente', 'baja'],
    ['Repasar acta de entrega', 'cerrada', 'normal'], ['Chequear la traducción', 'en-curso', 'baja'],
    ['Editar instructivo de cobro', 'cerrada', 'alta'], ['Actualizar el glosario', 'pendiente', 'normal'],
  ],
  rollback: [
    ['Etiquetar el informe semanal', 'en-curso', 'normal'], ['Revisar el itinerario', 'cerrada', 'baja'],
    ['Difundir la agenda', 'pendiente', 'normal'], ['Aprobar una ilustración', 'revisión', 'alta'],
    ['Contar páginas del anexo', 'pendiente', 'baja'], ['Releer preguntas frecuentes', 'cerrada', 'alta'],
  ],
};
function freshFor(stage) {
  return freshSuites[stage].map(([title, state, priority], index) =>
    card(stage + '-' + (index + 1), 'Prioridad', state, priority, title));
}

function verify(turn, expected) {
  const parsed = JSON.parse(turn.text);
  const passed = Object.keys(parsed).length === 1 && parsed.answer === expected;
  return { value: Number(passed), passed };
}

function open(directory) {
  const store = new SqliteLearningStore(join(directory, 'evidence.sqlite'));
  return { store, router: new LearningRouter({ store, domain, policy }) };
}

function launchBudget(maximum) {
  let launches = 0;
  let held = false;
  return {
    acquire(signal) {
      signal.throwIfAborted();
      assert.ok(!held && launches < maximum, 'Fixture launch budget exhausted');
      held = true;
      launches++;
      return { release: () => { held = false; } };
    },
    report: () => ({ launches, held }),
  };
}

async function runCard(study, item, options = {}) {
  return study.router.run(study.definition, {
    runtime: study.runtime,
    task: item.task,
    input: item.task.text,
    budget: study.budget,
    verify: turn => verify(turn, item.expected),
    timeoutMs,
    ...options,
  });
}

async function reserveEpisode(study, id, kind, cases, comparison) {
  const { actions, definitionDigest } = await study.router.preflight(study.definition, {
    runtime: study.runtime, task: cases[0].task, timeoutMs,
  });
  assert.equal(actions.length, 2);
  const tasks = cases.map(({ task }) => ({ taskDigest: task.inputDigest, features: task.features }));
  const cells = tasks.flatMap(({ taskDigest }) => actions.map(({ key }, index) => {
    const suffix = learningDigest({ id, taskDigest, actionKey: key, index });
    return { taskDigest, actionKey: key, repetition: 0, attemptId: 'attempt-' + suffix, observationId: 'result-' + suffix };
  }));
  const episode = sealLearningRecord('episode', {
    format: 1, id, domain: domainId, kind, createdAt: Date.now(), definitionDigest,
    protocolDigest: domain.protocolDigest, afterSequence: await study.store.highWater(domainId),
    arms: actions, tasks, repetitions: 1, cells,
    ...(comparison ? { comparison } : {}),
  });
  await study.store.put('episode', id, episode);
  return episode;
}

async function collect(study, episode, cases) {
  const byDigest = new Map(cases.map(item => [item.task.inputDigest, item]));
  const armByKey = new Map(episode.arms.map(action => [action.key, action.id]));
  for (const cell of episode.cells) {
    await runCard(study, byDigest.get(cell.taskDigest), {
      evaluationArmId: armByKey.get(cell.actionKey), split: episode.kind,
      episodeId: episode.id, repetition: cell.repetition,
      attemptId: cell.attemptId, observationId: cell.observationId,
    });
  }
}

async function compare(study, round, operation, to, { dryFresh = false, fixedEpisode } = {}) {
  const from = await study.router.inspect();
  if (!fixedEpisode) {
    fixedEpisode = await reserveEpisode(study, round + '-fixed', 'fixed', fixed);
    await collect(study, fixedEpisode, fixed);
  }
  const fresh = freshFor(round);
  const episode = await reserveEpisode(study, round + '-fresh', 'fresh', fresh, {
    expectedGeneration: from.generation, from: from.active, to, operation,
    fixedEpisodeId: fixedEpisode.id, config: policy, configDigest: learningDigest(policy),
  });
  if (!dryFresh) await collect(study, episode, fresh);
  const id = round + '-decision';
  const commit = await study.router.improve({ id, freshEpisodeId: episode.id });
  const gate = await study.store.get('gate', id);
  return { commit, gate, fixedEpisode };
}

function inspectAcrossProcess(directory) {
  const stdout = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--inspect', directory], {
    encoding: 'utf8', timeout: timeoutMs,
  });
  const result = JSON.parse(stdout);
  assert.notEqual(result.pid, process.pid);
  return result.pointer;
}

async function run() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kanban-learning-cycle-')));
  let study;
  try {
    await writeFile(join(directory, 'phase.txt'), 'initial');
    // 16 training calls, 16 promotion cells, 1 use per policy and 16 rollback cells.
    const budget = launchBudget(50);
    study = { ...open(directory), runtime: fixtureRuntime(), definition: fixtureDefinition(directory), budget };
    assert.deepEqual({ ...await study.router.inspect() }, { generation: 0, active: null, previous: null });
    const baseline = await runCard(study, training[0]);
    assert.equal(baseline.receipt.reason, 'INCUMBENT');
    assert.equal(baseline.receipt.selected.id, 'base');
    assert.equal(baseline.observation.quality.passed, false);
    for (const item of training) {
      if (item !== training[0]) await runCard(study, item, { evaluationArmId: 'base' });
      await runCard(study, item, { evaluationArmId: 'especialista' });
    }
    const shadow = await study.router.shadow(study.definition, { runtime: study.runtime, task: training[0].task, timeoutMs });
    assert.equal(shadow.rows.length, 16);
    assert.equal((await study.router.inspect()).active, null);

    const incomplete = await compare(study, 'incompleto', 'promote', shadow.digest, { dryFresh: true });
    assert.equal(incomplete.commit.status, 'kept');
    assert.equal(incomplete.gate.reason, 'INCOMPLETE');
    assert.equal(incomplete.commit.after.generation, 0);

    const promoted = await compare(study, 'promocion', 'promote', shadow.digest, { fixedEpisode: incomplete.fixedEpisode });
    assert.equal(promoted.commit.status, 'promoted');
    assert.deepEqual({ ...promoted.commit.after }, { generation: 1, active: shadow.digest, previous: null });
    assert.equal(promoted.gate.fixed.verifiedCells, 4);
    assert.equal(promoted.gate.fresh.verifiedCells, 12);
    assert.equal(promoted.gate.fresh.wins, 6);

    study.store.close();
    study.store = undefined;
    assert.deepEqual(inspectAcrossProcess(directory), { ...promoted.commit.after });
    Object.assign(study, open(directory));
    const learned = await runCard(study, card('produccion-aprendida', 'Prioridad', 'cerrada', 'alta'));
    assert.equal(learned.receipt.reason, 'LEARNED');
    assert.equal(learned.receipt.selected.id, 'especialista');
    assert.equal(learned.observation.quality.passed, true);

    // Only the fixture changes its outcome. The rollback still needs another measured gate.
    await writeFile(join(directory, 'phase.txt'), 'drift');
    const rollback = await compare(study, 'rollback', 'rollback', promoted.commit.after.previous);
    assert.equal(rollback.gate.fresh.wins, 6);
    assert.equal(rollback.gate.fresh.verifiedCells, 12);
    assert.equal(rollback.commit.status, 'rolled-back');
    assert.deepEqual({ ...rollback.commit.after }, { generation: 2, active: null, previous: shadow.digest });
    const restored = await runCard(study, card('produccion-restaurada', 'Prioridad', 'revisión', 'baja'));
    assert.equal(restored.receipt.reason, 'INCUMBENT');
    assert.equal(restored.receipt.selected.id, 'base');
    assert.equal(restored.observation.quality.passed, true);
    assert.deepEqual(await study.store.pending(domainId), []);
    assert.deepEqual(budget.report(), { launches: 50, held: false });
    study.store.close();
    study.store = undefined;
    assert.deepEqual(inspectAcrossProcess(directory), { ...rollback.commit.after });

    const report = {
      baseline: baseline.receipt.selected.id,
      shadowObservations: shadow.rows.length,
      incomplete: { status: incomplete.commit.status, reason: incomplete.gate.reason, generation: incomplete.commit.after.generation },
      promotion: { status: promoted.commit.status, generation: promoted.commit.after.generation, freshWins: promoted.gate.fresh.wins,
        fixedCells: promoted.gate.fixed.verifiedCells, freshCells: promoted.gate.fresh.verifiedCells },
      restartVerified: true,
      learned: learned.receipt.selected.id,
      rollback: { status: rollback.commit.status, generation: rollback.commit.after.generation,
        freshWins: rollback.gate.fresh.wins, restartVerified: true },
      restored: restored.receipt.selected.id,
      fixtureTurns: budget.report().launches,
      commercialTurns: 0,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    study?.store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--inspect') {
  const { router, store } = open(process.argv[3]);
  try { console.log(JSON.stringify({ pid: process.pid, pointer: await router.inspect() })); }
  finally { store.close(); }
} else {
  await run();
}
