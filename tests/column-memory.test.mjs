import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Agent } from 'hiveagents-runtime';
import { createAgents } from '../src/agents.mjs';
import { columnContext, findSimilarCards } from '../src/column-memory.mjs';
import { openStore } from '../src/store.mjs';

const when = '2026-11-20T12:00:00.000Z';
const entry = (role, message) => ({ role, message, at: when });
const input = {
  title: 'Documentar exportación fiscal mensual',
  brief: 'Guía de exportación fiscal mensual con el período declarado',
  requiredTerms: ['Período fiscal'],
};
const card = (id, title, status, options = {}) => ({
  id, title, status, brief: '', requiredTerms: [], attempts: 0, checks: [], events: [],
  artifact: '', ...options,
});
const fiscalWork = card('active', 'Exportación fiscal mensual', 'working');
const fiscalDelivery = card('done', 'Guía para la exportación fiscal', 'done', {
  brief: 'Incluye el período fiscal mensual',
  events: [
    entry('planner', 'Primero la entrega mensual.'),
    entry('writer', 'Primer borrador entregado.'),
    entry('reviewer', 'Confirmá el período fiscal que se exporta.'),
  ],
  artifact: 'ARCHIVO_PRIVADO ' + 'x'.repeat(30_000),
});
const otherProcess = card('other', 'Guía de instalación del cliente', 'done', {
  brief: 'Explica el primer inicio de sesión',
  events: [entry('reviewer', 'Señal de otra tarea.')],
});

test('detecta coincidencias en curso y terminadas por título, consigna y criterios', () => {
  const others = [otherProcess, fiscalWork, fiscalDelivery];
  const matches = findSimilarCards(others, input);
  assert.deepEqual(matches.map(({ id }) => id).sort(), ['active', 'done']);
  assert.equal(matches.find(({ id }) => id === 'active').status, 'working');
  assert.equal(matches.find(({ id }) => id === 'done').status, 'done');
  assert.ok(matches.every(({ reason }) => reason.includes('exportacion') || reason.includes('fiscal')));
  assert.ok(matches.every(item => !Object.hasOwn(item, 'artifact')));
  assert.deepEqual(findSimilarCards(others, { title: 'Guía del equipo' }), []);
  assert.deepEqual(findSimilarCards(others, { title: ' ' }), []);
  assert.deepEqual(findSimilarCards(others, input, { excludeId: 'done' }).map(({ id }) => id), ['active']);
});

test('reconoce un título exacto pese a diferencias de acento, mayúsculas y puntuación', () => {
  assert.deepEqual(findSimilarCards([fiscalWork], { title: 'EXPORTACION fiscal, mensual.' }), [
    { id: 'active', title: fiscalWork.title, status: 'working', reason: 'El título coincide.' },
  ]);
});

test('recupera evidencia distinta por columna a partir de tarjetas reabiertas', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'column-memory-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  openStore(cwd).save([fiscalWork, fiscalDelivery, otherProcess]);
  const cards = openStore(cwd).load();
  assert.deepEqual(columnContext(cards, 'pending', input).map(({ id }) => id), ['done']);
  const working = columnContext(cards, 'working', input);
  assert.deepEqual(working.map(({ id }) => id).sort(), ['active', 'done']);
  const reviewing = columnContext(cards, 'review', input);
  assert.deepEqual(reviewing.map(({ id }) => id), ['done']);
  assert.equal(reviewing[0].evidence, 'Confirmá el período fiscal que se exporta.');
  assert.deepEqual(columnContext(cards, 'done', input).map(({ id }) => id), ['done']);
  assert.deepEqual(columnContext(cards, 'blocked', input), []);
  assert.deepEqual(columnContext(cards, 'review', input, { excludeId: 'done' }), []);
  assert.ok(!JSON.stringify([working, reviewing]).includes('ARCHIVO_PRIVADO'));
});

