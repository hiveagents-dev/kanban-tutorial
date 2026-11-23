'use strict';

const bridge = window.kanban;
const byId = (id) => document.getElementById(id);
const states = new Map([
  ['pending', 'Pendientes'],
  ['working', 'En curso'],
  ['review', 'En revisión'],
  ['done', 'Terminadas'],
]);
const cardStates = {
  pending: 'Pendiente', working: 'En curso', review: 'En revisión', done: 'Terminada', blocked: 'Bloqueada',
};
const roles = {
  system: 'Sistema', planner: 'Planificador', writer: 'Redactor', reviewer: 'Revisor', checks: 'Pruebas',
};
const timeFormat = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' });
let board = { cards: [], active: false };
let refreshId = 0;
let selected = null;
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

function report(id, error) {
  const element = byId(id);
  element.textContent = error instanceof Error ? error.message : String(error ?? '');
  element.hidden = !element.textContent;
}

function controls() {
  byId('new-card').disabled = !loaded;
  const run = byId('run');
  const pending = board.cards.some(card => card.status === 'pending');
  const interrupted = !board.active && board.cards.some(card => card.status === 'working' || card.status === 'review');
  run.hidden = board.active;
  run.disabled = !loaded || starting || (!pending && !interrupted);
  run.lastChild.textContent = interrupted && !pending ? ' Recuperar tablero' : ' Iniciar ciclo';
  byId('stop').hidden = !board.active;
  byId('stop').disabled = stopping;
  byId('retry').disabled = retrying || board.active;
  byId('connection').dataset.active = String(board.active);
  const status = byId('connection').lastElementChild;
  status.textContent = loaded ? (board.active ? 'Ciclo activo' : 'En espera') : 'Sin conexión';
}

function cardButton(card) {
  const button = make('button', 'card');
  button.type = 'button';
  button.dataset.card = card.id;
  button.setAttribute('aria-label', 'Abrir tarjeta: ' + card.title);
  button.append(make('strong', '', card.title), make('span', 'card-summary', card.brief));
  const meta = make('span', 'card-meta');
  const count = card.requiredTerms.length;
  meta.append(make('span', '', count + (count === 1 ? ' término' : ' términos')));
  if (card.attempts) meta.append(make('span', '', card.attempts + (card.attempts === 1 ? ' intento' : ' intentos')));
  button.append(meta);
  return button;
}

function renderCards() {
  const focusId = document.activeElement?.dataset.card;
  const columns = [];
  for (const [status, label] of states) {
    const cards = board.cards.filter(card => card.status === status);
    const column = make('section', 'column');
    column.dataset.state = status;
    const heading = make('div', 'column-heading');
    const title = make('h2', '', label);
    title.id = 'column-' + status;
    column.setAttribute('aria-labelledby', title.id);
    heading.append(make('i', 'dot'), title, make('span', 'count', cards.length));
    const list = make('div', 'column-list');
    list.append(...cards.map(cardButton));
    if (cards.length === 0) list.append(make('p', 'empty', 'Sin tarjetas'));
    column.append(heading, list);
    columns.push(column);
  }
  byId('columns').replaceChildren(...columns);
  const blocked = board.cards.filter(card => card.status === 'blocked');
  byId('blocked').hidden = blocked.length === 0;
  byId('blocked-count').textContent = blocked.length;
  byId('blocked-cards').replaceChildren(...blocked.map(cardButton));
  if (focusId) focusCard(focusId);
}

function focusCard(id) {
  const button = [...document.querySelectorAll('button[data-card]')].find(item => item.dataset.card === id);
  button?.focus({ preventScroll: true });
}

