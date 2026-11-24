'use strict';

const bridge = window.kanban;
const byId = id => document.getElementById(id);
const columns = new Map([
  ['pending', { label: 'Pendientes', empty: 'Creá una tarjeta para encargar un documento.' }],
  ['working', { label: 'En curso', empty: 'El planificador asigna una tarjeta cuando iniciás un ciclo.' }],
  ['review', { label: 'En revisión', empty: 'Acá vas a ver qué borrador está pasando por pruebas y revisión.' }],
  ['done', { label: 'Terminadas', empty: 'Los documentos aprobados quedan listos para copiar.' }],
  ['blocked', { label: 'Bloqueadas', empty: 'Podés reintentar una tarjeta cuando el ciclo termine.' }],
]);
const cardStates = {
  pending: 'Pendiente', working: 'En curso', review: 'En revisión', done: 'Terminada', blocked: 'Bloqueada',
};
const roles = {
  system: 'Sistema', planner: 'Planificador', writer: 'Redactor', reviewer: 'Revisor', checks: 'Pruebas',
};
const phases = {
  planning: 'Seleccionando tarjeta', writing: 'Redactando documento', reviewing: 'Validando borrador', stopping: 'Deteniendo ciclo',
};
const formatter = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' });
const secondsFormat = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });

let board = { cards: [], active: false, cycle: null };
let refreshId = 0;
let selected = null;
let editing = null;
let loaded = false;
let starting = false;
let stopping = false;
let retrying = false;

function make(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function report(id, message) {
  const element = byId(id);
  element.textContent = message instanceof Error ? message.message : String(message ?? '');
  element.hidden = !element.textContent;
}

function isPendingEdit(card) {
  return card.status === 'pending' && !card.events.some(event => event.role === 'planner');
}

function searchable(text) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es-AR');
}

function selectedCard() {
  return board.cards.find(card => card.id === selected);
}

function lastExecution(card) {
  return card.events.findLast(event => event.execution)?.execution;
}

function modelLabel(model) {
  return model.slice(model.indexOf('/') + 1);
}

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function renderCycle() {
  const cycle = board.cycle;
  const phase = cycle?.phase ?? (board.active ? 'planning' : null);
  const current = cycle && board.cards.find(card => card.id === cycle.cardId);
  const pending = board.cards.filter(card => card.status === 'pending').length;
  const awaiting = pending === 1 ? '1 tarjeta pendiente' : pending + ' tarjetas pendientes';
  const progress = cycle ? `${cycle.processed} de ${cycle.total} procesadas` : null;
  const idle = pending ? awaiting + '. El planificador elige entre hasta 8 por ciclo.' : 'Creá una tarjeta para poner el tablero en marcha.';
  byId('cycle-panel').dataset.active = String(board.active);
  setText(byId('cycle-title'), phases[phase] ?? 'Ciclo en espera');
  let description = phase ? [current?.title, progress].filter(Boolean).join(' · ') : idle;
  if (phase === 'stopping') description = [current?.title, 'Esperando que el CLI termine'].filter(Boolean).join(' · ');
  setText(byId('cycle-summary'), loaded ? description : 'Conexión con el tablero local pendiente.');
  for (const step of byId('cycle-stages').children) {
    if (step.dataset.phase === phase) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }
}

function controls() {
  for (const id of ['new-card', 'card-search', 'state-filter']) byId(id).disabled = !loaded;
  const run = byId('run');
  const pending = board.cards.some(card => card.status === 'pending');
  const interrupted = !board.active && board.cards.some(card => card.status === 'working' || card.status === 'review');
  run.hidden = board.active;
  run.disabled = !loaded || starting || (!pending && !interrupted);
  setText(run.lastChild, interrupted && !pending ? ' Recuperar tablero' : ' Iniciar ciclo');
  const stop = byId('stop');
  stop.hidden = !board.active;
  stop.disabled = stopping || board.cycle?.phase === 'stopping';
  setText(stop.lastChild, stop.disabled ? ' Deteniendo…' : ' Detener');
  byId('retry').disabled = !loaded || retrying || board.active;
  const connection = byId('connection');
  connection.dataset.active = String(board.active);
  setText(connection.lastElementChild, loaded ? (board.active ? 'Ciclo activo' : 'Tablero local') : 'Sin conexión');
  for (const button of document.querySelectorAll('button[data-lock-cycle]')) {
    button.disabled = !loaded || board.active || starting || retrying;
  }
  renderCycle();
}

