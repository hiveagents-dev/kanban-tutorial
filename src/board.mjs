import { randomUUID } from 'node:crypto';

const BATCH_SIZE = 8;
const ATTEMPTS_PER_CYCLE = 2;
const INTERRUPTED = 'El ciclo se interrumpió. Podés revisar la evidencia y reintentar la tarjeta.';
const RECEIPT_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const phases = new Map([['working', 'writing'], ['review', 'reviewing']]);

const providerHints = new Map([
  ['USAGE_LIMIT', 'El proveedor informó que se agotó su cupo.'],
  ['TIMEOUT', 'Se agotó el tiempo del turno.'],
  ['OUTPUT_LIMIT', 'La respuesta superó el límite de salida.'],
  ['STRUCTURED_OUTPUT_ERROR', 'El proveedor no entregó el documento con el esquema requerido.'],
  ['PROTOCOL_ERROR', 'El CLI devolvió una respuesta de protocolo inválida.'],
  ['PROVIDER_UNAVAILABLE', 'El proveedor no está disponible.'],
  ['NOT_AUTHENTICATED', 'Revisá la sesión del CLI.'],
  ['NO_ROUTE', 'No hay un CLI compatible y autenticado para este turno.'],
]);

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`${label} debe tener entre 1 y ${max} caracteres.`);
  }
  return value.trim();
}

function cardInput(input) {
  const title = text(input?.title, 'El título', 120);
  const brief = text(input?.brief, 'La consigna', 2000);
  if (!Array.isArray(input.requiredTerms) || !input.requiredTerms.length || input.requiredTerms.length > 8) {
    throw new Error('Ingresá entre 1 y 8 términos de aceptación.');
  }
  const requiredTerms = [...input.requiredTerms].map(term => text(term, 'Cada término', 80));
  const { initialDraft } = input;
  if (initialDraft !== undefined && (typeof initialDraft !== 'string' || initialDraft.length > 8000)) {
    throw new Error('El borrador inicial debe ser texto de hasta 8000 caracteres.');
  }
  return {
    title, brief, requiredTerms,
    ...(initialDraft?.trim()
      ? { initialDraft, initialDraftEvaluated: false, artifact: initialDraft }
      : { artifact: '' }),
  };
}

function event(role, message, execution) {
  const entry = { at: new Date().toISOString(), role, message };
  if (execution === undefined) return entry;
  const { model, receiptId, durationMs } = execution ?? {};
  if (typeof model !== 'string' || !/^[a-z][a-z0-9-]*\/[a-zA-Z0-9_.:+-]{1,180}$/.test(model)
      || typeof receiptId !== 'string' || !RECEIPT_ID.test(receiptId)
      || !Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new Error('El turno devolvió una referencia de ejecución inválida.');
  }
  entry.execution = { model, receiptId, durationMs };
  return entry;
}

function acceptance(markdown, terms) {
  const content = markdown.normalize('NFC').toLowerCase();
  return [
    { name: 'Documento con contenido', passed: markdown.trim().length > 0 },
    ...terms.map(term => ({
      name: `Incluye «${term}»`,
      passed: content.includes(term.normalize('NFC').toLowerCase()),
    })),
  ];
}