function showDetails() {
  const card = board.cards.find(item => item.id === selected);
  if (!card) return;
  byId('detail-status').textContent = cardStates[card.status];
  byId('detail-title').textContent = card.title;
  byId('detail-brief').textContent = card.brief;
  byId('detail-terms').replaceChildren(...card.requiredTerms.map(term => make('li', '', term)));
  const artifact = byId('detail-artifact');
  const markdown = card.artifact || 'El entregable aparecerá después de la redacción.';
  if (artifact.textContent !== markdown) artifact.textContent = markdown;
  artifact.classList.toggle('muted', !card.artifact);
  const compare = byId('compare-draft');
  compare.hidden = !card.initialDraft || card.initialDraft === card.artifact;
  const original = byId('detail-initial-draft');
  const draft = compare.hidden ? '' : card.initialDraft;
  if (original.textContent !== draft) original.textContent = draft;
  const checks = card.checks.map(check => {
    const item = make('li');
    item.append(make('span', check.passed ? 'result' : 'result fail', check.passed ? 'Pasó' : 'Falló'), make('span', '', check.name));
    return item;
  });
  if (!checks.length) checks.push(make('li', 'muted', 'Todavía no se ejecutaron pruebas.'));
  byId('detail-checks').replaceChildren(...checks);
  const timeline = byId('detail-events');
  const openReceipts = new Set([...timeline.querySelectorAll('details[open]')].map(item => item.dataset.receipt));
  const events = card.events.map(event => {
    const item = make('li');
    const heading = make('div', 'event-head');
    heading.append(make('strong', '', roles[event.role] || event.role));
    const date = new Date(event.at);
    if (!Number.isNaN(date.valueOf())) {
      const time = make('time', '', timeFormat.format(date));
      time.dateTime = date.toISOString();
      heading.append(time);
    }
    item.append(heading, make('p', 'preserve', event.message));
    if (event.execution) {
      const { model, durationMs, receiptId } = event.execution;
      const seconds = Number.isFinite(durationMs) ? (durationMs / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' s' : '';
      const trace = make('details', 'receipt');
      trace.append(make('summary', '', [model, seconds].filter(Boolean).join(' · ') || 'Ejecución'));
      trace.append(make('code', '', 'Recibo ' + receiptId));
      trace.dataset.receipt = receiptId;
      trace.open = openReceipts.has(receiptId);
      item.append(trace);
    }
    return item;
  });
  if (!events.length) events.push(make('li', 'muted', 'Todavía no hay actividad.'));
  timeline.replaceChildren(...events);
  byId('retry').hidden = card.status !== 'blocked';
}

async function refresh() {
  const sequence = ++refreshId;
  try {
    const next = await bridge.snapshot();
    if (sequence !== refreshId) return;
    board = next;
    loaded = true;
    renderCards();
    if (selected) showDetails();
  } catch (error) {
    if (sequence !== refreshId) return;
    loaded = false;
    report('error', error);
  }
  controls();
}

document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]');
  if (close) return close.closest('dialog').close();
  const card = event.target.closest('button[data-card]');
  if (!card) return;
  selected = card.dataset.card;
  byId('compare-draft').open = false;
  report('retry-error');
  showDetails();
  byId('detail-dialog').showModal();
});
byId('detail-dialog').addEventListener('close', () => {
  focusCard(selected);
  selected = null;
});

byId('new-card').addEventListener('click', () => {
  byId('create-form').reset();
  report('form-error');
  byId('create-dialog').showModal();
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
  try {
    const input = { title, brief, requiredTerms };
    const draft = byId('initial-draft').value;
    if (draft.trim()) input.initialDraft = draft;
    await bridge.create(input);
    byId('create-dialog').close();
    await refresh();
  } catch (error) {
    report('form-error', error);
  } finally {
    byId('submit-card').disabled = false;
  }
});

byId('run').addEventListener('click', async () => {
  starting = true;
  controls();
  report('error');
  try { await bridge.run(); } catch (error) { report('error', error); }
  finally { starting = false; await refresh(); }
});
byId('stop').addEventListener('click', async () => {
  stopping = true;
  controls();
  report('error');
  try { await bridge.stop(); } catch (error) { report('error', error); }
  finally { stopping = false; await refresh(); }
});
byId('retry').addEventListener('click', async () => {
  retrying = true;
  controls();
  report('retry-error');
  try {
    await bridge.retry(selected);
    byId('detail-dialog').close();
  } catch (error) {
    report('retry-error', error);
  } finally {
    retrying = false;
    await refresh();
  }
});

if (bridge) {
  const unsubscribe = bridge.onChange(refresh);
  window.addEventListener('beforeunload', unsubscribe, { once: true });
  void refresh();
} else {
  controls();
  report('error', 'Abrí este tablero con la aplicación de escritorio.');
}
