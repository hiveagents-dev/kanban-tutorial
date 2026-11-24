import { createHash, randomUUID } from 'node:crypto';

const DAY = 86_400_000;
const MAX_MESSAGES = 160;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CARDS = 40;
const MAX_ALERTS = 100;
const MAX_QUESTION = 1000;
const MAX_ANSWER = 2400;
const statuses = { pending: 'Pendiente', working: 'En curso', review: 'En revisión', done: 'Terminada', blocked: 'Bloqueada' };
const actions = { retry: 'Devolver a Pendientes', run: 'Ejecutar tarjeta', retryAndRun: 'Reintentar y ejecutar' };
const phases = new Set(['pending', 'applying', 'applied', 'dismissed', 'expired', 'failed']);
const roles = new Set(['user', 'assistant', 'system']);
const ref = /^[a-zA-Z0-9_-]{1,128}$/;
const modelRef = /^[a-z][a-z0-9-]*\/[a-zA-Z0-9_.:+-]{1,180}$/;

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const within = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
const duration = value => Number.isSafeInteger(value) && value >= 0;

function validExecution(value) {
  return value && typeof value.model === 'string' && modelRef.test(value.model)
    && typeof value.receiptId === 'string' && ref.test(value.receiptId) && duration(value.durationMs);
}

function knownAction(action) {
  return typeof action === 'string' && Object.hasOwn(actions, action);
}

function validProposal(value) {
  return value && within(value.id, 1, 128) && within(value.cardId, 1, 128)
    && within(value.title, 1, 160) && /^[0-9a-f]{64}$/.test(value.revision ?? '')
    && knownAction(value.kind) && phases.has(value.status);
}

function validMessage(value) {
  return value && within(value.id, 1, 128) && roles.has(value.role)
    && within(value.text, 1, MAX_ANSWER) && within(value.at, 1, 40) && Number.isFinite(Date.parse(value.at))
    && (value.alertId === undefined || within(value.alertId, 1, 128))
    && (value.alertTitle === undefined || (value.alertId && within(value.alertTitle, 1, 120)))
    && (value.execution === undefined || validExecution(value.execution))
    && (value.proposal === undefined || (value.role === 'assistant' && validProposal(value.proposal)));
}

function readMessages(store) {
  const data = store.load();
  if (data === undefined) return [];
  if (data?.version !== 1 || !Array.isArray(data.messages)
    || data.messages.length > MAX_MESSAGES || !data.messages.every(validMessage)
    || new Set(data.messages.map(entry => entry.id)).size !== data.messages.length) {
    throw new Error('La conversación del asistente tiene un formato inválido.');
  }
  const proposals = data.messages.flatMap(entry => entry.proposal ? [entry.proposal.id] : []);
  if (new Set(proposals).size !== proposals.length) throw new Error('La conversación tiene propuestas duplicadas.');
  return structuredClone(data.messages);
}

function cardRevision(card) {
  return digest([card.status, card.title, card.brief, card.requiredTerms, card.attempts,
    card.artifact, card.checks, card.events.length, card.events.at(-1)]);
}

function ago(days) {
  if (days < 1) return 'desde hace menos de un día';
  if (days === 1) return 'hace un día';
  if (days >= 7 && days % 7 === 0) return days === 7 ? 'hace una semana' : `hace ${days / 7} semanas`;
  return `hace ${days} días`;
}

