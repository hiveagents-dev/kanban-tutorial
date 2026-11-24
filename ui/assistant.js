'use strict';

(() => {
  const bridge = window.kanban;
  const byId = id => document.getElementById(id);
  const dialog = byId('assistant-dialog');
  const form = byId('assistant-form');
  const field = byId('assistant-message');
  const thread = byId('assistant-thread');
  const scroll = byId('assistant-thread-scroll');
  const cardForm = byId('create-form');
  const cardDialog = byId('create-dialog');
  const related = byId('related-cards');
  const stateLabels = {
    pending: 'Pendiente', working: 'En curso', review: 'En revisión', done: 'Terminada', blocked: 'Bloqueada',
  };
  const roleLabels = { user: 'Vos', assistant: 'Asistente', system: 'Sistema' };
  const pendingLabels = { retry: 'Devolver a Pendientes', run: 'Ejecutar la tarjeta', retryAndRun: 'Reintentar y ejecutar' };
  const decisionLabels = {
    applied: 'Acción aplicada', dismissed: 'Propuesta descartada', expired: 'La tarjeta cambió',
    applying: 'Aplicando acción…', failed: 'La acción encontró un problema',
  };
  const timestamp = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  const duration = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
  let snapshot = { alerts: [], messages: [], busy: false };
  let ready = false;
  let reply = null;
  let submitting = false;
  let deciding = false;
  let sequence = 0;
  let similaritySequence = 0;
  let previousAlerts;
  let previousMessages;
  let previousMatches;
  let similarityTimer;

  function make(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  }

  function button(label, style = 'secondary') {
    const element = make('button', 'button compact ' + style, label);
    element.type = 'button';
    return element;
  }

  function message(id, text) {
    const node = byId(id);
    if (node.textContent !== text) node.textContent = text;
    return node;
  }

  function report(error) {
    const text = error ? String(error.message ?? error)
      .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '';
    message('assistant-error', text).hidden = !text;
  }

  function controls() {
    const busy = snapshot.busy || submitting || deciding;
    const alertChanged = reply && ready && !snapshot.alerts.some(alert => alert.id === reply.id);
    byId('assistant-send').disabled = !ready || busy || !field.value.trim() || Boolean(alertChanged);
    for (const action of thread.querySelectorAll('[data-proposal-decision]')) action.disabled = !ready || busy;
    byId('assistant-reply').hidden = !reply;
    message('assistant-reply-text', reply ? (
      alertChanged ? 'La alerta cambió. Quitá la referencia o elegí otra alerta.'
        : 'Respondiendo a la alerta de «' + reply.title + '»'
    ) : '');
    for (const action of byId('assistant-alerts').querySelectorAll('[data-alert-reply]')) {
      action.setAttribute('aria-pressed', String(reply?.id === action.dataset.alertReply));
    }
    message('assistant-status', busy ? (deciding ? 'Aplicando la acción…' : 'Esperando al asistente…')
      : 'Las alertas se calculan localmente. Enviar un mensaje usa tu CLI.');
  }

  function markCards() {
    const marked = new Set(snapshot.alerts.map(alert => alert.cardId));
    for (const card of document.querySelectorAll('button[data-card]')) {
      const alertId = 'card-alert-' + card.dataset.card;
      const existing = card.querySelector('.card-alert');
      if (marked.has(card.dataset.card)) {
        if (!existing) {
          const flag = make('span', 'card-alert', 'Tiene una alerta');
          flag.id = alertId;
          // Keep the existing accessible name and attach an additional description.
          card.append(flag);
        }
        card.setAttribute('aria-describedby', alertId);
      } else if (existing) {
        existing.remove();
        card.removeAttribute('aria-describedby');
      }
    }
  }

  function showAlerts() {
    const count = snapshot.alerts.length;
    const countLabel = count === 1 ? '1 alerta' : count + ' alertas';
    message('assistant-count', String(count)).hidden = !count;
    byId('assistant-open').setAttribute('aria-label', count ? 'Asistente del tablero · ' + countLabel : 'Asistente del tablero');
    message('assistant-alerts-total', String(count));
    byId('board-alert-strip').hidden = !count;
    message('board-alert-summary', countLabel + ' en el tablero');
    message('assistant-no-alerts', 'No hay alertas activas.').hidden = Boolean(count);
    const items = snapshot.alerts.map(alert => {
      const item = make('li', 'assistant-alert');
      item.dataset.level = alert.level;
      item.append(make('strong', '', alert.title));
      if (alert.message !== alert.title) item.append(make('p', '', alert.message));

      const actions = make('div', 'assistant-item-actions');
      const respond = button('Responder');
      respond.dataset.alertReply = alert.id;
      respond.setAttribute('aria-label', 'Responder alerta de ' + alert.title);
      actions.append(respond);
      if (alert.cardId) {
        const view = button('Ver tarjeta');
        view.dataset.alertCard = alert.cardId;
        view.setAttribute('aria-label', 'Ver tarjeta de la alerta de ' + alert.title);
        actions.append(view);
      }
      item.append(actions);
      return item;
    });
    byId('assistant-alerts').replaceChildren(...items);
    markCards();
  }

  function showProposal(proposal) {
    const card = make('div', 'assistant-proposal');
    const action = pendingLabels[proposal.kind] ?? 'Acción sobre la tarjeta';
    card.dataset.status = proposal.status;
    card.append(make('strong', '', proposal.title || action));
    if (proposal.status === 'pending') {
      const choices = make('div', 'assistant-item-actions');
      for (const [decision, label, style] of [['confirm', 'Confirmar', 'primary'], ['dismiss', 'Descartar', 'secondary']]) {
        const choice = button(label, style);
        choice.dataset.proposalDecision = decision;
        choice.dataset.proposalId = proposal.id;
        choices.append(choice);
      }
      card.append(choices);
    } else {
      const outcome = decisionLabels[proposal.status];
      if (outcome) card.append(make('p', 'hint', outcome));
    }
    return card;
  }

  function showMessage(entry) {
    const item = make('li', 'assistant-entry');
    item.dataset.role = entry.role;
    const head = make('div', 'assistant-entry-meta');
    head.append(make('strong', '', roleLabels[entry.role] ?? 'Sistema'));
    const date = new Date(entry.at);
    if (!Number.isNaN(date.valueOf())) {
      const time = make('time', '', timestamp.format(date));
      time.dateTime = date.toISOString();
      head.append(time);
    }
    if (entry.alertId && entry.role === 'user') {
      const alert = snapshot.alerts.find(item => item.id === entry.alertId);
      const title = entry.alertTitle ?? alert?.title;
      head.append(make('span', 'assistant-reply-tag', title ? 'Alerta · ' + title : 'Respuesta a una alerta'));
    }
    item.append(head, make('p', 'assistant-entry-text', entry.text));
    if (entry.execution) {
      const details = make('details', 'assistant-execution');
      const seconds = duration.format(entry.execution.durationMs / 1000);
      details.append(make('summary', '', entry.execution.model + ' · ' + seconds + ' s'),
        make('code', '', entry.execution.receiptId));
      item.append(details);
    }
    if (entry.proposal) item.append(showProposal(entry.proposal));
    return item;
  }

  function showThread() {
    const nearEnd = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 55;
    const openReceipts = new Set([...thread.querySelectorAll('details[open]')].map(node => node.parentElement.dataset.messageId));
    byId('assistant-thread-empty').hidden = Boolean(snapshot.messages.length);
    const entries = snapshot.messages.map(entry => {
      const element = showMessage(entry);
      element.dataset.messageId = entry.id;
      if (openReceipts.has(entry.id)) element.querySelector('details').open = true;
      return element;
    });
    thread.replaceChildren(...entries);
    if (nearEnd) scroll.scrollTop = scroll.scrollHeight;
  }

  async function refreshAssistant() {
    const request = ++sequence;
    try {
      const next = await bridge.assistantSnapshot();
      if (request !== sequence) return;
      snapshot = next;
      if (!ready) report();
      ready = true;
      const alerts = JSON.stringify(snapshot.alerts);
      const messages = JSON.stringify(snapshot.messages);
      if (previousAlerts !== alerts) {
        previousAlerts = alerts;
        showAlerts();
      }
      if (previousMessages !== messages) {
        previousMessages = messages;
        showThread();
      }
    } catch (error) {
      if (request !== sequence) return;
      ready = false;
      report(error);
    }
    controls();
  }

  async function openAssistant() {
    if (!dialog.open) dialog.showModal();
    await refreshAssistant();
    scroll.scrollTop = scroll.scrollHeight;
  }

  function openCard(id) {
    document.dispatchEvent(new CustomEvent('kanban:open-card', { detail: id }));
  }

  byId('assistant-open').addEventListener('click', () => void openAssistant());
  byId('board-view-alerts').addEventListener('click', () => {
    byId('assistant-alerts-section').open = true;
    void openAssistant();
  });
  byId('assistant-cancel-reply').addEventListener('click', () => {
    reply = null;
    controls();
    field.focus();
  });
  byId('assistant-alerts').addEventListener('click', event => {
    const respond = event.target.closest('[data-alert-reply]');
    const card = event.target.closest('[data-alert-card]');
    if (respond) {
      reply = snapshot.alerts.find(alert => alert.id === respond.dataset.alertReply) ?? null;
      report();
      controls();
      field.focus();
    } else if (card) {
      dialog.close();
      openCard(card.dataset.alertCard);
    }
  });

  field.addEventListener('input', controls);
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (byId('assistant-send').disabled) return;
    const text = field.value.trim();
    const alert = reply;
    submitting = true;
    report();
    controls();
    try {
      await bridge.askAssistant({ text, ...(alert && { alertId: alert.id }) });
      if (field.value.trim() === text) field.value = '';
      if (reply?.id === alert?.id) reply = null;
    } catch (error) {
      report(error);
    } finally {
      submitting = false;
      await refreshAssistant();
      if (dialog.open && !dialog.contains(document.activeElement)) field.focus();
    }
  });

  thread.addEventListener('click', async event => {
    const choice = event.target.closest('[data-proposal-decision]');
    if (!choice || choice.disabled) return;
    deciding = true;
    report();
    controls();
    try {
      await bridge.decideAssistant({ id: choice.dataset.proposalId, confirm: choice.dataset.proposalDecision === 'confirm' });
    } catch (error) {
      report(error);
    } finally {
      deciding = false;
      await refreshAssistant();
      if (dialog.open && !choice.isConnected) field.focus();
    }
  });

  function updateSimilarCards(matches) {
    const list = byId('related-list');
    const signature = JSON.stringify(matches);
    if (previousMatches === signature) return;
    previousMatches = signature;
    related.hidden = !matches.length;
    list.replaceChildren(...matches.map(card => {
      const item = make('li', 'related-card');
      const info = make('div', 'related-card-info');
      const title = make('div', 'related-card-title');
      const state = make('span', 'related-state', stateLabels[card.status] ?? '');
      state.dataset.state = card.status;
      title.append(make('strong', '', card.title), state);
      info.append(title, make('p', 'hint', card.reason));
      const view = button('Ver tarjeta');
      view.dataset.relatedCard = card.id;
      view.setAttribute('aria-label', 'Ver tarjeta parecida ' + card.title);
      item.append(info, view);
      return item;
    }));
  }

  async function refreshSimilar(request) {
    const title = byId('title').value.trim();
    const brief = byId('brief').value.trim();
    const requiredTerms = byId('terms').value.split(/\r?\n/).map(term => term.trim())
      .filter(term => term && term.length <= 80).slice(0, 8);
    if (title.length < 3 && brief.length < 8 && requiredTerms.length === 0) {
      updateSimilarCards([]);
      return;
    }
    const excludeId = cardForm.dataset.excludeId;
    try {
      const matches = await bridge.findSimilar({ title, brief, requiredTerms, ...(excludeId && { excludeId }) });
      if (request === similaritySequence && cardDialog.open) updateSimilarCards(matches);
    } catch {
      // The suggestion surface is optional. Card creation can proceed independently.
      if (request === similaritySequence && cardDialog.open) updateSimilarCards([]);
    }
  }

  function scheduleSimilar() {
    clearTimeout(similarityTimer);
    const request = ++similaritySequence;
    similarityTimer = setTimeout(() => void refreshSimilar(request), 220);
  }

  document.addEventListener('kanban:form-shown', () => {
    updateSimilarCards([]);
    scheduleSimilar();
  });
  cardForm.addEventListener('input', event => {
    if (event.target.matches('#title, #brief, #terms')) scheduleSimilar();
  });
  cardDialog.addEventListener('close', () => {
    clearTimeout(similarityTimer);
    similaritySequence++;
  });
  related.addEventListener('click', event => {
    const card = event.target.closest('[data-related-card]');
    if (card) openCard(card.dataset.relatedCard);
  });

  if (!bridge || typeof bridge.assistantSnapshot !== 'function') return;
  byId('assistant-open').hidden = false;
  const unsubscribe = bridge.onChange(() => {
    void refreshAssistant();
    if (cardDialog.open) scheduleSimilar();
  });
  const localRefresh = setInterval(() => void refreshAssistant(), 60_000);
  document.addEventListener('kanban:cards-rendered', markCards);
  window.addEventListener('beforeunload', () => {
    unsubscribe();
    clearInterval(localRefresh);
    clearTimeout(similarityTimer);
  }, { once: true });
  void refreshAssistant();
})();