function quickButton(card, action, label, lockDuringCycle = true) {
  const button = make('button', 'quick-action', label);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.target = card.id;
  button.setAttribute('aria-label', label + ' «' + card.title + '»');
  if (lockDuringCycle) button.dataset.lockCycle = '';
  return button;
}

function cardTile(card) {
  const tile = make('article', 'card-tile');
  if (board.cycle?.cardId === card.id) tile.dataset.current = 'true';
  const button = make('button', 'card');
  button.type = 'button';
  button.dataset.card = card.id;
  button.setAttribute('aria-label', 'Abrir tarjeta: ' + card.title);
  button.append(make('strong', '', card.title), make('span', 'card-summary', card.brief));
  const meta = make('span', 'card-meta');
  const count = card.requiredTerms.length;
  meta.append(make('span', '', count + (count === 1 ? ' criterio' : ' criterios')));
  if (card.attempts) meta.append(make('span', '', card.attempts + (card.attempts === 1 ? ' intento' : ' intentos')));
  button.append(meta);
  const execution = lastExecution(card);
  if (execution) {
    const model = make('span', 'card-model', modelLabel(execution.model));
    model.title = execution.model;
    button.append(model);
  }
  if (card.status === 'blocked') {
    const last = card.events.at(-1);
    if (last?.role === 'system') button.append(make('span', 'card-blocked-note', last.message));
  }
  tile.append(button);
  const actions = make('div', 'card-actions');
  if (card.status === 'pending') actions.append(quickButton(card, 'run', 'Ejecutar'));
  if (isPendingEdit(card)) actions.append(quickButton(card, 'edit', 'Editar'));
  if (card.status === 'blocked') actions.append(quickButton(card, 'retry', 'Volver a pendientes'));
  if (card.status === 'done' && card.artifact) actions.append(quickButton(card, 'copy', 'Copiar Markdown', false));
  if (actions.children.length) tile.append(actions);
  return tile;
}

function focusCard(id) {
  const button = [...document.querySelectorAll('button[data-card]')].find(item => item.dataset.card === id);
  button?.focus({ preventScroll: true });
}

function columnItems(list, status, matches, filtered) {
  list.replaceChildren(...matches.map(cardTile));
  if (!matches.length) list.append(make('p', 'empty', filtered ? 'Sin coincidencias en este estado.' : columns.get(status).empty));
}

function renderCards() {
  const active = document.activeElement?.dataset;
  const search = searchable(byId('card-search').value.trim());
  const state = byId('state-filter').value;
  const filtered = Boolean(search || state !== 'all');
  const matches = board.cards.filter(card => (state === 'all' || card.status === state)
    && (!search || searchable([card.title, card.brief, ...card.requiredTerms].join(' ')).includes(search)));
  byId('reset-filters').hidden = !filtered;
  if (loaded) {
    const total = board.cards.length === 1 ? '1 tarjeta' : `${board.cards.length} tarjetas`;
    setText(byId('filter-summary'), filtered ? `${matches.length} de ${total}` : total);
  }
  const groups = [];
  for (const [status, { label }] of columns) {
    const visible = state === 'all' || state === status;
    const cards = matches.filter(card => card.status === status);
    if (status === 'blocked') {
      byId('blocked').hidden = !visible || (state === 'all' && !cards.length);
      byId('blocked-count').textContent = cards.length;
      columnItems(byId('blocked-cards'), status, cards, filtered);
      continue;
    }
    if (!visible) continue;
    const column = make('section', 'column');
    column.dataset.state = status;
    const header = make('div', 'column-heading');
    const title = make('h3', '', label);
    title.id = 'column-' + status;
    column.setAttribute('aria-labelledby', title.id);
    const dot = make('span', 'dot');
    dot.setAttribute('aria-hidden', 'true');
    header.append(dot, title, make('span', 'count', cards.length));
    const list = make('div', 'column-list');
    columnItems(list, status, cards, filtered);
    column.append(header, list);
    groups.push(column);
  }
  const container = byId('columns');
  container.dataset.filtered = String(state !== 'all');
  container.hidden = !groups.length;
  container.replaceChildren(...groups);
  controls();
  document.dispatchEvent(new Event('kanban:cards-rendered'));
  if (active?.card) focusCard(active.card);
  if (active?.action) {
    const button = [...document.querySelectorAll('button[data-action]')].find(item =>
      item.dataset.action === active.action && item.dataset.target === active.target);
    if (button?.disabled === false) button.focus({ preventScroll: true });
    else focusCard(active.target);
  }
}

