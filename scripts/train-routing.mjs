import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Runtime } from 'hiveagents-runtime';
import { DEFAULT_LEARNING_POLICY, learningDigest, sealLearningRecord } from 'hiveagents-runtime/routing/learning';
import { learningTask, openBoardLearning, turnBudget } from '../src/board-learning.mjs';

function caseFor(id, title, table, brief, expectedLines) {
  const card = {
    id, title,
    brief: table + '\n' + brief + ' Entregá un Markdown operativo corto. Usá las etiquetas exactas y poné cada resultado en su propia línea, sin viñetas.',
    requiredTerms: ['Resultado', 'Control'],
  };
  return { data: { card, feedback: '' }, expectedLines };
}

const train = [
  caseFor('train-cuotas', 'Conciliar cupos de revisión',
    'Cada turno activo ocupa un cupo. Tabla: A1 en revisión (2 cupos); A2 terminada (4 cupos); A3 en revisión (3 cupos); A4 pendiente (8 cupos).',
    'Escribí Resultado: <número> con el total activo de revisión y Control: <número> con cuántas filas participan.',
    ['Resultado: 5', 'Control: 2']),
  caseFor('train-reintentos', 'Preparar el parte de reintentos',
    'Sólo se recuperan bloqueadas con menos de tres intentos. A5 bloqueada (2); A6 bloqueada (3); A7 en curso (1); A8 bloqueada (1).',
    'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad> de tarjetas recuperables.',
    ['Resultado: A5, A8', 'Control: 2']),
  caseFor('train-criterios', 'Revisar comprobaciones pendientes',
    'Guía Norte tiene 2 comprobaciones de 4 aprobadas, Guía Sur 3 de 3 y Guía Este 1 de 4.',
    'Escribí Resultado: <cantidad de controles sin aprobación> y Control: <cantidad de guías que los tienen>.',
    ['Resultado: 5', 'Control: 2']),
  caseFor('train-lotes', 'Preparar la lista de lotes elegibles',
    'Se permite si hay entre 2 y 4 tarjetas y ninguna alerta. L1: 2 sin alerta; L2: 5 sin alerta; L3: 3 con alerta; L4: 4 sin alerta.',
    'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad> de lotes elegibles.',
    ['Resultado: L1, L4', 'Control: 2']),
];

// Additional tables vary inputs and decisions independently of the held-out episodes.
for (let fixture = 1; fixture <= 8; fixture++) {
  const first = fixture * 5 + 7;
  const last = fixture * 3 + 4;
  const prefix = 'R' + fixture;
  const left = fixture % 2 === 0 ? 1 : 2;
  const right = 5 - left;
  train.push(
    caseFor('train-cupos-' + fixture, 'Conciliar cupos activos de revisión',
      'Activas: ' + prefix + '1 con ' + first + ' cupos y ' + prefix + '3 con ' + last +
        ' cupos. Terminada: ' + prefix + '2 con 200 cupos. Pendiente: ' + prefix + '4 con 100 cupos.',
      'Escribí Resultado: <cupos activos> y Control: <cantidad de filas activas>.',
      ['Resultado: ' + (first + last), 'Control: 2']),
    caseFor('train-recuperar-' + fixture, 'Preparar el parte de tarjetas para reintentar',
      'Sólo retomá bloqueadas con menos de ' + left + ' intentos. ' + prefix + '1 bloqueada (' + (left - 1) +
        '); ' + prefix + '2 bloqueada (' + right + '); ' + prefix + '3 en revisión (0); ' + prefix + '4 bloqueada (0).',
      'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad de tarjetas recuperables>.',
      ['Resultado: ' + prefix + '1, ' + prefix + '4', 'Control: 2']),
    caseFor('train-pendientes-' + fixture, 'Revisar controles pendientes por guía',
      'Guía ' + prefix + '1 aprobó ' + first + ' de ' + (first + left) +
        '; Guía ' + prefix + '2 aprobó todos los ' + last + '; Guía ' + prefix + '3 aprobó ' + last + ' de ' + (last + right) + '.',
      'Escribí Resultado: <cantidad de controles sin aprobación> y Control: <cantidad de guías con pendientes>.',
      ['Resultado: ' + (left + right), 'Control: 2']),
    caseFor('train-filtro-' + fixture, 'Preparar la lista de lotes elegibles de revisión',
      'Se admite un lote de ' + left + ' a ' + right + ' tarjetas y sin alerta. ' + prefix + '1: ' + left +
        ' y sin alerta; ' + prefix + '2: ' + (right + 1) + ' y sin alerta; ' + prefix + '3: ' + right +
        ' y con alerta; ' + prefix + '4: ' + right + ' y sin alerta.',
      'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad de lotes elegibles>.',
      ['Resultado: ' + prefix + '1, ' + prefix + '4', 'Control: 2']),
  );
}

