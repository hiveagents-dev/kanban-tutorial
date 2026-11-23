// Dos redactores de prueba permiten observar cómo cambia la selección sin consumir modelos.
import assert from 'node:assert/strict';
import {
  buildSnapshot, DEFAULT_LEARNING_POLICY, learningDigest, predict, sealLearningRecord, selectPolicy,
} from 'hiveagents-runtime/routing/learning';

function candidate(id) {
  const identity = {
    evidenceScope: 'model', provider: 'laboratorio', modelId: id, model: 'laboratorio/' + id,
    optionsDigest: learningDigest({ version: 1 }), executionDigest: learningDigest(id + '-v1'),
  };
  return { id, ...identity, key: learningDigest(identity) };
}

const plain = candidate('texto');
const markdown = candidate('markdown');
const candidates = [plain, markdown];
const features = { schema: 'formato-v1', values: [1, 0] }; // Categoría «documento Markdown».
const domain = learningDigest('kanban/titulo-markdown/v1');
const now = 1_800_000_000_000;
const topics = ['Inicio', 'Detención', 'Revisión', 'Entrega', 'Permisos', 'Cola', 'Modelo', 'Cuota', 'Sesión', 'Trazas'];
const rows = [];

for (const topic of topics) {
  const task = 'Escribí un título Markdown para ' + topic;
  for (const action of candidates) {
    const output = action.id === 'markdown' ? '# ' + topic : topic;
    const passed = output === '# ' + topic; // El verificador de la app evalúa el texto recibido.
    const sequence = rows.length + 1;
    const observation = sealLearningRecord('observation', {
      format: 1, id: 'resultado-' + sequence, domain, action,
      attemptId: 'intento-' + sequence, decisionId: 'eleccion-' + sequence,
      decisionDigest: learningDigest({ task, action: action.key }), taskDigest: learningDigest(task),
      features, split: 'train', outcome: 'completed',
      quality: { state: 'verified', value: passed ? 1 : 0, passed },
      latency: { state: 'unknown' }, createdAt: now,
    });
    rows.push({ sequence, observation });
  }
}

const cold = selectPolicy(undefined, candidates, features, now);
const shadow = buildSnapshot(domain, DEFAULT_LEARNING_POLICY, rows.length, rows, now);
const suggested = selectPolicy(shadow, candidates, features, now);
assert.equal(cold.id, plain.id);
assert.equal(suggested.id, markdown.id);
console.table(predict(shadow, features, candidates, now).map((p, i) => ({
  candidato: candidates[i].id, tareas: p.support, calidadMedia: p.meanQuality,
})));
console.log('Primera elección:', cold.id, '· Candidato con evidencia:', suggested.id);
console.log('La política en sombra usa resultados sintéticos. Activarla requiere evaluación independiente.');