function boardAlerts(board, date) {
  const alerts = [];
  for (const card of board.cards) {
    const last = card.events.at(-1);
    const stamp = Date.parse(last?.at);
    const days = Number.isFinite(stamp) ? Math.max(0, Math.floor((date.getTime() - stamp) / DAY)) : null;
    const blocked = card.status === 'blocked';
    const pending = card.status === 'pending' && days !== null && days >= 14;
    const interrupted = !board.active && (card.status === 'working' || card.status === 'review');
    if (!blocked && !pending && !interrupted) continue;

    const type = blocked ? 'blocked' : pending ? 'stale-pending' : 'interrupted';
    const level = interrupted || (blocked && days >= 14) ? 'critical' : 'warning';
    const id = `${type}-${digest([card.id, card.events.length, last?.at]).slice(0, 32)}`;
    const message = interrupted ? 'La tarjeta quedó en curso sin un ciclo activo. Recuperá el tablero para revisar su estado.'
      : (blocked ? 'La tarjeta está bloqueada' : 'La tarjeta sigue pendiente') + (days === null ? '.' : ` ${ago(days)}.`);
    alerts.push({ id, type, level, cardId: card.id, title: card.title, message, days: days ?? -1 });
  }
  return alerts.sort((a, b) => (a.level === b.level ? b.days - a.days : a.level === 'critical' ? -1 : 1))
    .slice(0, MAX_ALERTS).map(({ days, ...alert }) => alert);
}

const stop = new Set(['cual', 'donde', 'cuando', 'esta', 'esto', 'para', 'porque', 'tarea', 'tarjeta', 'como', 'pasa', 'quiero', 'podes']);
const normalize = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const terms = value => [...new Set(normalize(value).match(/[\p{L}\p{N}]{3,}/gu))].filter(term => !stop.has(term));

function relevantCards(board, alerts, question, alertCardId) {
  const alertIds = new Set(alerts.map(alert => alert.cardId));
  const normalizedQuestion = normalize(question);
  const query = terms(question);
  return board.cards.map((card, index) => {
    const title = normalize(card.title);
    const exact = normalizedQuestion.includes(title) || normalizedQuestion.includes(normalize(card.id));
    const overlap = query.filter(term => title.includes(term)).length;
    const score = Number(card.id === alertCardId) * 1000 + Number(exact) * 100 + overlap * 10
      + Number(card.id === board.cycle?.cardId) * 5 + Number(alertIds.has(card.id)) * 2;
    return { card, score, index, mentioned: exact || overlap > 0 };
  }).sort((a, b) => b.score - a.score || b.index - a.index);
}

function compactCard(card) {
  return {
    id: card.id, title: card.title.slice(0, 120), status: card.status, statusLabel: statuses[card.status],
    brief: card.brief.slice(0, 140), updatedAt: card.events.at(-1)?.at ?? null, attempts: card.attempts,
  };
}

function buildInput(board, alerts, question, alert, history) {
  const counts = { pending: 0, working: 0, review: 0, done: 0, blocked: 0 };
  for (const card of board.cards) if (Object.hasOwn(counts, card.status)) counts[card.status]++;
  const ranked = relevantCards(board, alerts, question, alert?.cardId);
  const focus = ranked.find(({ card, mentioned }) => card.id === alert?.cardId || mentioned)?.card;
  const cards = ranked.slice(0, MAX_CONTEXT_CARDS).map(({ card }) => compactCard(card));
  return {
    question, alert,
    target: focus ? {
      ...compactCard(focus), brief: focus.brief.slice(0, 1200),
      checks: focus.checks.slice(0, 9).map(check => ({ name: check.name.slice(0, 160), passed: check.passed })),
      history: focus.events.slice(-6).map(event => ({ role: event.role, text: event.message.slice(0, 280), at: event.at })),
      requiredTerms: focus.requiredTerms.slice(0, 8).map(term => term.slice(0, 80)),
    } : null,
    recent: history.filter(message => !alert || message.alertId === alert.id)
      .slice(-MAX_CONTEXT_MESSAGES).map(({ role, text }) => ({ role, text: text.slice(0, 500) })),
    board: { active: board.active, cycle: board.cycle, counts, cards, total: board.cards.length, omitted: board.cards.length - cards.length },
  };
}

function legalAction(kind, card) {
  return knownAction(kind) && !!card && card.status === (kind === 'run' ? 'pending' : 'blocked');
}

