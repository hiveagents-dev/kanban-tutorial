import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Runtime } from 'hiveagents-runtime';
import { DEFAULT_LEARNING_POLICY, learningDigest, sealLearningRecord } from 'hiveagents-runtime/routing/learning';
import { learningTask, openBoardLearning, turnBudget } from '../src/board-learning.mjs';
import { corpusManifest, fixed, freshCases, train } from './routing-corpus.mjs';

function bindingFor(preflight, example) {
  const { definitionDigest, actions } = preflight;
  const { features } = learningTask(example);
  return { definitionDigest, actions, features: { schema: features.schema, dimensions: features.values.length } };
}

function resultFor(item, arm, { quality, latency, decisionId }, measurement) {
  return { case: item.data.card.id, family: item.family, model: arm.model, quality, latency, receiptId: decisionId, measurement };
}

async function sampleTraining(study, preflight, maxTurns) {
  const { actions } = preflight;
  const observed = await study.store.observations(study.domainId, {
    split: 'train', verifiedOnly: true, actionKeys: actions.map(a => a.key), limit: DEFAULT_LEARNING_POLICY.maxRows,
  });
  const prior = new Set(observed.map(({ observation: row }) => row.taskDigest + ':' + row.action.key));
  const cases = [];
  let planned = 0;
  for (const item of train) {
    const key = learningTask(item.data).inputDigest;
    const remaining = actions.filter(arm => !prior.has(key + ':' + arm.key));
    if (!remaining.length) continue;
    if (planned + remaining.length > maxTurns) break;
    cases.push({ item, remaining });
    planned += remaining.length;
  }
  const budget = turnBudget(maxTurns);
  const expectedBinding = bindingFor(preflight, train[0].data);
  const results = [];
  for (const { item, remaining } of cases) {
    for (const arm of remaining) {
      const result = await study.run(item.data, { budget, evaluationArmId: arm.id, expectedBinding }, item.expectedLines);
      results.push(resultFor(item, arm, result.observation, 'new'));
    }
  }
  return { results, turns: budget.used(), corpusDigest: learningDigest(train) };
}

async function reserveEpisode(study, preflight, id, kind, cases, comparison) {
  const { actions, definitionDigest } = preflight;
  const tasks = cases.map(({ data }) => {
    const task = learningTask(data);
    return { taskDigest: task.inputDigest, features: task.features };
  });
  const cells = tasks.flatMap(({ taskDigest }) => actions.map(({ key }) => {
    const ref = learningDigest({ id, taskDigest, action: key });
    return { taskDigest, actionKey: key, repetition: 0, attemptId: 'attempt-' + ref, observationId: 'result-' + ref };
  }));
  const episode = sealLearningRecord('episode', {
    format: 1, id, domain: study.domainId, kind, createdAt: Date.now(), definitionDigest,
    protocolDigest: study.domain.protocolDigest, afterSequence: await study.store.highWater(study.domainId),
    arms: actions, tasks, repetitions: 1, cells,
    ...(comparison ? { comparison } : {}),
  });
  await study.store.put('episode', id, episode);
  return episode;
}

async function pendingCells(study, episode) {
  const remaining = [];
  for (const cell of episode.cells) {
    const observed = await study.store.get('observation', cell.observationId);
    if (observed?.quality.state === 'verified') continue;
    if (await study.store.get('attempt', cell.attemptId)) {
      throw new Error('Hay una celda reservada sin resultado verificado. Conservá la base para inspeccionarla.');
    }
    remaining.push(cell);
  }
  return remaining;
}

async function collectEpisode(study, preflight, episode, cases, budget) {
  const byDigest = new Map(cases.map(item => [learningTask(item.data).inputDigest, item]));
  const arms = new Map(episode.arms.map(action => [action.key, action]));
  const expectedBinding = bindingFor(preflight, cases[0].data);
  const pending = new Set((await pendingCells(study, episode)).map(cell => cell.observationId));
  const results = [];
  for (const cell of episode.cells) {
    const item = byDigest.get(cell.taskDigest);
    const arm = arms.get(cell.actionKey);
    if (!pending.has(cell.observationId)) {
      const prior = await study.store.get('observation', cell.observationId);
      results.push(resultFor(item, arm, prior, 'reused'));
      continue;
    }
    const result = await study.run(item.data, {
      budget, expectedBinding, evaluationArmId: arm.id,
      split: episode.kind, episodeId: episode.id, repetition: cell.repetition,
      attemptId: cell.attemptId, observationId: cell.observationId,
    }, item.expectedLines);
    results.push(resultFor(item, arm, result.observation, 'new'));
  }
  return results;
}

function optimisticMinimumTrainingCases(policy) {
  // Even perfect outcomes at cosine/recency 1 must clear the SDK's confidence floor.
  const optimisticThreshold = Math.ceil(Math.log(2 / policy.alpha) / (2 * (1 - policy.qualityFloor) ** 2));
  return Math.max(policy.minDistinctTasks, optimisticThreshold);
}

