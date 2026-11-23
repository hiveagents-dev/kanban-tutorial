import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';

const card = (title = 'Guía de acceso') => ({
  title, brief: 'Explicá cómo recuperar el acceso.', requiredTerms: ['PIN'],
});
const defer = () => Promise.withResolvers();
function memoryStore() {
  let value = [];
  return {
    load: () => structuredClone(value),
    save: next => { value = structuredClone(next); },
  };
}
function setup(overrides = {}, store = memoryStore()) {
  const agents = {
    plan: async ({ cards }) => ({ cardId: cards[0].id, reason: 'Tiene una consigna concreta.' }),
    write: async () => ({ markdown: '# Acceso\n\nPedí un pin.\n' }),
    review: async () => ({ approved: true, feedback: 'Cumple con la consigna.' }),
    ...overrides,
  };
  return { board: createBoard({ store, agents }), store, agents };
}

test('el planificador elige tareas reales y drena sólo el lote inicial', async () => {
  const order = [];
  const selections = [];
  const { board } = setup({
    plan: async ({ cards }) => {
      selections.push(cards.map(item => item.title));
      return { cardId: cards.at(-1).id, reason: 'Tiene prioridad editorial.' };
    },
    write: async ({ card: item }) => {
      order.push(item.title);
      if (order.length === 1) board.create(card('Se agregó durante el turno'));
      return { markdown: '# Acceso\n\nPedí un pin.\n' };
    },
  });
  board.create(card('Primera'));
  board.create(card('Segunda'));
  await board.run();
  assert.deepEqual(selections, [['Primera', 'Segunda'], ['Primera']]);
  assert.deepEqual(order, ['Segunda', 'Primera']);
  const [first, second, late] = board.snapshot().cards;
  assert.equal(first.status, 'done');
  assert.equal(second.status, 'done');
  assert.equal(late.status, 'pending');
  assert.equal(first.artifact, '# Acceso\n\nPedí un pin.\n');
  assert.ok(first.checks.every(check => check.passed));
  assert.deepEqual(new Set(first.events.map(event => event.role)),
    new Set(['system', 'planner', 'writer', 'checks', 'reviewer']));
});

test('un lote vacío no consume turnos y un lote grande respeta el límite', async () => {
  let plans = 0;
  const { board } = setup({ plan: async ({ cards }) => {
    plans++;
    assert.ok(cards.length <= 8);
    return { cardId: cards[0].id, reason: 'Primera tarea elegible.' };
  } });
  await board.run();
  assert.equal(plans, 0);
  for (let i = 0; i < 10; i++) board.create(card('Tarea ' + i));
  await board.run();
  assert.equal(plans, 8);
  assert.equal(board.snapshot().cards.filter(item => item.status === 'pending').length, 2);
});

test('un chequeo literal fallido devuelve evidencia y fuerza una corrección', async () => {
  const feedbacks = [];
  let reviews = 0;
  const { board } = setup({
    write: async ({ card: item, feedback }) => {
      feedbacks.push(feedback);
      return { markdown: item.attempts === 1 ? 'Pedí ayuda.' : '  # Manual\nPedí un pin.\n' };
    },
    review: async () => { reviews++; return { approved: true, feedback: 'Está claro.' }; },
  });
  board.create(card());
  await board.run();
  assert.equal(reviews, 1);
  assert.match(feedbacks[1], /PIN/);
  const [result] = board.snapshot().cards;
  assert.equal(result.status, 'done');
  assert.equal(result.attempts, 2);
  assert.equal(result.artifact, '  # Manual\nPedí un pin.\n');
  assert.ok(result.events.some(event => event.role === 'checks' && event.message.includes('PIN')));
});

test('el revisor independiente puede rechazar una entrega que pasa los chequeos', async () => {
  const feedbacks = [];
  let reviews = 0;
  const { board } = setup({
    write: async ({ feedback }) => { feedbacks.push(feedback); return { markdown: 'PIN' }; },
    review: async () => ({ approved: ++reviews === 2, feedback: 'Agregá un ejemplo.' }),
  });
  board.create(card());
  await board.run();
  assert.match(feedbacks[1], /Agregá un ejemplo/);
  assert.equal(board.snapshot().cards[0].status, 'done');
});

test('dos rechazos bloquean la tarjeta y sólo el operador habilita otro ciclo', async () => {
  let writes = 0;
  const { board } = setup({ write: async () => { writes++; return { markdown: '  ' }; } });
  const item = board.create(card());
  await board.run();
  await board.run();
  assert.equal(writes, 2);
  const before = board.snapshot().cards[0];
  assert.equal(before.status, 'blocked');
  assert.equal(before.attempts, 2);
  assert.ok(before.checks.some(check => !check.passed));
  board.retry(item.id);
  const after = board.snapshot().cards[0];
  assert.equal(after.status, 'pending');
  assert.equal(after.attempts, 0);
  assert.ok(after.events.length > before.events.length);
  assert.throws(() => board.retry(item.id));
});