test('acota precedentes y separa la tarea de las observaciones externas a su revisión', async t => {
  const sameCard = card('card-version', input.title, 'review', {
    ...input, events: [entry('reviewer', 'DICTAMEN_OBSOLETO')], artifact: '# Borrador previo',
  });
  const similar = Array.from({ length: 9 }, (_, id) => ({
    ...fiscalDelivery, id: String(id + 1),
    events: [entry('reviewer', 'Observación fiscal: ' + 'o'.repeat(2_000))],
  }));
  const cwd = await mkdtemp(join(tmpdir(), 'column-agent-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const models = createAgents({ cwd, model: 'claude/sonnet', getCards: () => [sameCard, ...similar] });
  t.mock.method(Agent.prototype, 'ready', async function () {
    return {
      ready: true, provider: 'claude', model: this.model, installation: { installed: true },
      auth: { authenticated: true, source: 'subscription' }, capabilities: { unsupported: [] },
      plan: { transport: 'exec' },
    };
  });
  const original = '# Exportación fiscal mensual';
  let payload;
  t.mock.method(Agent.prototype, 'run', async function (prompt, options) {
    payload = JSON.parse(prompt);
    assert.equal(options.outputSchema.properties.approved.type, 'boolean');
    return { status: 'completed', output: { approved: true, feedback: 'Sí.' } };
  });
  await models.review({ card: sameCard, markdown: original, checks: [] });
  assert.equal(payload.markdown, original);
  assert.equal(payload.memory.column, 'review');
  assert.equal(payload.memory.related.length, 3);
  assert.ok(payload.memory.related.every(record => record.evidence.length <= 220));
  assert.ok(!JSON.stringify(payload).includes('DICTAMEN_OBSOLETO'));
  assert.ok(!JSON.stringify(payload).includes('ARCHIVO_PRIVADO'));
});

test('el planificador y el redactor reciben memoria distinta sin ampliar el lote', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'column-plan-write-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requested = card('requested', input.title, 'pending', input);
  const models = createAgents({ cwd, model: 'claude/sonnet', getCards: () => [requested, fiscalWork, fiscalDelivery] });
  t.mock.method(Agent.prototype, 'ready', async function () {
    return {
      ready: true, provider: 'claude', model: this.model, installation: { installed: true },
      auth: { authenticated: true, source: 'subscription' }, capabilities: { unsupported: [] }, plan: { transport: 'exec' },
    };
  });
  const payloads = [];
  t.mock.method(Agent.prototype, 'run', async function (prompt, options) {
    payloads.push(JSON.parse(prompt));
    if (options.outputSchema.properties.cardId) {
      assert.deepEqual(options.outputSchema.properties.cardId.enum, [requested.id]);
      return { status: 'completed', output: { cardId: requested.id, reason: 'Es elegible.' } };
    }
    return { status: 'completed', output: { markdown: '# Guía fiscal' } };
  });
  await models.plan({ cards: [requested] });
  await models.write({ card: requested, feedback: '' });
  assert.deepEqual(payloads[0].cards.map(({ id }) => id), [requested.id]);
  assert.equal(payloads[0].memory.column, 'pending');
  assert.equal(payloads[0].memory.related[0].precedents[0].evidence, 'Primero la entrega mensual.');
  assert.deepEqual(payloads[0].memory.related[0].existingWork.map(({ id }) => id).sort(), ['active', 'done']);
  assert.equal(payloads[1].memory.column, 'working');
  assert.equal(payloads[1].memory.related.find(({ id }) => id === 'done').evidence, 'Primer borrador entregado.');
  assert.equal(payloads[1].memory.completed[0].evidence, 'Confirmá el período fiscal que se exporta.');
  assert.ok(!JSON.stringify(payloads).includes('ARCHIVO_PRIVADO'));
});

test('el asistente usa el canal estructurado del SDK y conserva su propio recibo', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'board-assist-turn-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let event;
  const agents = createAgents({ cwd, model: 'claude/sonnet', onTurn: turn => { event = turn; } });
  t.mock.method(Agent.prototype, 'ready', async function () {
    return {
      ready: true, provider: 'claude', model: this.model, installation: { installed: true },
      auth: { authenticated: true, source: 'subscription' }, capabilities: { unsupported: [] },
      plan: { transport: 'exec' },
    };
  });
  const input = { question: '¿Qué está bloqueado?', board: { counts: { blocked: 1 } } };
  const reply = { message: 'La tarjeta está bloqueada.', action: 'retry', cardId: 'guia' };
  t.mock.method(Agent.prototype, 'run', async (prompt, options) => {
    assert.deepEqual(JSON.parse(prompt), input);
    assert.deepEqual(options.outputSchema.properties.action.enum, ['none', 'retry', 'run', 'retryAndRun']);
    assert.equal(options.awaitSettlement, true);
    return { status: 'completed', output: reply };
  });
  const { execution, ...response } = await agents.assist(input);
  assert.deepEqual(response, reply);
  assert.equal(execution.model, 'claude/claude-sonnet-5');
  assert.equal(typeof execution.receiptId, 'string');
  assert.equal(event.role, 'assist');
  assert.equal(event.receiptId, execution.receiptId);
});