const fixed = [
  caseFor('fixed-cupos', 'Calcular capacidad de revisión disponible',
    'Hay 40 cupos y sólo los activos se descuentan. R1 activa (7 cupos); R2 terminada (9 cupos); R3 activa (5 cupos).',
    'Escribí Resultado: <cupos disponibles> y Control: <filas activas descontadas>.',
    ['Resultado: 28', 'Control: 2']),
  caseFor('fixed-alertas', 'Conciliar alertas de revisión',
    'Sólo cuentan las alertas críticas en tarjetas bloqueadas. T1 bloqueada y normal; T2 en revisión y crítica; T3 bloqueada y crítica; T4 bloqueada y crítica.',
    'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad de alertas críticas en bloqueadas>.',
    ['Resultado: T3, T4', 'Control: 2']),
];

function freshCases(id) {
  const weight = randomInt(10, 45);
  const checks = randomInt(12, 60);
  const first = randomInt(10, 61);
  const last = first + 17;
  const suffix = id.slice(0, 8).toUpperCase();
  return [
    caseFor('fresh-activos-' + id, 'Conciliar cupos de revisión por turno',
      'Reservas activas ocupan cupos. M1: tres reservas activas de ' + weight + ' cupos cada una; M2: dos finalizadas de 200 cupos; M3: dos activas de 1 cupo.',
      'Escribí Resultado: <cupos activos> y Control: <cantidad de reservas activas>.',
      ['Resultado: ' + (3 * weight + 2), 'Control: 5']),
    caseFor('fresh-lotes-' + id, 'Preparar la lista de lotes elegibles para revisión',
      'Puede procesarse sólo un lote de 2 a 4 tarjetas y sin alerta. ' + suffix + '1: 2 y sin alerta; ' + suffix + '2: 3 y con alerta; ' + suffix + '3: 4 y sin alerta; ' + suffix + '4: 1 y sin alerta.',
      'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad de lotes elegibles>.',
      ['Resultado: ' + suffix + '1, ' + suffix + '3', 'Control: 2']),
    caseFor('fresh-controles-' + id, 'Revisar comprobaciones pendientes por guía',
      'En Guía Mesa faltan 4 controles, en Guía Móvil se aprobaron exactamente todos los ' + checks + ', en Guía Datos faltan 6 y en Guía Flujo falta 1.',
      'Escribí Resultado: <controles pendientes> y Control: <guías con pendientes>.',
      ['Resultado: 11', 'Control: 3']),
    caseFor('fresh-reintentos-' + id, 'Preparar un parte de reintentos con bloqueos',
      'Sólo volvemos a procesar bloqueadas con exactamente dos intentos. ' + suffix + '1 en curso (2); ' + suffix + '2 bloqueada (2); ' + suffix + '3 bloqueada (3); ' + suffix + '4 bloqueada (2).',
      'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad de tarjetas recuperables>.',
      ['Resultado: ' + suffix + '2, ' + suffix + '4', 'Control: 2']),
    caseFor('fresh-capacidad-' + id, 'Conciliar el remanente de revisión al cerrar el lote',
      'Hay ' + last + ' cupos. C1 está activa (consume ' + first + ' cupos), C2 está pendiente (ocuparía 4), C3 está activa (consume 8) y C4 ya está cancelada (ocupaba 1).',
      'Escribí Resultado: <cupos disponibles descontando sólo las activas> y Control: <tarjetas descontadas>.',
      ['Resultado: 9', 'Control: 2']),
    caseFor('fresh-empates-' + id, 'Preparar el parte de alertas antiguas',
      'Una alerta es urgente si una tarjeta está bloqueada durante al menos 14 días. B1 bloqueada hace 13; B2 en revisión hace ' + checks + '; B3 bloqueada hace 14; B4 bloqueada hace ' + last + '.',
      'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad de alertas urgentes>.',
      ['Resultado: B3, B4', 'Control: 2']),
  ];
}

