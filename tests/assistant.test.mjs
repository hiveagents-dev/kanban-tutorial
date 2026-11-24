import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistant } from '../src/assistant.mjs';

const now = () => new Date('2026-11-24T15:00:00.000Z');
const response = (action = 'none', cardId = '') => ({
  message: 'Revisé la tarjeta. Conserva la última devolución del revisor.', action, cardId,
  execution: { model: 'codex/test', receiptId: 'assistant-test', durationMs: 15 },
});

function card(id, status, at = '2026-11-10T15:00:00.000Z') {
  return {
    id, title: id === 'A2' ? 'Notas del lanzamiento' : `Tarjeta ${id}`, brief: 'Redactar una guía.',
    requiredTerms: ['Documento'], status, artifact: '# Documento', checks: [], attempts: 1,
    events: [{ role: 'system', message: 'Se agotaron los dos intentos.', at }],
  };
}

function setup(initial = [card('A2', 'blocked'), card('A3', 'done')]) {
  const wrapper = {
    cards: initial,
    active: false,
    version: undefined,
    history: [],
    board: {
      snapshot: () => structuredClone({ cards: wrapper.cards, active: wrapper.active, cycle: null }),
      retry(id) {
        assert.equal(wrapper.cards.find(item => item.id === id)?.status, 'blocked');
        wrapper.history.push(['retry', id]);
        wrapper.change(id, 'pending');
      },
    },
    change(id, status) {
      const current = wrapper.cards.find(item => item.id === id);
      current.status = status;
      current.events.push({ role: 'system', message: 'Nueva transición.', at: now().toISOString() });
    },
  };
  wrapper.store = {
    load: () => structuredClone(wrapper.version),
    save: data => { wrapper.version = structuredClone(data); },
  };
  wrapper.assistant = (respond, runCard = async id => {
    assert.equal(wrapper.cards.find(item => item.id === id)?.status, 'pending');
    wrapper.history.push(['run', id]);
    wrapper.change(id, 'done');
  }) => createAssistant({ board: wrapper.board, store: wrapper.store, respond, runCard, now });
  return wrapper;
}

test('las alertas de todo el tablero se calculan sin inferencia y desaparecen al cambiar de estado', () => {
  const repo = setup([
    card('A2', 'blocked'),
    card('A3', 'pending', '2026-11-23T15:00:00.000Z'),
    card('A4', 'pending'),
    card('A5', 'review'),
    card('A6', 'done'),
  ]);
  const assistant = repo.assistant(() => assert.fail('consultar alertas no ejecuta el CLI'));
  const first = assistant.snapshot();
  assert.equal(first.busy, false);
  assert.equal(first.messages.length, 0);
  assert.deepEqual(first.alerts.map(({ cardId, type, level }) => ({ cardId, type, level })), [
    { cardId: 'A2', type: 'blocked', level: 'critical' },
    { cardId: 'A5', type: 'interrupted', level: 'critical' },
    { cardId: 'A4', type: 'stale-pending', level: 'warning' },
  ]);
  assert.match(first.alerts[0].message, /hace 2 semanas/);
  assert.equal(assistant.snapshot().alerts[0].id, first.alerts[0].id);
  repo.change('A2', 'done');
  assert.equal(assistant.snapshot().alerts.some(alert => alert.cardId === 'A2'), false);
});

test('responder una alerta aporta contexto de la tarjeta y conserva la conversación al reabrir', async () => {
  const repo = setup();
  const first = repo.assistant(async input => {
    assert.equal(input.target.id, 'A2');
    assert.equal(input.target.history[0].text, 'Se agotaron los dos intentos.');
    assert.deepEqual(input.board.counts, { pending: 0, working: 0, review: 0, done: 1, blocked: 1 });
    assert.equal(input.board.cards.length, 2);
    assert.equal(input.alert.title, 'Notas del lanzamiento');
    assert.equal(input.question, '¿Por qué sigue trabada?');
    assert.deepEqual(input.recent, []);
    return response();
  });
  const { id: alertId } = first.snapshot().alerts[0];
  const result = await first.ask({ text: '¿Por qué sigue trabada?', alertId });
  assert.deepEqual(result.messages.map(message => [message.role, message.alertId]), [['user', alertId], ['assistant', alertId]]);
  assert.equal(result.messages[1].execution.receiptId, 'assistant-test');

  const reopened = repo.assistant(async input => {
    assert.equal(input.recent[0].text, '¿Por qué sigue trabada?');
    assert.equal(input.recent[1].text, response().message);
    return response();
  });
  await reopened.ask({ text: '¿Qué verifico primero?', alertId });
  assert.equal(reopened.snapshot().messages.length, 4);
  assert.deepEqual(repo.history, []);
});

