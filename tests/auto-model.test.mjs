import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fixtureRuntime } from '../labs/fixtures/learning-cycle-provider.mjs';

test('el SDK obtiene los candidatos del catálogo y ejecuta el elegido sin recibir su nombre', async () => {
  const lab = fileURLToPath(new URL('../labs/auto-model.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [lab, '--fixture'], { timeout: 15_000 });
  const result = JSON.parse(stdout);
  const runtime = fixtureRuntime();
  const [provider] = runtime.providers();
  const catalog = runtime.registration(provider).modelCatalog;
  assert.deepEqual(result.selection.candidates.map(candidate => candidate.model),
    catalog.map(model => model.provider + '/' + model.id));
  assert.equal(result.selection.decision, 'selected');
  assert.equal(result.selection.reason, 'PRIORITY');
  assert.equal(result.selection.selected.model, result.selection.candidates[0].model);
  assert.equal(result.selection.nativeDispatches, 0);
  assert.deepEqual(result.turn, { status: 'completed', answer: 'pendiente', passed: true });
});
