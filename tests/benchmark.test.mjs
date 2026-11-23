import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import cases from '../labs/fixtures/kanban-benchmark.mjs';

const run = promisify(execFile);
test('el laboratorio de medición sólo consume turnos si se pide explícitamente', async () => {
  const lab = new URL('../labs/benchmark.mjs', import.meta.url);
  const { stdout } = await run(process.execPath, [lab.pathname]);
  assert.match(stdout, /--live/);
});

const samples = {
  'prioridad-incidente': { cardId: 'incidente' },
  'redaccion-turnos': { markdown: [
    '| ID | Estado | Próximo paso |', '| --- | --- | --- |', '| A-17 | Bloqueada | Reintentar |',
    '| A-18 | Terminada | Archivar |', '| A-19 | Pendiente | Iniciar ciclo |',
  ].join('\n') },
  'redaccion-resumen': { markdown: [
    '| Estado | Cantidad |', '| --- | --- |', '| Bloqueada | 1 |', '| Pendiente | 2 |', '| Terminada | 2 |',
  ].join('\n') },
  'revision-rechazo': { approved: false, issue: 'reintento' },
  'revision-aprobacion': { approved: true, issue: 'ninguno' },
};
test('los verificadores detectan una prioridad incorrecta, estados cambiados y dictámenes invertidos', () => {
  const wrong = {
    'prioridad-incidente': { cardId: 'guia' },
    'redaccion-turnos': { markdown: samples['redaccion-turnos'].markdown.replace('Bloqueada | Reintentar', 'Pendiente | Reintentar') },
    'redaccion-resumen': { markdown: samples['redaccion-resumen'].markdown.replace('Bloqueada | 1', 'Bloqueada | 3') },
    'revision-rechazo': { approved: true, issue: 'ninguno' },
    'revision-aprobacion': { approved: false, issue: 'reintento' },
  };
  for (const item of cases) {
    assert.ok(Object.values(item.verify(samples[item.id])).every(Boolean), item.id);
    assert.ok(Object.values(item.verify(wrong[item.id])).some(value => !value), item.id);
  }
});

test('los recibos publicados emparejan los mismos casos y preservan la procedencia del SDK', async () => {
  const read = file => readFile(new URL(file, import.meta.url));
  const digest = data => createHash('sha256').update(data).digest('hex');
  const [runner, corpus, registry, candidate, structured] = await Promise.all([
    read('../labs/benchmark.mjs'), read('../labs/fixtures/kanban-benchmark.mjs'),
    read('../evidence/model-benchmark-text.json'), read('../evidence/model-benchmark-antigravity.json'),
    read('../evidence/model-benchmark-structured.json'),
  ]);
  const reports = [registry, candidate, structured].map(bytes => JSON.parse(bytes));
  for (const report of reports) {
    assert.equal(report.runnerSha256, digest(runner));
    assert.equal(report.corpusSha256, digest(corpus));
    assert.deepEqual(report.method.selectedCases, reports[0].method.selectedCases);
    for (const { model, passed } of report.summary) {
      const rows = report.cells.filter(cell => cell.model === model);
      assert.deepEqual(rows.map(row => row.case), report.method.selectedCases);
      assert.equal(rows.filter(row => row.passed).length, passed);
    }
  }
  assert.deepEqual(reports.map(report => report.format), ['text', 'text', 'structured']);
  assert.equal(reports[0].sdkArtifact.source, 'npm-registry');
  assert.equal(reports[1].sdkArtifact.source, 'local-candidate');
  assert.deepEqual(reports[2].sdkArtifact, reports[0].sdkArtifact);
  assert.match(reports[1].sdkArtifact.sha256, /^[a-f0-9]{64}$/);
});