test('una propuesta confirma una sola resolución dirigida y deja el resultado en el chat', async () => {
  const repo = setup([card('A2', 'blocked'), card('OTRA', 'pending')]);
  const assistant = repo.assistant(() => response('retryAndRun', 'A2'));
  const { alerts } = assistant.snapshot();
  await assistant.ask({ text: 'Reintentala con la devolución anterior.', alertId: alerts[0].id });
  const { proposal } = assistant.snapshot().messages[1];
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.title, 'Reintentar y ejecutar · Notas del lanzamiento');
  assert.equal(proposal.revision, undefined);
  assert.deepEqual(repo.history, []);
  await assistant.decide({ id: proposal.id, confirm: true });
  assert.deepEqual(repo.history, [['retry', 'A2'], ['run', 'A2']]);
  const result = assistant.snapshot();
  assert.equal(result.messages[1].proposal.status, 'applied');
  assert.match(result.messages.at(-1).text, /Terminada/);
  assert.equal(repo.cards.find(item => item.id === 'OTRA').status, 'pending');
  assert.equal(result.alerts.some(alert => alert.cardId === 'A2'), false);
  await assert.rejects(assistant.decide({ id: proposal.id, confirm: true }), /ya no está disponible/);
});

test('se puede descartar una acción y se vence una autorización al cambiar la tarjeta', async () => {
  const repo = setup();
  const assistant = repo.assistant(() => response('retry', 'A2'));
  await assistant.ask({ text: 'Reintentá A2' });
  const first = assistant.snapshot().messages[1].proposal;
  await assistant.decide({ id: first.id, confirm: false });
  assert.equal(assistant.snapshot().messages[1].proposal.status, 'dismissed');
  await assistant.ask({ text: 'Reintentá A2 de nuevo' });
  const second = assistant.snapshot().messages.at(-1).proposal;
  repo.change('A2', 'blocked');
  await assistant.decide({ id: second.id, confirm: true });
  const messages = assistant.snapshot().messages;
  assert.equal(messages.find(message => message.proposal?.id === second.id).proposal.status, 'expired');
  assert.deepEqual(repo.history, []);
});

test('una respuesta que inventa un identificador o apunta a otra tarjeta nunca se convierte en propuesta', async () => {
  const repo = setup([card('A2', 'blocked'), card('A4', 'blocked')]);
  let cardId = 'inventada';
  const assistant = repo.assistant(() => response('retry', cardId));
  const alertId = assistant.snapshot().alerts.find(alert => alert.cardId === 'A2').id;
  await assistant.ask({ text: 'Reintentala', alertId });
  cardId = 'A4';
  await assistant.ask({ text: 'Probá de nuevo', alertId });
  assert.equal(assistant.snapshot().messages.some(entry => entry.proposal), false);
  assert.deepEqual(repo.history, []);
  repo.change('A2', 'pending');
  await assert.rejects(assistant.ask({ text: 'Ya la reintenté', alertId }), /La alerta cambió/);
});

test('los errores del proveedor quedan en la conversación con un mensaje acotado', async () => {
  const repo = setup();
  const assistant = repo.assistant(() => { throw Object.assign(new Error('/tmp/datos-detallados'), { code: 'NO_ROUTE' }); });
  const result = await assistant.ask({ text: '¿Cómo sigo?' });
  assert.equal(result.messages.at(-1).role, 'system');
  assert.match(result.messages.at(-1).text, /Claude Code o Codex/);
  assert.doesNotMatch(result.messages.at(-1).text, /datos-detallados/);
  assert.deepEqual(repo.history, []);
});