function renderTimeline(card) {
  const timeline = byId('detail-events');
  const activeReceipt = document.activeElement?.closest('.receipt');
  const focusReceipt = activeReceipt?.dataset.receipt;
  const focusCopy = document.activeElement?.hasAttribute('data-copy-receipt');
  const openReceipts = new Set([...timeline.querySelectorAll('details[open]')].map(item => item.dataset.receipt));
  const events = card.events.map(event => {
    const item = make('li', 'event');
    const heading = make('div', 'event-head');
    heading.append(make('strong', '', roles[event.role] || event.role));
    const date = new Date(event.at);
    if (!Number.isNaN(date.valueOf())) {
      const time = make('time', '', formatter.format(date));
      time.dateTime = date.toISOString();
      heading.append(time);
    }
    item.append(heading, make('p', 'preserve', event.message));
    if (event.execution) {
      const { model, durationMs, receiptId } = event.execution;
      const seconds = secondsFormat.format(durationMs / 1000) + ' s';
      const trace = make('details', 'receipt');
      const copy = make('button', 'button secondary compact', 'Copiar recibo');
      copy.type = 'button';
      copy.dataset.copyReceipt = receiptId;
      copy.setAttribute('aria-label', 'Copiar recibo ' + receiptId);
      const receipt = make('div', 'receipt-row');
      receipt.append(make('code', '', receiptId), copy);
      trace.append(make('summary', '', `${model} · ${seconds}`), receipt);
      trace.dataset.receipt = receiptId;
      trace.open = openReceipts.has(receiptId);
      item.append(trace);
    }
    return item;
  });
  if (!events.length) events.push(make('li', 'muted', 'Todavía no hay actividad.'));
  timeline.replaceChildren(...events);
  if (focusReceipt) {
    const replacement = [...timeline.querySelectorAll('details')].find(item => item.dataset.receipt === focusReceipt);
    replacement?.querySelector(focusCopy ? 'button' : 'summary')?.focus({ preventScroll: true });
  }
}

function showDetails(card) {
  const state = byId('detail-status');
  setText(state, cardStates[card.status]);
  state.dataset.state = card.status;
  setText(byId('detail-title'), card.title);
  const model = lastExecution(card)?.model;
  const summary = [card.attempts ? `${card.attempts} de 2 intentos en el último ciclo` : '', model ? `Último modelo · ${model}` : ''].filter(Boolean);
  setText(byId('detail-summary'), summary.join(' · '));
  byId('detail-summary').hidden = !summary.length;
  setText(byId('detail-brief'), card.brief);
  byId('detail-terms').replaceChildren(...card.requiredTerms.map(term => make('li', '', term)));
  const artifact = byId('detail-artifact');
  setText(artifact, card.artifact || 'El documento aparecerá cuando haya un borrador.');
  artifact.classList.toggle('muted', !card.artifact);
  const artifactStatus = card.status === 'done' ? 'Aprobado' : 'Borrador sin aprobar';
  setText(byId('artifact-status'), card.artifact ? artifactStatus : '');
  byId('copy-markdown').hidden = !card.artifact;
  const compare = byId('compare-draft');
  compare.hidden = !card.initialDraft || card.initialDraft === card.artifact;
  setText(byId('detail-initial-draft'), compare.hidden ? '' : card.initialDraft);
  const checks = card.checks.map(check => {
    const item = make('li');
    const result = make('span', check.passed ? 'result' : 'result fail', check.passed ? 'Pasó' : 'Falló');
    item.append(result, make('span', '', check.name));
    return item;
  });
  if (!checks.length) checks.push(make('li', 'muted', 'Todavía no se ejecutaron pruebas.'));
  byId('detail-checks').replaceChildren(...checks);
  const review = card.events.findLast(event => event.role === 'reviewer');
  const outcome = byId('detail-review');
  setText(outcome, review?.message ?? 'Todavía no hay dictamen.');
  outcome.classList.toggle('muted', !review);
  renderTimeline(card);
  byId('run-card').hidden = card.status !== 'pending';
  byId('edit-card').hidden = !isPendingEdit(card);
  byId('retry').hidden = card.status !== 'blocked';
}