test('una selección ilegítima o un fallo del planificador conserva el lote pendiente', async () => {
  for (const plan of [
    async () => ({ cardId: 'inventada', reason: 'Motivo.' }),
    async () => { throw new Error('credencial-ficticia-de-prueba'); },
  ]) {
    let writes = 0;
    const { board, store } = setup({ plan, write: async () => { writes++; } });
    board.create(card());
    await assert.rejects(board.run(), error => !error.message.includes('credencial-ficticia-de-prueba'));
    assert.equal(writes, 0);
    assert.equal(board.snapshot().active, false);
    assert.equal(store.load()[0].status, 'pending');
    assert.doesNotMatch(JSON.stringify(store.load()), /credencial-ficticia-de-prueba/);
  }
});

test('detener impide aprobar una respuesta tardía y evita despachos duplicados', async () => {
  const started = defer();
  const late = defer();
  let writes = 0;
  let signal;
  const { board } = setup({
    write: async () => { writes++; return { markdown: 'PIN' }; },
    review: async input => { signal = input.signal; started.resolve(); return late.promise; },
  });
  board.create(card());
  board.create(card('Otra tarea'));
  const cycle = board.run();
  await started.promise;
  await assert.rejects(board.run());
  board.stop();
  assert.ok(signal.aborted);
  late.resolve({ approved: true, feedback: 'Tardío.' });
  await cycle;
  const [first, second] = board.snapshot().cards;
  assert.equal(first.status, 'blocked');
  assert.equal(second.status, 'pending');
  assert.equal(writes, 1);
  assert.equal(board.snapshot().active, false);
});

test('detener durante planificación no toca las tarjetas ni consume escritura', async () => {
  const started = defer();
  const late = defer();
  let writes = 0;
  const { board } = setup({
    plan: async () => { started.resolve(); return late.promise; },
    write: async () => { writes++; return { markdown: 'PIN' }; },
  });
  const item = board.create(card());
  const cycle = board.run();
  await started.promise;
  board.stop();
  late.resolve({ cardId: item.id, reason: 'Tarde.' });
  await cycle;
  assert.equal(writes, 0);
  assert.equal(board.snapshot().cards[0].status, 'pending');
});

test('un error de proveedor bloquea el trabajo, detiene el lote y no persiste el stderr', async () => {
  const { board, store } = setup({ write: async () => { throw new Error('valor-del-entorno'); } });
  board.create(card());
  board.create(card('Segunda tarea'));
  await assert.rejects(board.run(), error => !error.message.includes('valor-del-entorno'));
  const [first, second] = store.load();
  assert.equal(first.status, 'blocked');
  assert.equal(second.status, 'pending');
  assert.doesNotMatch(JSON.stringify(first), /valor-del-entorno/);
});

test('reiniciar bloquea una entrega interrumpida y conserva el último borrador', async () => {
  const { board, store, agents } = setup();
  board.create(card());
  const rows = store.load();
  rows[0].status = 'review';
  rows[0].artifact = 'Borrador con PIN';
  store.save(rows);
  const restored = createBoard({ store, agents });
  await restored.run();
  assert.equal(store.load()[0].status, 'blocked');
  assert.equal(store.load()[0].artifact, 'Borrador con PIN');
  assert.equal(restored.snapshot().active, false);
});

test('una falla de persistencia impide despachar efectos sin reclamo durable', async () => {
  let fail = false;
  let writes = 0;
  const db = memoryStore();
  const store = { load: db.load, save: rows => {
    if (fail) throw new Error('ruta-local-confidencial');
    db.save(rows);
  } };
  const { board } = setup({ write: async () => { writes++; return { markdown: 'PIN' }; } }, store);
  board.create(card());
  fail = true;
  await assert.rejects(board.run());
  assert.equal(writes, 0);
  assert.equal(board.snapshot().active, false);
  assert.equal(board.snapshot().cards[0].status, 'pending');
  assert.deepEqual(board.snapshot().cards, db.load());
});