test('se consume la confirmación antes de despachar y la recuperación nunca repite una acción en curso', async () => {
  const repo = setup();
  const runStarted = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const first = repo.assistant(() => response('retryAndRun', 'A2'), async id => {
    repo.history.push(['run', id]);
    runStarted.resolve();
    await finish.promise;
  });
  await first.ask({ text: 'Reintentá A2' });
  const { id } = first.snapshot().messages[1].proposal;
  const confirming = first.decide({ id, confirm: true });
  await runStarted.promise;
  assert.equal(first.snapshot().messages[1].proposal.status, 'applying');
  await assert.rejects(first.decide({ id, confirm: true }), /Esperá/);

  // Reopen using the persisted copy for a crash test. The original operation
  // can then finish in isolation, as would happen in an automated harness.
  const crash = setup(structuredClone(repo.cards));
  crash.version = structuredClone(repo.version);
  const reopened = crash.assistant(() => assert.fail('reopening a chat does not use an LLM'));
  assert.equal(reopened.snapshot().messages[1].proposal.status, 'expired');
  assert.match(reopened.snapshot().messages.at(-1).text, /interrumpida/);
  await assert.rejects(reopened.decide({ id, confirm: true }), /ya no está disponible/);
  assert.deepEqual(crash.history, []);
  finish.resolve();
  await confirming;
  assert.deepEqual(repo.history, [['retry', 'A2'], ['run', 'A2']]);
});

test('el cierre del asistente aborta y espera la consulta vigente', async () => {
  const repo = setup();
  const started = Promise.withResolvers();
  const assistant = repo.assistant(async (_input, signal) => {
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return response('retry', 'A2');
  });
  const result = assistant.ask({ text: 'Reintentá A2' });
  await started.promise;
  await assistant.close();
  assert.equal(assistant.snapshot().busy, false);
  assert.equal((await result).messages.at(-1).text, 'Se detuvo la consulta al asistente.');
  assert.deepEqual(repo.history, []);
});

test('el resumen conserva los recuentos y prioriza la tarjeta mencionada aun con mucho historial', async () => {
  const repo = setup([card('A2', 'done'), ...Array.from({ length: 65 }, (_, index) => card(`extra-${index}`, 'done'))]);
  const assistant = repo.assistant(input => {
    assert.equal(input.board.total, 66);
    assert.equal(input.board.omitted, 26);
    assert.equal(input.board.counts.done, 66);
    assert.equal(input.board.cards[0].id, 'A2');
    assert.equal(input.target.id, 'A2');
    return response();
  });
  await assistant.ask({ text: '¿Qué pasó con A2?' });
});

test('un historial persistido inválido se rechaza antes de escribir o ejecutar', () => {
  const repo = setup();
  repo.version = { version: 1, messages: [{ id: 'forged', role: 'assistant', text: '', at: 'ayer' }] };
  const data = structuredClone(repo.version);
  assert.throws(() => repo.assistant(() => assert.fail('no se puede ejecutar el CLI')), /formato inválido/);
  assert.deepEqual(repo.version, data);
  assert.deepEqual(repo.history, []);
});

test('si el ciclo falló después de devolver la tarjeta a Pendientes, registra el estado comprobable', async () => {
  const repo = setup();
  const assistant = repo.assistant(() => response('retryAndRun', 'A2'), async () => { throw new Error('/datos-privados'); });
  await assistant.ask({ text: 'Reintentá A2' });
  const { id } = assistant.snapshot().messages[1].proposal;
  const result = await assistant.decide({ id, confirm: true });
  assert.deepEqual(repo.history, [['retry', 'A2']]);
  assert.equal(repo.cards[0].status, 'pending');
  assert.equal(result.busy, false);
  assert.equal(result.messages[1].proposal.status, 'failed');
  assert.match(result.messages.at(-1).text, /qué cambios quedaron guardados/);
  assert.doesNotMatch(result.messages.at(-1).text, /datos-privados/);
  await assert.rejects(assistant.decide({ id, confirm: true }), /ya no está disponible/);
});
