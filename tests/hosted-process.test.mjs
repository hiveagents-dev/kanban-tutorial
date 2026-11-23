import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

test('Hosted arbitra cupos y alcance de workers separados antes de iniciar el CLI', async () => {
  const script = fileURLToPath(new URL('../labs/hosted-process.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script], { timeout: 30_000 });
  assert.deepEqual(stdout.trim().split('\n'), [
    'Segundo worker rechazado por cupo. Despachos al CLI: 1.',
    'Primer worker completado. Cupos activos: 0.',
    'Directorio fuera de la receta rechazado antes del despacho.',
    'Nuevo worker admitido. Despachos al CLI: 2. Cupos activos: 0.',
  ]);
});