test('validación en la frontera y snapshots sin referencias mutables', () => {
  const { board } = setup();
  for (const fields of [
    { title: ' ' }, { title: 'a'.repeat(121) }, { brief: 'b'.repeat(2001) },
    { requiredTerms: [] }, { requiredTerms: Array(9).fill('xx') },
    { requiredTerms: [1] }, { requiredTerms: ['z'.repeat(81)] },
  ]) assert.throws(() => board.create({ ...card(), ...fields }));
  const draft = card();
  const item = board.create(draft);
  draft.requiredTerms.push('A');
  item.title = 'B';
  board.snapshot().cards[0].events.length = 0;
  assert.equal(board.snapshot().cards[0].title, 'Guía de acceso');
  assert.deepEqual(board.snapshot().cards[0].requiredTerms, ['PIN']);
  assert.ok(board.snapshot().cards[0].events.length);
});

test('cada resultado conserva sólo la evidencia pública del turno correspondiente', async () => {
  const receipt = id => ({ model: 'claude/sonnet', receiptId: id, durationMs: 250, stderr: 'sensible' });
  const { board } = setup({
    plan: async ({ cards }) => ({ cardId: cards[0].id, reason: 'Urgente.', execution: receipt('plan-1') }),
    write: async () => ({ markdown: 'PIN', execution: receipt('write-1') }),
    review: async () => ({ approved: true, feedback: 'Cumple.', execution: receipt('review-1') }),
  });
  board.create(card());
  await board.run();
  const events = board.snapshot().cards[0].events.filter(item => item.execution);
  assert.deepEqual(events.map(({ role, execution }) => [role, execution.receiptId]),
    [['planner', 'plan-1'], ['writer', 'write-1'], ['reviewer', 'review-1']]);
  assert.ok(events.every(item => Object.keys(item.execution).sort().join() === 'durationMs,model,receiptId'));
  assert.doesNotMatch(JSON.stringify(events), /sensible/);
});

test('una referencia de ejecución inválida no certifica la entrega', async () => {
  const { board } = setup({
    review: async () => ({
      approved: true, feedback: 'Cumple.',
      execution: { model: 'claude/sonnet', receiptId: '../../archivo', durationMs: -5 },
    }),
  });
  board.create(card());
  await assert.rejects(board.run());
  assert.equal(board.snapshot().cards[0].status, 'blocked');
});

test('mientras un agente ignora la cancelación la tarjeta ya muestra la detención', async () => {
  const started = defer();
  const late = defer();
  const { board } = setup({ write: async () => { started.resolve(); return late.promise; } });
  const item = board.create(card());
  const cycle = board.run();
  await started.promise;
  board.stop();
  const [stopped] = board.snapshot().cards;
  assert.equal(stopped.status, 'blocked');
  assert.equal(board.snapshot().active, true);
  assert.throws(() => board.retry(item.id));
  board.stop();
  late.resolve({ markdown: 'PIN' });
  await cycle;
  assert.deepEqual(board.snapshot().cards[0].events, stopped.events);
});

test('si el disco falla después del turno se conserva el reclamo y se recupera al volver', async () => {
  const db = memoryStore();
  let writable = true;
  let reviews = 0;
  const store = { load: db.load, save: rows => {
    if (!writable) throw new Error('disco');
    db.save(rows);
  } };
  const { board } = setup({
    write: async () => { writable = false; return { markdown: 'PIN' }; },
    review: async () => { reviews++; },
  }, store);
  board.create(card());
  await assert.rejects(board.run());
  assert.equal(reviews, 0);
  assert.equal(db.load()[0].status, 'working');
  assert.deepEqual(board.snapshot().cards, db.load());
  writable = true;
  await board.run();
  assert.equal(db.load()[0].status, 'blocked');
});

test('un borrador inicial aprobado conserva el original exacto y no se atribuye al redactor', async () => {
  const original = '  # Guía\n\nPedí tu PIN.\n';
  const { board } = setup({
    write: async () => assert.fail('No había que escribir'),
    review: async ({ markdown, checks }) => {
      assert.equal(markdown, original);
      assert.ok(checks.every(check => check.passed));
      return { approved: true, feedback: 'La guía está lista.' };
    },
  });
  const created = board.create({ ...card(), initialDraft: original });
  assert.equal(created.initialDraft, original);
  assert.equal(created.artifact, original);
  await board.run();
  const [result] = board.snapshot().cards;
  assert.equal(result.status, 'done');
  assert.equal(result.attempts, 1);
  assert.equal(result.artifact, original);
  assert.ok(!result.events.some(item => item.role === 'writer'));
});

