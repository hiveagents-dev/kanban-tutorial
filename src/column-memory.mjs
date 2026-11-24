import { rankMemories } from 'hiveagents-runtime/orchestration/memory';

const LIMIT = 3;
const statusRoles = new Map([
  ['pending', ['planner']],
  ['working', ['writer']],
  ['review', ['checks', 'reviewer']],
  ['done', ['reviewer']],
  ['blocked', ['system']],
]);
const commonWords = new Set(`
  al alguna algun algo ante antes are apenas asi aun bajo bien cada casi como con contra cual cuando cuya cuyo
  dan dar das de del desde despues donde dos durante ella ellas ellos entre era eran eres esa esas ese eso esos
  esta estan estar estas este esto estos fue fueron guia hacer hace hacia hasta hay igual incluso la las le les
  lo los mas me menos mi mientras muy nos nuestro nueva nuevo otra otro para pero por porque primera primero
  que quien respecto sea se segun ser si sin sobre solo son su sus tarea tablero tarjeta tiene tienen todo
  tras tres tu tus un una uno unas unos usa usar usted ustedes ya
  add and are about but by card create edit for from guide how into is its new of on or task the their
  this to update use what when with you your
`.trim().split(/\s+/));
const termsInList = new Intl.ListFormat('es-AR', { type: 'conjunction' });

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}

function tokens(text) {
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function words(text) {
  return tokens(text).filter(item => item.length > 2 && item.length <= 48 && !commonWords.has(item));
}

function searchFields(input) {
  const title = clip(input?.title, 120);
  const brief = clip(input?.brief, 2000);
  const terms = Array.isArray(input?.requiredTerms)
    ? input.requiredTerms.slice(0, 8).map(term => clip(term, 80)).join(' ')
    : '';
  const titleWords = words(title);
  const allWords = [...titleWords, ...words(terms), ...words(brief)];
  return {
    exactTitle: tokens(title).join(' '),
    titleWords: new Set(titleWords),
    words: new Set(allWords),
    // The SDK ranks matches while repeating title terms gives titles extra weight.
    text: [...titleWords, ...allWords].join(' '),
  };
}

function commonWith(query, topic) {
  const overlap = [...query.words].filter(word => topic.words.has(word));
  const titleHits = [...query.titleWords].filter(word => topic.titleWords.has(word)).length;
  const coverage = overlap.length / Math.min(query.words.size, topic.words.size);
  const relevant = titleHits >= 2
    || (overlap.length >= 2 && coverage >= 0.45)
    || (overlap.length >= 3 && coverage >= 0.3);
  return relevant ? overlap.slice(0, 3) : [];
}

function matchingCards(cards, input, excludeId) {
  const query = searchFields(input);
  const exact = [];
  const candidates = [];
  for (const card of cards) {
    if (card.id === excludeId) continue;
    const topic = searchFields(card);
    if (query.exactTitle && query.exactTitle === topic.exactTitle) {
      exact.push({ card, reason: 'El título coincide.' });
    } else if (query.words.size > 1 && topic.words.size > 1) {
      const overlap = commonWith(query, topic);
      if (overlap.length) {
        const terms = termsInList.format(overlap.map(word => `«${word}»`));
        candidates.push({ id: card.id, text: topic.text, card, reason: `Coincide en ${terms}.` });
      }
    }
  }
  const ranked = rankMemories(query.text, candidates, { limit: LIMIT }).map(({ record }) => record);
  return [...exact, ...ranked].slice(0, LIMIT);
}

function reference({ card, reason }) {
  return { id: card.id, title: card.title, status: card.status, reason };
}

// Preview reads only the request and cards. It does not mutate the board or dispatch a model.
export function findSimilarCards(cards, input, { excludeId } = {}) {
  return matchingCards(cards, input, excludeId).map(reference);
}

export function columnContext(cards, column, input, { excludeId } = {}) {
  const roles = statusRoles.get(column);
  if (!roles) throw new RangeError('La columna de memoria no existe.');
  const liveOnly = column === 'done' || column === 'blocked';
  const evidence = card => card.events.findLast(event => roles.includes(event.role));
  const visible = cards.filter(card => card.status === column || (!liveOnly && evidence(card)));
  return matchingCards(visible, input, excludeId).map(match => {
    const note = clip(evidence(match.card)?.message, 220);
    return { ...reference(match), ...(note ? { evidence: note } : {}) };
  });
}
