import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Runtime } from 'hiveagents-runtime';
import { fixtureDefinition, fixtureRuntime } from '../labs/fixtures/learning-cycle-provider.mjs';

test('la definición toma candidatos del catálogo registrado, incluso con otros identificadores', async () => {
  const fixture = fixtureRuntime();
  const [provider] = fixture.providers();
  const registration = fixture.registration(provider);
  const modelCatalog = (await fixture.models(provider)).map((model, index) => ({
    ...model, id: 'catalogo-' + (index + 1),
  }));
  const runtime = new Runtime({ providers: [{ ...registration, modelCatalog }] });
  const definition = await fixtureDefinition(runtime, process.cwd());
  assert.deepEqual(definition.model.candidates, [
    { id: 'catalogo-1', model: provider + '/catalogo-1' },
    { id: 'catalogo-2', model: provider + '/catalogo-2' },
  ]);
});

test('el router adaptable promociona y revierte por evidencia, con reinicio entre procesos', () => {
  const script = fileURLToPath(new URL('../labs/learning-cycle.mjs', import.meta.url));
  const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 90_000 });
  assert.deepEqual(JSON.parse(stdout), {
    baseline: 'base', shadowObservations: 16,
    incomplete: { status: 'kept', reason: 'INCOMPLETE', generation: 0 },
    promotion: { status: 'promoted', generation: 1, freshWins: 6, fixedCells: 4, freshCells: 12 },
    restartVerified: true, learned: 'especialista',
    rollback: { status: 'rolled-back', generation: 2, freshWins: 6, restartVerified: true }, restored: 'base',
    fixtureTurns: 50, commercialTurns: 0,
  });
});
