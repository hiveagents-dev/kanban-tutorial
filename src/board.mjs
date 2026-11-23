import { randomUUID } from 'node:crypto';

const BATCH_SIZE = 8;
const ATTEMPTS_PER_CYCLE = 2;
const INTERRUPTED = 'El ciclo se interrumpió. Podés revisar la evidencia y reintentar la tarjeta.';

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

function event(role, message, execution) {
  const entry = { at: new Date().toISOString(), role, message };
  if (execution === undefined) return entry;
  const { model, receiptId, durationMs } = execution ?? {};
  if (typeof model !== 'string' || !/^[a-z][a-z0-9-]*\/[a-zA-Z0-9_.:+-]{1,180}$/.test(model)
      || typeof receiptId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(receiptId)
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
  let controller = null;
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
    const inFlight = card => card.status === 'working' || card.status === 'review';
    if (cards.some(inFlight)) {
      commit(cards.map(card => inFlight(card)
        ? { ...card, status: 'blocked', events: [...card.events, event('system', INTERRUPTED)] }
        : card));
    }
  }

  function snapshot() {
    return { cards: structuredClone(cards), active: controller !== null };
  }

  function create(input) {
    const title = text(input?.title, 'El título', 120);
    const brief = text(input?.brief, 'La consigna', 2000);
    if (!Array.isArray(input.requiredTerms) || !input.requiredTerms.length || input.requiredTerms.length > 8) {
      throw new Error('Ingresá entre 1 y 8 términos de aceptación.');
    }
    const requiredTerms = input.requiredTerms.map(term => text(term, 'Cada término', 80));
    const { initialDraft } = input;
    if (initialDraft !== undefined && (typeof initialDraft !== 'string' || initialDraft.length > 8000)) {
      throw new Error('El borrador inicial debe ser texto de hasta 8000 caracteres.');
    }
    const hasDraft = Boolean(initialDraft?.trim());
    const card = {
      id: randomUUID(), title, brief, requiredTerms,
      ...(hasDraft ? { initialDraft, initialDraftEvaluated: false } : {}),
      status: 'pending', artifact: hasDraft ? initialDraft : '', checks: [], attempts: 0,
      events: [event('system', 'Tarjeta creada.')],
    };
    commit([...cards, card]);
    return structuredClone(card);
  }

  function retry(id) {
    if (controller) throw new Error('Esperá a que termine el ciclo activo.');
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

  async function run() {
    if (controller) throw new Error('Ya hay un ciclo activo.');
    recover();
    const batch = cards.filter(card => card.status === 'pending').slice(0, BATCH_SIZE);
    if (!batch.length) return snapshot();
    const remaining = new Set(batch.map(card => card.id));
    controller = new AbortController();
    const { signal } = controller;
    let currentId = null;
    try {
      notify();
      while (remaining.size) {
        const eligible = cards.filter(card => remaining.has(card.id)).map(({ id, title, brief, requiredTerms }) =>
          ({ id, title, brief, requiredTerms }));
        const plan = await dispatch('plan', { cards: eligible }, signal);
        signal.throwIfAborted();
        if (!remaining.has(plan?.cardId)) throw new Error('El planificador eligió una tarjeta fuera del lote.');
        const reason = text(plan.reason, 'El motivo del planificador', 2000);
        const selected = update(plan.cardId, { status: 'working' }, event('planner', reason, plan.execution));
        currentId = selected.id;
        remaining.delete(currentId);
        await deliver(selected, signal);
        currentId = null;
      }
    } catch (error) {
      if (cards.some(card => card.id === currentId && card.status !== 'blocked')) {
        update(currentId, { status: 'blocked' }, event('system', signal.aborted ? INTERRUPTED : error.message));
      }
      if (!signal.aborted) throw error;
    } finally {
      controller = null;
      notify();
    }
    return snapshot();
  }

  recover();
  return {
    snapshot, create, retry, run,
    stop() {
      if (!controller || controller.signal.aborted) return;
      controller.abort();
      recover();
    },
  };
}
