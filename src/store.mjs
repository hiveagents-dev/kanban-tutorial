import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const tutorialCard = Object.freeze({
  title: 'Preparar una tarjeta verificable',
  brief: 'Escribí una guía breve para quien abre su primera tarjeta en este tablero. Explicá cómo describir el entregable, elegir términos comprobables y revisar el resultado. Incluí un ejemplo concreto de una tarjeta para documentar un producto.',
  requiredTerms: Object.freeze(['Criterios de aceptación', 'Evidencia']),
});

const statuses = new Set(['pending', 'working', 'review', 'done', 'blocked']);
const strings = (values) => Array.isArray(values) && values.every(value => typeof value === 'string');

function validCard(card) {
  return card && typeof card.id === 'string' && typeof card.title === 'string'
    && typeof card.brief === 'string' && strings(card.requiredTerms) && statuses.has(card.status)
    && typeof card.artifact === 'string' && (card.initialDraft === undefined || typeof card.initialDraft === 'string')
    && (card.initialDraftEvaluated === undefined || typeof card.initialDraftEvaluated === 'boolean')
    && Number.isSafeInteger(card.attempts) && card.attempts >= 0
    && Array.isArray(card.events) && card.events.every(event => event && strings([event.role, event.message, event.at]))
    && Array.isArray(card.checks) && card.checks.every(check => check && typeof check.name === 'string' && typeof check.passed === 'boolean');
}

function openJson(directory, name) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, name + '.json');
  return {
    exists: () => existsSync(file),
    load() {
      let source;
      try {
        source = readFileSync(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
      return JSON.parse(source);
    },
    save(data) {
      const temporary = join(directory, `${name}-${randomUUID()}.tmp`);
      try {
        const fd = openSync(temporary, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify(data), 'utf8');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, file);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}

export function openStore(directory) {
  const file = openJson(directory, 'board');
  return {
    exists: file.exists,
    load() {
      const data = file.load();
      if (data === undefined) return [];
      if (data?.version !== 1 || !Array.isArray(data.cards) || !data.cards.every(validCard)
          || new Set(data.cards.map(card => card.id)).size !== data.cards.length) {
        throw new Error('Formato de tablero desconocido o dañado. Conservá board.json para poder recuperarlo.');
      }
      return data.cards;
    },
    save: cards => file.save({ version: 1, cards }),
  };
}

export function openAssistantStore(directory) {
  return openJson(directory, 'assistant');
}