// The store is synchronous and atomic. Publish a state transition before dispatching
// its external turn, so a restart can always identify interrupted work.
export function createBoard({ store, agents, onChange = () => {} }) {
  let cards = store.load();
  let cycle = null;
  if (!Array.isArray(cards)) throw new Error('El archivo del tablero es inválido.');

  function notify() {
    // A closing or unavailable window must not roll back a durable decision.
    try { onChange(); } catch { /* Views can always read a new snapshot. */ }
  }

  function commit(next) {
    try {
      store.save(next);
    } catch {
      throw new Error('No se pudo guardar el tablero. Verificá el almacenamiento local.');
    }
    cards = next;
    notify();
  }

  function update(id, fields, ...entries) {
    const next = cards.map(card => card.id === id
      ? { ...card, ...fields, events: [...card.events, ...entries] }
      : card);
    commit(next);
    return next.find(card => card.id === id);
  }

  function recover() {
    const inFlight = card => phases.has(card.status);
    if (cards.some(inFlight)) {
      commit(cards.map(card => inFlight(card)
        ? { ...card, status: 'blocked', events: [...card.events, event('system', INTERRUPTED)] }
        : card));
    }
  }

  function snapshot() {
    const result = { cards: structuredClone(cards), active: cycle !== null, cycle: null };
    if (cycle) {
      const current = cards.find(card => card.id === cycle.cardId);
      const phase = cycle.controller.signal.aborted ? 'stopping' : phases.get(current?.status) ?? 'planning';
      result.cycle = {
        phase,
        cardId: phase === 'planning' ? null : cycle.cardId,
        total: cycle.batch.size,
        processed: cards.filter(card => cycle.batch.has(card.id)
          && (card.status === 'done' || card.status === 'blocked')).length,
        startedAt: cycle.startedAt,
      };
    }
    return result;
  }

  function create(input) {
    const card = {
      id: randomUUID(), ...cardInput(input), status: 'pending', checks: [], attempts: 0,
      events: [event('system', 'Tarjeta creada.')],
    };
    commit([...cards, card]);
    return structuredClone(card);
  }

  function edit(id, input) {
    if (cycle) throw new Error('Esperá a que termine el ciclo activo.');
    const card = cards.find(item => item.id === id && item.status === 'pending');
    if (!card) throw new Error('Sólo se puede editar una tarjeta pendiente.');
    if (card.events.some(entry => entry.role === 'planner')) {
      throw new Error('Duplicá la tarjeta si querés cambiar un encargo que ya se asignó.');
    }
    const edited = {
      ...card, ...cardInput(input),
      events: [...card.events, event('system', 'Se editó el encargo.')],
    };
    if (!edited.artifact) {
      delete edited.initialDraft;
      delete edited.initialDraftEvaluated;
    }
    commit(cards.map(item => item.id === id ? edited : item));
    return structuredClone(edited);
  }

  function copyText(id, receiptId) {
    const card = cards.find(item => item.id === id);
    if (!card) throw new Error('No se encontró la tarjeta.');
    if (receiptId === undefined) {
      if (!card.artifact.trim()) throw new Error('La tarjeta todavía no tiene Markdown para copiar.');
      return card.artifact;
    }
    if (typeof receiptId !== 'string' || !RECEIPT_ID.test(receiptId)
      || !card.events.some(entry => entry.execution?.receiptId === receiptId)) {
      throw new Error('El recibo no pertenece a esta tarjeta.');
    }
    return receiptId;
  }

  function retry(id) {
    if (cycle) throw new Error('Esperá a que termine el ciclo activo.');
    if (!cards.some(card => card.id === id && card.status === 'blocked')) {
      throw new Error('Sólo se puede reintentar una tarjeta bloqueada.');
    }
    return structuredClone(update(id, { status: 'pending', attempts: 0 },
      event('system', 'Reintento solicitado. La tarjeta vuelve a pendientes.')));
  }

  // Keep CLI stderr, paths and prompts out of the durable journal. Return only
  // model fields intended for the board, after checking their type and size.
  async function dispatch(role, input, signal) {
    signal.throwIfAborted();
    try {
      const result = await agents[role]({ ...structuredClone(input), signal });
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (['ENOSPC', 'EDQUOT', 'EROFS'].includes(error?.code)) {
        throw new Error('El turno se interrumpió por un problema de almacenamiento local. Revisá el espacio y el acceso de escritura.');
      }
      if (['EACCES', 'EPERM'].includes(error?.code)) {
        throw new Error('El turno se interrumpió por permisos locales. Revisá el acceso al CLI y al directorio de datos.');
      }
      const label = { plan: 'planificador', write: 'redactor', review: 'revisor' }[role];
      const hint = providerHints.get(error?.code) ?? 'Consultá el diagnóstico del CLI antes de reintentar.';
      throw new Error(`Falló el turno del ${label}. ${hint}`);
    }
  }

  async function deliver(initialCard, signal) {
    let card = initialCard;
    const lastReview = card.events.findLast(item => item.role === 'reviewer' || item.role === 'checks');
    let feedback = card.artifact && lastReview ? lastReview.message : '';
    while (card.attempts < ATTEMPTS_PER_CYCLE) {
      signal.throwIfAborted();
      const attempt = card.attempts + 1;
      const useInitial = Boolean(card.initialDraft && !card.initialDraftEvaluated);
      let markdown = card.initialDraft;
      let source;
      if (useInitial) {
        source = event('system', 'Se recibió el borrador inicial para evaluación.');
      } else {
        card = update(card.id, { status: 'working', attempts: attempt },
          event('writer', `Comenzó el intento ${attempt}.`));
        const draft = await dispatch('write', { card, feedback }, signal);
        signal.throwIfAborted();
        if (typeof draft?.markdown !== 'string' || draft.markdown.length > 32000) {
          throw new Error('El redactor devolvió un documento inválido o demasiado largo.');
        }
        markdown = draft.markdown;
        source = event('writer', `Borrador ${attempt} entregado.`, draft.execution);
      }
      const checks = acceptance(markdown, card.requiredTerms);
      const failed = checks.filter(check => !check.passed);
      feedback = failed.length ? `Corregí estos chequeos: ${failed.map(check => check.name).join(', ')}.` : '';
      const evaluated = useInitial ? { initialDraftEvaluated: true } : {};
      card = update(card.id, {
        status: 'review', artifact: markdown, attempts: attempt, checks,
        ...(failed.length ? evaluated : {}),
      }, source, event('checks', feedback || `Pasaron los ${checks.length} chequeos.`));

      if (!failed.length) {
        const verdict = await dispatch('review', { card, markdown, checks }, signal);
        signal.throwIfAborted();
        if (typeof verdict?.approved !== 'boolean') throw new Error('El revisor devolvió un dictamen inválido.');
        feedback = text(verdict.feedback, 'El comentario del revisor', 2000);
        const entry = event('reviewer', `${verdict.approved ? 'Aprobado' : 'Pidió cambios'}. ${feedback}`, verdict.execution);
        if (verdict.approved) {
          update(card.id, { status: 'done', ...evaluated }, entry);
          return;
        }
        card = update(card.id, evaluated, entry);
      }
    }
    signal.throwIfAborted();
    update(card.id, { status: 'blocked' },
      event('system', 'Se agotaron los dos intentos. Revisá el último borrador y la devolución.'));
  }

  async function run(id) {
    if (cycle) throw new Error('Ya hay un ciclo activo.');
    const pending = cards.filter(card => card.status === 'pending' && (id === undefined || card.id === id));
    if (id !== undefined && !pending.length) throw new Error('Elegí una tarjeta pendiente para procesarla.');
    recover();
    if (!pending.length) return snapshot();
    const batch = new Set(pending.slice(0, BATCH_SIZE).map(card => card.id));
    const controller = new AbortController();
    cycle = { controller, batch, cardId: null, startedAt: new Date().toISOString() };
    const { signal } = controller;
    try {
      notify();
      for (let assigned = 0; assigned < batch.size; assigned++) {
        const eligible = cards.filter(card => batch.has(card.id) && card.status === 'pending')
          .map(({ id, title, brief, requiredTerms }) => ({ id, title, brief, requiredTerms }));
        const plan = await dispatch('plan', { cards: eligible }, signal);
        signal.throwIfAborted();
        if (!eligible.some(card => card.id === plan?.cardId)) throw new Error('El planificador eligió una tarjeta fuera del lote.');
        const reason = text(plan.reason, 'El motivo del planificador', 2000);
        cycle.cardId = plan.cardId;
        const selected = update(plan.cardId, { status: 'working' }, event('planner', reason, plan.execution));
        await deliver(selected, signal);
        cycle.cardId = null;
      }
    } catch (error) {
      const current = cards.find(card => card.id === cycle.cardId);
      if (phases.has(current?.status)) {
        update(current.id, { status: 'blocked' }, event('system', signal.aborted ? INTERRUPTED : error.message));
      }
      if (!signal.aborted) throw error;
    } finally {
      cycle = null;
      notify();
    }
    return snapshot();
  }

  recover();
  return {
    snapshot, create, edit, copyText, retry, run,
    stop() {
      if (!cycle || cycle.controller.signal.aborted) return;
      cycle.controller.abort();
      notify();
      recover();
    },
  };
}
