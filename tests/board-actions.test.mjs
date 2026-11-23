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
function setup(overrides = {}, store = memoryStore(), onChange) {
  const agents = {
    plan: async ({ cards }) => ({ cardId: cards[0].id, reason: 'Tiene una consigna concreta.' }),
    write: async () => ({ markdown: '# Acceso\n\nPedí un pin.\n' }),
    review: async () => ({ approved: true, feedback: 'Cumple con la consigna.' }),
    ...overrides,
  };
  return { board: createBoard({ store, agents, onChange }), store, agents };
}

test('editar conserva la identidad y valida el encargo completo antes de guardarlo', () => {
  const { board, store } = setup();
  const item = board.create(card());
  assert.throws(() => board.edit(item.id, { ...card(), requiredTerms: [] }), /entre 1 y 8/);
  assert.throws(() => board.edit(item.id, { ...card(), requiredTerms: Array(1) }), /Cada término/);
  assert.deepEqual(store.load(), [item]);
  assert.throws(() => board.edit('desconocida', card()), /tarjeta pendiente/);

  const original = '  Cambiá tu PIN.\n';
  const edited = board.edit(item.id, { ...card('  Nuevo título  '), initialDraft: original });
  assert.equal(edited.id, item.id);
  assert.equal(edited.title, 'Nuevo título');
  assert.equal(edited.initialDraft, original);
  assert.equal(edited.artifact, original);
  assert.equal(edited.initialDraftEvaluated, false);
  assert.deepEqual(edited.events.slice(0, -1), item.events);
  assert.match(edited.events.at(-1).message, /editó/);
  assert.deepEqual(store.load(), [edited]);

  const reset = board.edit(item.id, card());
  assert.equal(reset.artifact, '');
  assert.ok(!Object.hasOwn(reset, 'initialDraft'));
  assert.ok(!Object.hasOwn(reset, 'initialDraftEvaluated'));
  assert.deepEqual(store.load(), [reset]);
});

test('editar está reservado a pendientes sin una asignación previa y con el ciclo inactivo', async () => {
  const started = defer();
  const late = defer();
  const { board } = setup({
    plan: async ({ cards }) => {
      started.resolve();
      await late.promise;
      return { cardId: cards[0].id, reason: 'Primera tarea elegible.' };
    },
    review: async () => ({ approved: false, feedback: 'Necesita un ejemplo.' }),
  });
  const item = board.create(card());
  const other = board.create(card('Otra tarea'));
  const cycle = board.run(item.id);
  await started.promise;
  assert.throws(() => board.edit(other.id, card()), /ciclo activo/);
  late.resolve();
  await cycle;
  const [blocked] = board.snapshot().cards;
  assert.equal(blocked.status, 'blocked');
  assert.throws(() => board.edit(item.id, card()), /tarjeta pendiente/);
  board.retry(item.id);
  assert.throws(() => board.edit(item.id, card()), /Duplicá/);
  assert.deepEqual(board.snapshot().cards[0].events.slice(0, -1), blocked.events);
  assert.doesNotThrow(() => board.edit(other.id, card('Otra tarea editada')));
});

test('ejecutar una tarjeta usa el planificador con ella como única opción', async () => {
  const selections = [];
  const { board } = setup({
    plan: async ({ cards }) => {
      selections.push(cards.map(item => item.id));
      return { cardId: cards[0].id, reason: 'Selección de la persona usuaria.' };
    },
  });
  const first = board.create(card());
  const selected = board.create(card('Elegida'));
  for (const id of ['desconocida', null, 0, '']) await assert.rejects(board.run(id), /tarjeta pendiente/);
  assert.deepEqual(selections, []);
  await board.run(selected.id);
  const [pending, done] = board.snapshot().cards;
  assert.deepEqual(selections, [[selected.id]]);
  assert.equal(pending.id, first.id);
  assert.equal(pending.status, 'pending');
  assert.equal(done.status, 'done');
  await assert.rejects(board.run(selected.id), /tarjeta pendiente/);
});