function bindingFor(preflight, example) {
  const { definitionDigest, actions } = preflight;
  const { features } = learningTask(example);
  return { definitionDigest, actions, features: { schema: features.schema, dimensions: features.values.length } };
}

function resultFor(item, arm, result) {
  const { quality, latency } = result.observation;
  return { case: item.data.card.id, model: arm.model, quality, latency, receiptId: result.receipt.id };
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
      results.push(resultFor(item, arm, result));
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
  const results = [];
  for (const cell of await pendingCells(study, episode)) {
    const item = byDigest.get(cell.taskDigest);
    const arm = arms.get(cell.actionKey);
    const result = await study.run(item.data, {
      budget, expectedBinding, evaluationArmId: arm.id,
      split: episode.kind, episodeId: episode.id, repetition: cell.repetition,
      attemptId: cell.attemptId, observationId: cell.observationId,
    }, item.expectedLines);
    results.push(resultFor(item, arm, result));
  }
  return results;
}

function optimisticMinimumTrainingCases(policy) {
  // Even perfect outcomes at cosine/recency 1 must clear the SDK's confidence floor.
  const optimisticThreshold = Math.ceil(Math.log(2 / policy.alpha) / (2 * (1 - policy.qualityFloor) ** 2));
  return Math.max(policy.minDistinctTasks, optimisticThreshold);
}

export async function evaluateWriter(study, preflight, maxTurns) {
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
  const round = randomUUID();
  const fresh = freshCases(round);
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
  const freshEpisode = await reserveEpisode(study, preflight, 'fresh-' + round, 'fresh', fresh, {
    expectedGeneration: incumbent.generation, from: incumbent.active, to: shadow.digest,
    operation: 'promote', fixedEpisodeId: fixedEpisode.id, config: policy, configDigest: learningDigest(policy),
  });
  const fixedResults = await collectEpisode(study, preflight, fixedEpisode, fixed, budget);
  const freshResults = await collectEpisode(study, preflight, freshEpisode, fresh, budget);
  const id = 'decision-' + round;
  const commit = await study.router.improve({ id, freshEpisodeId: freshEpisode.id });
  const gate = await study.store.get('gate', id);
  return {
    status: commit.status, reason: gate.reason, gateId: id,
    corpusDigest: learningDigest({ fixed, fresh }), turns: budget.used(),
    fixed: gate.fixed, fresh: gate.fresh, results: [...fixedResults, ...freshResults],
    shadow: { digest: shadow.digest, rows: shadow.rows.length },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: 'boolean' },
      evaluate: { type: 'boolean' },
      'data-dir': { type: 'string' },
      provider: { type: 'string' },
      'max-turns': { type: 'string' },
    },
  });
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
        fullEvaluationTurns: (fixed.length + DEFAULT_LEARNING_POLICY.minFreshTasks) * preflight.actions.length,
        minimumTrainingCasesPerModel: optimisticMinimumTrainingCases(DEFAULT_LEARNING_POLICY),
      }, null, 2));
      return;
    }
    if (preflight.actions.length !== 2) throw new Error('Se necesitan dos modelos listos y autenticados del perfil para medirlos juntos.');
    const report = values.evaluate
      ? await evaluateWriter(study, preflight, maxTurns)
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