async function refresh() {
  const sequence = ++refreshId;
  try {
    const next = await bridge.snapshot();
    if (sequence !== refreshId) return;
    board = next;
    if (!loaded) report('error');
    loaded = true;
    const card = selectedCard();
    if (card) showDetails(card);
    renderCards();
  } catch (error) {
    if (sequence !== refreshId) return;
    loaded = false;
    report('error', error);
    controls();
  }
}

function openForm(card = null, mode = 'create') {
  editing = mode === 'edit' ? card.id : null;
  byId('create-form').dataset.excludeId = editing ?? '';
  byId('create-form').reset();
  const labels = { create: ['Nueva tarjeta', 'Crear tarjeta'], edit: ['Editar tarjeta', 'Guardar cambios'], duplicate: ['Duplicar tarjeta', 'Crear copia'] };
  const [heading, submit] = labels[mode];
  setText(byId('create-heading'), heading);
  setText(byId('submit-card'), submit);
  if (card) {
    const suffix = ' (copia)';
    byId('title').value = mode === 'duplicate' ? card.title.slice(0, 120 - suffix.length) + suffix : card.title;
    byId('brief').value = card.brief;
    byId('terms').value = card.requiredTerms.join('\n');
    byId('initial-draft').value = card.initialDraft ?? '';
  }
  report('form-error');
  if (byId('detail-dialog').open) byId('detail-dialog').close();
  byId('create-dialog').showModal();
  document.dispatchEvent(new Event('kanban:form-shown'));
}

function openCard(id) {
  const card = board.cards.find(item => item.id === id);
  if (!card) return;
  selected = card.id;
  byId('compare-draft').open = false;
  report('retry-error');
  report('detail-notice');
  showDetails(card);
  controls();
  byId('detail-dialog').showModal();
}

document.addEventListener('kanban:open-card', event => openCard(event.detail));

async function runCard(id, errorTarget = 'error') {
  if (starting || board.active) return;
  starting = true;
  controls();
  report(errorTarget);
  report('action-notice');
  try {
    if (id === undefined) await bridge.run();
    else await bridge.run(id);
  } catch (error) {
    report(errorTarget, error);
  } finally {
    starting = false;
    await refresh();
  }
}

async function retryCard(id, errorTarget = 'error') {
  if (retrying || starting || board.active) return;
  retrying = true;
  controls();
  report(errorTarget);
  try {
    await bridge.retry(id);
    if (byId('detail-dialog').open) byId('detail-dialog').close();
    byId('state-filter').value = 'all';
    report('action-notice', 'La tarjeta volvió a Pendientes.');
  } catch (error) {
    report(errorTarget, error);
  } finally {
    retrying = false;
    await refresh();
  }
}

async function copy(cardId, receiptId, detail = false) {
  const errorTarget = detail ? 'retry-error' : 'error';
  const noticeTarget = detail ? 'detail-notice' : 'action-notice';
  report(errorTarget);
  report(noticeTarget);
  try {
    if (receiptId === undefined) await bridge.copy(cardId);
    else await bridge.copy(cardId, receiptId);
    report(noticeTarget, receiptId === undefined ? 'Markdown copiado.' : 'Identificador del recibo copiado.');
  } catch (error) {
    report(errorTarget, error);
  }
}