test('el ciclo informa fase, tarjeta y avance durante planificación, escritura y revisión', async () => {
  const started = Array.from({ length: 4 }, defer);
  const gates = Array.from({ length: 4 }, defer);
  const notices = [];
  let plan = 0;
  const { board } = setup({
    plan: async ({ cards }) => {
      const step = plan++ === 0 ? 0 : 3;
      started[step].resolve();
      await gates[step].promise;
      return { cardId: cards[0].id, reason: 'Primera tarea elegible.' };
    },
    write: async () => {
      started[1].resolve();
      await gates[1].promise;
      return { markdown: 'PIN' };
    },
    review: async () => {
      started[2].resolve();
      await gates[2].promise;
      return { approved: true, feedback: 'Está claro.' };
    },
  }, undefined, () => notices.push(board.snapshot().cycle));
  const first = board.create(card());
  const next = board.create(card('Otra tarea'));
  assert.equal(board.snapshot().cycle, null);
  const running = board.run();
  const assertPhase = async (step, phase, cardId, processed = 0) => {
    await started[step].promise;
    const snapshot = board.snapshot();
    assert.equal(snapshot.active, true);
    assert.deepEqual(snapshot.cycle, { phase, cardId, processed, total: 2, startedAt });
    gates[step].resolve();
  };
  const { startedAt } = board.snapshot().cycle;
  assert.equal(new Date(startedAt).toISOString(), startedAt);
  await assertPhase(0, 'planning', null);
  await assertPhase(1, 'writing', first.id);
  await assertPhase(2, 'reviewing', first.id);
  await started[3].promise;
  assert.equal(board.snapshot().cycle.processed, 1);
  assert.equal(board.snapshot().cycle.phase, 'planning');
  board.stop();
  assert.equal(board.snapshot().cycle.phase, 'stopping');
  assert.equal(notices.at(-1).phase, 'stopping');
  gates[3].resolve();
  await running;
  assert.equal(board.snapshot().cycle, null);
  assert.equal(board.snapshot().cards.find(item => item.id === next.id).status, 'pending');
});

test('detener una tarjeta asignada aumenta el avance sólo al guardar el bloqueo', async () => {
  const started = defer();
  const late = defer();
  const notices = [];
  const db = memoryStore();
  const { board } = setup({
    write: async () => { started.resolve(); return late.promise; },
  }, db, () => {
    const { cycle } = board.snapshot();
    if (cycle?.phase === 'stopping') notices.push([cycle.cardId, cycle.processed, db.load()[0].status]);
  });
  const selected = board.create(card());
  const unchanged = board.create(card('Otra tarea'));
  const running = board.run(selected.id);
  await started.promise;
  board.stop();
  const { cycle } = board.snapshot();
  assert.equal(cycle.total, 1);
  assert.deepEqual(notices, [
    [selected.id, 0, 'working'],
    [selected.id, 1, 'blocked'],
  ]);
  late.resolve({ markdown: 'PIN' });
  await running;
  assert.equal(board.snapshot().cycle, null);
  assert.deepEqual(db.load()[1], unchanged);
});

test('copiar sólo permite el Markdown o un recibo del historial de la tarjeta', async () => {
  const { board } = setup({
    review: async () => ({
      approved: true, feedback: 'Está claro.',
      execution: { model: 'claude/sonnet', receiptId: 'recibo-exacto', durationMs: 250 },
    }),
  });
  const first = board.create(card());
  const second = board.create(card('Otra tarea'));
  assert.throws(() => board.copyText(first.id), /Markdown/);
  assert.throws(() => board.copyText('desconocida'), /tarjeta/);
  await board.run(first.id);
  assert.equal(board.copyText(first.id), '# Acceso\n\nPedí un pin.\n');
  assert.equal(board.copyText(first.id, 'recibo-exacto'), 'recibo-exacto');
  assert.throws(() => board.copyText(first.id, true), /recibo/);
  assert.throws(() => board.copyText(first.id, 'RECIBO-EXACTO'), /recibo/);
  assert.throws(() => board.copyText(second.id, 'recibo-exacto'), /recibo/);
});