export async function evaluateWriter(study, preflight, maxTurns, seed = randomUUID()) {
  const policy = DEFAULT_LEARNING_POLICY;
  const incumbent = await study.router.inspect();
  const shadow = await study.shadow(train[0].data);
  for (const arm of preflight.actions) {
    const distinct = new Set(shadow.rows
      .filter(({ observation }) => observation.action.key === arm.key && observation.quality.state === 'verified')
      .map(({ observation }) => observation.taskDigest));
    const minimum = optimisticMinimumTrainingCases(policy);
    if (distinct.size < minimum) {
      throw new Error('Cada modelo debe tener al menos ' + minimum + ' casos de entrenamiento verificados antes de evaluar.');
    }
  }
  if (incumbent.active === shadow.digest) throw new Error('La política candidata ya está activa.');
  const fresh = freshCases(seed);
  const round = learningDigest({ domain: study.domainId, seed }).slice(0, 32);
  const freshId = 'fresh-' + round;
  if (await study.store.get('episode', freshId)) {
    throw new Error('Esa semilla ya reservó una evaluación en esta base. Elegí otra semilla para los casos nuevos.');
  }
  const fixedId = 'fixed-' + learningDigest({
    domain: study.domainId, definition: preflight.definitionDigest, arms: preflight.actions.map(a => a.key), fixed,
  }).slice(0, 32);
  const previous = await study.store.get('episode', fixedId);
  const fixedRemaining = previous ? (await pendingCells(study, previous)).length : fixed.length * preflight.actions.length;
  const required = fixedRemaining + fresh.length * preflight.actions.length;
  if (maxTurns < required) {
    throw new Error('La evaluación completa exige ' + required + ' turnos disponibles. No se inició ningún turno de evaluación.');
  }
  const budget = turnBudget(maxTurns);
  const fixedEpisode = previous ?? await reserveEpisode(study, preflight, fixedId, 'fixed', fixed);
  const freshEpisode = await reserveEpisode(study, preflight, freshId, 'fresh', fresh, {
    expectedGeneration: incumbent.generation, from: incumbent.active, to: shadow.digest,
    operation: 'promote', fixedEpisodeId: fixedEpisode.id, config: policy, configDigest: learningDigest(policy),
  });
  const fixedResults = await collectEpisode(study, preflight, fixedEpisode, fixed, budget);
  const freshResults = await collectEpisode(study, preflight, freshEpisode, fresh, budget);
  const id = 'decision-' + round;
  const commit = await study.router.improve({ id, freshEpisodeId: freshEpisode.id });
  const gate = await study.store.get('gate', id);
  const manifest = corpusManifest(seed);
  return {
    status: commit.status, reason: gate.reason, gateId: id,
    corpusDigest: manifest.digest, manifest, turns: budget.used(),
    fixed: gate.fixed, fresh: gate.fresh, results: [...fixedResults, ...freshResults],
    shadow: { digest: shadow.digest, rows: shadow.rows.length },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: 'boolean' },
      evaluate: { type: 'boolean' },
      manifest: { type: 'boolean' },
      seed: { type: 'string' },
      'data-dir': { type: 'string' },
      provider: { type: 'string' },
      'max-turns': { type: 'string' },
    },
  });
  const seed = values.seed ?? randomUUID();
  if (values.manifest) {
    if (values.live || values.evaluate) throw new Error('--manifest sólo genera el inventario del corpus.');
    console.log(JSON.stringify(corpusManifest(seed), null, 2));
    return;
  }
  const maxTurns = Number(values['max-turns']);
  if (!['claude', 'codex'].includes(values.provider) || !isAbsolute(values['data-dir'] ?? '')) {
    throw new Error('Usá --provider claude|codex y --data-dir /ruta/absoluta al directorio de datos del Kanban.');
  }
  if (values.live && (!Number.isSafeInteger(maxTurns) || maxTurns < 2 || maxTurns > 32)) {
    throw new Error('El entrenamiento y la evaluación en vivo requieren --max-turns entre 2 y 32.');
  }
  const path = values['data-dir'];
  const learningDirectory = join(path, 'routing-learning');
  await Promise.all([
    mkdir(join(path, 'agent-workspace'), { recursive: true, mode: 0o700 }),
    mkdir(learningDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const cwd = await realpath(join(path, 'agent-workspace'));
  const { boardRoutingProfiles } = await import('../src/board-routing.mjs');
  const runtime = new Runtime();
  const profile = boardRoutingProfiles(runtime).find(entry => entry.provider === values.provider);
  if (!profile) throw new Error('El proveedor elegido no admite el perfil de escritura del tablero.');
  const study = openBoardLearning({ databasePath: join(learningDirectory, 'evidence.sqlite'), runtime, profile, cwd });
  try {
    const initial = train[0].data;
    const preflight = await study.preflight(initial);
    const before = await study.router.inspect();
    if (!values.live) {
      console.log(JSON.stringify({
        provider: profile.provider, policy: before, candidates: preflight.candidates, turns: 0,
        fullEvaluationTurns: (fixed.length + freshCases(seed).length) * preflight.actions.length,
        minimumTrainingCasesPerModel: optimisticMinimumTrainingCases(DEFAULT_LEARNING_POLICY),
      }, null, 2));
      return;
    }
    if (preflight.actions.length !== 2) throw new Error('Se necesitan dos modelos listos y autenticados del perfil para medirlos juntos.');
    const report = values.evaluate
      ? await evaluateWriter(study, preflight, maxTurns, seed)
      : await sampleTraining(study, preflight, maxTurns);
    const shadow = report.shadow ?? await study.shadow(initial);
    console.log(JSON.stringify({
      provider: profile.provider, policyBefore: before, policyAfter: await study.router.inspect(),
      objective: 'quality', sourceDigest: study.domain.sourceDigest,
      ...report, shadow: { digest: shadow.digest, rows: typeof shadow.rows === 'number' ? shadow.rows : shadow.rows.length },
    }, null, 2));
  } finally {
    study.close();
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