document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]');
  if (close) return close.closest('dialog').close();
  const receipt = event.target.closest('[data-copy-receipt]');
  if (receipt) return void copy(selected, receipt.dataset.copyReceipt, true);
  const action = event.target.closest('button[data-action]');
  if (action) {
    const card = board.cards.find(item => item.id === action.dataset.target);
    if (!card) return;
    if (action.dataset.action === 'run') return void runCard(card.id);
    if (action.dataset.action === 'edit') return openForm(card, 'edit');
    if (action.dataset.action === 'copy') return void copy(card.id);
    if (action.dataset.action === 'retry') return void retryCard(card.id);
  }
  const card = event.target.closest('button[data-card]');
  if (card) openCard(card.dataset.card);
});

byId('detail-dialog').addEventListener('close', () => {
  if (!byId('detail-dialog').open) {
    focusCard(selected);
    selected = null;
  }
});
byId('help').addEventListener('click', () => byId('help-dialog').showModal());
byId('new-card').addEventListener('click', () => openForm());
byId('card-search').addEventListener('input', renderCards);
byId('state-filter').addEventListener('change', renderCards);
byId('reset-filters').addEventListener('click', () => {
  byId('card-search').value = '';
  byId('state-filter').value = 'all';
  renderCards();
  byId('card-search').focus();
});
document.addEventListener('keydown', event => {
  if (!loaded || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat
      || event.target !== document.body || document.querySelector('dialog[open]')) return;
  if (event.key === '/') {
    event.preventDefault();
    byId('card-search').focus();
  }
});

byId('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (byId('submit-card').disabled) return;
  const title = byId('title').value.trim();
  const brief = byId('brief').value.trim();
  const requiredTerms = byId('terms').value.split(/\r?\n/).map(term => term.trim()).filter(Boolean);
  if (!title || !brief) return report('form-error', 'Completá el título y la consigna.');
  if (!requiredTerms.length || requiredTerms.length > 8 || requiredTerms.some(term => term.length > 80)) {
    return report('form-error', 'Ingresá de 1 a 8 términos de hasta 80 caracteres cada uno.');
  }
  byId('submit-card').disabled = true;
  report('form-error');
  const id = editing;
  try {
    const input = { title, brief, requiredTerms };
    const draft = byId('initial-draft').value;
    if (draft.trim()) input.initialDraft = draft;
    const saved = id ? await bridge.edit(id, input) : await bridge.create(input);
    byId('create-dialog').close();
    report('action-notice', id ? 'Cambios guardados.' : 'Tarjeta creada.');
    await refresh();
    focusCard(saved.id);
  } catch (error) {
    report('form-error', error);
  } finally {
    byId('submit-card').disabled = false;
  }
});

byId('run').addEventListener('click', () => void runCard());
byId('run-card').dataset.lockCycle = '';
byId('run-card').addEventListener('click', () => {
  const id = selected;
  byId('detail-dialog').close();
  void runCard(id);
});
byId('edit-card').dataset.lockCycle = '';
byId('edit-card').addEventListener('click', () => openForm(selectedCard(), 'edit'));
byId('duplicate-card').addEventListener('click', () => openForm(selectedCard(), 'duplicate'));
byId('copy-markdown').addEventListener('click', () => void copy(selected, undefined, true));
byId('retry').addEventListener('click', () => void retryCard(selected, 'retry-error'));
byId('stop').addEventListener('click', async () => {
  stopping = true;
  controls();
  report('error');
  try { await bridge.stop(); } catch (error) { report('error', error); }
  finally { stopping = false; await refresh(); }
});

if (bridge) {
  const unsubscribe = bridge.onChange(refresh);
  window.addEventListener('beforeunload', unsubscribe, { once: true });
  void refresh();
} else {
  controls();
  report('error', 'Abrí este tablero con la aplicación de escritorio.');
}