function errorMessage(error) {
  const hints = {
    NO_ROUTE: 'Revisá que Claude Code o Codex estén instalados y autenticados.',
    NOT_AUTHENTICATED: 'Revisá la sesión del CLI.',
    USAGE_LIMIT: 'El proveedor informó que se agotó su cupo.',
    TIMEOUT: 'Se agotó el tiempo del turno.',
  };
  const hint = typeof error?.code === 'string' && Object.hasOwn(hints, error.code) ? hints[error.code] : '';
  return ['El asistente no pudo responder.', hint || 'Podés volver a enviar la consulta.'].join(' ');
}

export function createAssistant({ board, store, respond, runCard, onChange = () => {}, now = () => new Date() }) {
  let messages = readMessages(store);
  let busy = false;
  let controller;
  let operation;
  let closed = false;

  function notify() {
    try { onChange(); } catch { /* The renderer may already have closed. */ }
  }

  function commit(next) {
    const bounded = next.slice(-MAX_MESSAGES);
    try { store.save(structuredClone({ version: 1, messages: bounded })); }
    catch { throw new Error('No se pudo guardar la conversación del asistente.'); }
    messages = bounded;
    notify();
  }

  function message(role, text, details = {}) {
    return { id: randomUUID(), role, text, at: now().toISOString(), ...details };
  }

  function snapshot() {
    const visible = messages.map(entry => {
      if (!entry.proposal) return entry;
      const { revision, ...proposal } = entry.proposal;
      return { ...entry, proposal };
    });
    return { alerts: boardAlerts(board.snapshot(), now()), messages: structuredClone(visible), busy };
  }

  function available() {
    if (closed) throw new Error('El asistente está cerrando.');
    if (busy) throw new Error('Esperá a que termine la operación del asistente.');
  }

  function makeProposal(output, input, current) {
    if (output.action === 'none') return undefined;
    const allowed = input.board.cards.some(card => card.id === output.cardId);
    const incident = input.alert;
    const card = current.cards.find(item => item.id === output.cardId);
    if (!within(output.cardId, 1, 128) || !allowed || (incident && incident.cardId !== output.cardId)
      || !legalAction(output.action, card)) return null;
    return {
      id: randomUUID(), kind: output.action, cardId: card.id, status: 'pending',
      title: `${actions[output.action]} · ${card.title}`.slice(0, 160), revision: cardRevision(card),
    };
  }

  async function ask(input) {
    available();
    if (!within(input?.text, 1, MAX_QUESTION) || !input.text.trim()) {
      throw new Error(`Escribí un mensaje de hasta ${MAX_QUESTION} caracteres.`);
    }
    const { alertId } = input;
    const initial = board.snapshot();
    const alerts = boardAlerts(initial, now());
    const alert = alertId === undefined ? null : alerts.find(item => item.id === alertId);
    if (alertId !== undefined && !alert) throw new Error('La alerta cambió. Actualizá la lista para ver su estado.');
    const context = buildInput(initial, alerts, input.text.trim(), alert, messages);
    const details = alert ? { alertId: alert.id, alertTitle: alert.title.slice(0, 120) } : {};
    const user = message('user', context.question, details);
    controller = new AbortController();
    const { signal } = controller;
    busy = true;
    try {
      commit([...messages, user]);
      try {
        signal.throwIfAborted();
        const output = await respond(context, signal);
        signal.throwIfAborted();
        if (!within(output?.message, 1, MAX_ANSWER) || !output.message.trim()
          || (output.action !== 'none' && !knownAction(output.action))) {
          throw new Error('El asistente devolvió un resultado inválido.');
        }
        const original = initial.cards.find(card => card.id === output.cardId);
        const current = board.snapshot();
        const currentCard = current.cards.find(card => card.id === output.cardId);
        const unchanged = original && currentCard && cardRevision(original) === cardRevision(currentCard);
        const proposal = output.action === 'none' ? undefined : unchanged ? makeProposal(output, context, current) : null;
        const reply = message('assistant', output.message.trim(), {
          ...details, ...(proposal ? { proposal } : {}),
          ...(validExecution(output.execution) ? { execution: {
            model: output.execution.model, receiptId: output.execution.receiptId, durationMs: output.execution.durationMs,
          } } : {}),
        });
        const next = [...messages, reply];
        if (proposal === null) next.push(message('system', 'La acción sugerida quedó sin confirmar porque la tarjeta o su estado no coincide.', details));
        commit(next);
      } catch (error) {
        const description = signal.aborted ? 'Se detuvo la consulta al asistente.' : errorMessage(error);
        commit([...messages, message('system', description, details)]);
      }
    } finally {
      controller = undefined;
      busy = false;
      notify();
    }
    return snapshot();
  }

  function updateProposal(entry, status, note) {
    const next = messages.map(item => item.id === entry.id ? { ...item, proposal: { ...item.proposal, status } } : item);
    if (note) {
      const details = entry.alertId ? { alertId: entry.alertId, alertTitle: entry.alertTitle } : {};
      next.push(message('system', note, details));
    }
    commit(next);
  }

  async function decide(input) {
    available();
    if (!within(input?.id, 1, 128) || typeof input.confirm !== 'boolean') {
      throw new Error('Decisión de asistente inválida.');
    }
    const entry = messages.find(item => item.proposal?.id === input.id);
    if (entry?.proposal?.status !== 'pending') throw new Error('La propuesta ya no está disponible.');
    if (!input.confirm) {
      updateProposal(entry, 'dismissed', 'Se descartó la propuesta.');
      return snapshot();
    }
    const { proposal } = entry;
    const initial = board.snapshot();
    const card = initial.cards.find(item => item.id === proposal.cardId);
    if (!legalAction(proposal.kind, card) || proposal.revision !== cardRevision(card)) {
      updateProposal(entry, 'expired', 'La tarjeta cambió. Pedile al asistente una propuesta actualizada.');
      return snapshot();
    }
    if (initial.active) throw new Error('Esperá a que termine el ciclo del tablero antes de confirmar.');
    busy = true;
    try {
      // This is the durable one-use boundary. A restart can leave the outcome
      // uncertain, but the assistant must never dispatch this ID again.
      updateProposal(entry, 'applying');
      let completed = false;
      try {
        if (proposal.kind !== 'run') board.retry(card.id);
        if (proposal.kind !== 'retry') await runCard(card.id);
        completed = true;
      } catch {
        updateProposal(entry, 'failed', 'El tablero no pudo completar la acción. Abrí la tarjeta para verificar qué cambios quedaron guardados.');
      }
      if (completed) {
        const result = board.snapshot().cards.find(item => item.id === card.id);
        const status = result ? statuses[result.status] : 'Estado desconocido';
        updateProposal(entry, 'applied', `Acción aplicada a «${card.title}». Estado actual: ${status}.`);
      }
    } finally {
      busy = false;
      notify();
    }
    return snapshot();
  }

  function track(task, input) {
    if (operation) return Promise.reject(new Error('Esperá a que termine la operación del asistente.'));
    operation = Promise.resolve().then(() => task(input)).finally(() => { operation = undefined; });
    return operation;
  }

  if (messages.some(entry => entry.proposal?.status === 'applying')) {
    const expired = messages.map(entry => entry.proposal?.status === 'applying'
      ? { ...entry, proposal: { ...entry.proposal, status: 'expired' } } : entry);
    commit([...expired, message('system', 'Una acción quedó interrumpida al cerrar el tablero. Revisá el estado de la tarjeta antes de volver a autorizarla.')]);
  }

  return {
    snapshot,
    ask: input => track(ask, input),
    decide: input => track(decide, input),
    async close() {
      closed = true;
      controller?.abort();
      await operation?.catch(() => {});
    },
  };
}
