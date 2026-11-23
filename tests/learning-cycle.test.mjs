import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
