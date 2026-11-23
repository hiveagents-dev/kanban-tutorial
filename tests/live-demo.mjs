import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchDesktop } from './launch.mjs';
import { captureVerifiedRun } from './verified-run.mjs';

const directory = await mkdtemp(join(tmpdir(), 'hive-kanban-live-'));
const { application, page } = await launchDesktop(directory);
const extra = {
  title: 'Explicar cómo detener un ciclo',
  brief: 'Urgente para el lanzamiento de hoy. Redactá una ayuda de hasta 100 palabras para un operador del tablero. Explicá que debe pulsar Detener, que una tarjeta ya asignada pasa a Bloqueadas, y que sólo Reintentar y luego Iniciar ciclo vuelven a procesarla. Incluí un ejemplo sencillo.',
  initialDraft: '# Detener un ciclo\n\nPulsá Detener. Las tareas de Bloqueadas se reanudan automáticamente al abrir el tablero. Reintentar e Iniciar ciclo son opcionales.',
  requiredTerms: ['Detener', 'Bloqueadas', 'Reintentar', 'Iniciar ciclo'],
};
console.log('Datos de esta ejecución:', directory);
try {
  await page.getByRole('button', { name: 'Nueva tarjeta' }).click();
  await page.getByLabel('Título', { exact: true }).fill(extra.title);
  await page.getByLabel('Consigna', { exact: true }).fill(extra.brief);
  await page.getByLabel('Términos obligatorios', { exact: true }).fill(extra.requiredTerms.join('\n'));
  await page.getByLabel('Borrador inicial', { exact: true }).fill(extra.initialDraft);
  await page.getByRole('button', { name: 'Crear tarjeta' }).click();
  await page.getByRole('button', { name: 'Abrir tarjeta: ' + extra.title }).waitFor();
  await page.getByRole('button', { name: 'Iniciar ciclo' }).click();
  await page.waitForFunction(() => document.querySelector('#connection').dataset.active === 'true', null, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('#connection').dataset.active === 'false', null, { timeout: 22 * 60_000 });
  await captureVerifiedRun(page, directory, extra);
} finally {
  await application.close();
}