test('el revisor rechaza el error semántico de un borrador y verifica la corrección real', async () => {
  const original = 'Compartí tu PIN con cualquiera.\n';
  const fixed = 'Mantené tu PIN en secreto.\n';
  const feedback = 'Corregí la indicación de compartir el PIN.';
  const reviewed = [];
  const { board } = setup({
    review: async ({ markdown, checks }) => {
      assert.ok(checks.every(check => check.passed));
      reviewed.push(markdown);
      return { approved: markdown === fixed, feedback };
    },
    write: async ({ card: item, feedback: request }) => {
      assert.equal(item.artifact, original);
      assert.equal(request, feedback);
      assert.equal(item.attempts, 2);
      return { markdown: fixed };
    },
  });
  board.create({ ...card(), initialDraft: original });
  await board.run();
  const [result] = board.snapshot().cards;
  assert.deepEqual(reviewed, [original, fixed]);
  assert.equal(result.initialDraft, original);
  assert.equal(result.artifact, fixed);
  assert.equal(result.status, 'done');
  assert.equal(result.attempts, 2);
});

test('el borrador opcional admite hasta 8000 caracteres exactos y conserva tarjetas anteriores', async () => {
  const { board, store, agents } = setup();
  const raw = 'a'.repeat(7999) + '\n';
  assert.equal(board.create({ ...card(), initialDraft: raw }).initialDraft, raw);
  for (const value of [raw + 'x', null, 0, {}]) {
    assert.throws(() => board.create({ ...card(), initialDraft: value }));
  }
  const blank = board.create({ ...card(), initialDraft: '  \n' });
  assert.equal(blank.initialDraft, undefined);
  assert.equal(blank.artifact, '');
  store.save([blank]);
  const restarted = createBoard({ store, agents });
  await restarted.run();
  assert.equal(restarted.snapshot().cards[0].status, 'done');
});

test('un reintento manual corrige el último borrador sin volver a evaluar el inicial rechazado', async () => {
  const original = 'Este texto no incluye el término.';
  const intermediate = 'Pedí el PIN.';
  const corrected = 'Pedí el PIN desde la aplicación.';
  const reviewed = [];
  const revisionInputs = [];
  const { board } = setup({
    write: async ({ card: item, feedback }) => {
      revisionInputs.push({ previous: item.artifact, feedback });
      return { markdown: revisionInputs.length === 1 ? intermediate : corrected };
    },
    review: async ({ markdown }) => {
      reviewed.push(markdown);
      return { approved: markdown === corrected, feedback: 'Aclarar dónde.' };
    },
  });
  const item = board.create({ ...card(), initialDraft: original });
  await board.run();
  assert.equal(board.snapshot().cards[0].status, 'blocked');
  board.retry(item.id);
  await board.run();
  const [result] = board.snapshot().cards;
  assert.deepEqual(reviewed, [intermediate, corrected]);
  assert.deepEqual(revisionInputs.map(entry => entry.previous), [original, intermediate]);
  assert.match(revisionInputs[0].feedback, /PIN/);
  assert.match(revisionInputs[1].feedback, /Aclarar dónde/);
  assert.equal(result.initialDraft, original);
  assert.equal(result.artifact, corrected);
  assert.equal(result.attempts, 1);
  assert.equal(result.status, 'done');
});

test('un operador puede reabrir la evaluación del borrador si el primer revisor nunca respondió', async () => {
  let calls = 0;
  const original = 'Pedí el PIN.';
  const { board } = setup({
    write: async () => assert.fail('Nadie pidió cambios todavía.'),
    review: async ({ markdown }) => {
      assert.equal(markdown, original);
      if (++calls === 1) throw new Error('CLI interrumpido');
      return { approved: true, feedback: 'Está listo.' };
    },
  });
  const item = board.create({ ...card(), initialDraft: original });
  await assert.rejects(board.run());
  board.retry(item.id);
  await board.run();
  assert.equal(board.snapshot().cards[0].status, 'done');
  assert.equal(calls, 2);
});

test('un error al guardar un recibo indica almacenamiento sin exponer rutas locales', async () => {
  const board = createBoard({
    store: { load: () => [], save() {} },
    agents: { plan() { throw Object.assign(new Error('/private/user/receipts'), { code: 'ENOSPC' }); } },
  });
  board.create({ title: 'Ayuda', brief: 'Escribir una guía', requiredTerms: ['Prueba'] });
  await assert.rejects(board.run(), error => error.message.includes('almacenamiento') && !error.message.includes('/private'));
  assert.equal(board.snapshot().cards[0].status, 'pending');
});

test('el historial muestra la causa tipada sin guardar la respuesta del CLI', async () => {
  const { board } = setup({ write: async () => {
    throw Object.assign(new Error('salida privada'), { code: 'STRUCTURED_OUTPUT_ERROR' });
  } });
  board.create(card());
  await assert.rejects(board.run(), /esquema requerido/);
  const message = board.snapshot().cards[0].events.at(-1).message;
  assert.match(message, /esquema requerido/);
  assert.doesNotMatch(message, /salida privada/);
});
