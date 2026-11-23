import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { launchDesktop } from './launch.mjs';

test('detener el redactor en vuelo bloquea la tarjeta y reintentar la devuelve a pendientes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-kanban-cancel-'));
  let application;
  t.after(async () => {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const launched = await launchDesktop(directory);
  application = launched.application;
  const { page } = launched;

  // El proceso principal usa el SDK instalado. Sustituimos la sonda y el turno antes del primer clic.
  const entry = fileURLToPath(import.meta.resolve('hiveagents-runtime'));
  await application.evaluate((_electron, sdkEntry) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const { Agent } = createRequire(sdkEntry)(sdkEntry);
    const writer = Promise.withResolvers();
    const trace = { planner: 0, writer: 0, reviewer: 0, aborted: 0 };
    globalThis.cancelProbe = { writerStarted: writer.promise, trace };
    Agent.prototype.ready = async function () {
      return {
        ready: true, provider: this.model.provider, model: this.model, installation: { installed: true },
        auth: { authenticated: true, source: 'subscription' }, capabilities: { unsupported: [] }, plan: { transport: 'exec' },
      };
    };
    Agent.prototype.run = async (prompt, { outputSchema, signal }) => {
      const fields = outputSchema.properties;
      if (fields.cardId) {
        trace.planner++;
        return { status: 'completed', output: { cardId: JSON.parse(prompt).cards[0].id, reason: 'Es la única tarjeta.' } };
      }
      if (fields.markdown) {
        trace.writer++;
        const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        writer.resolve();
        await aborted;
        trace.aborted++;
        return { status: 'completed', output: { markdown: 'Un resultado tardío debe descartarse.' } };
      }
      trace.reviewer++;
      throw new Error('Se inició una revisión después de detener el ciclo.');
    };
  }, entry);

  await page.getByRole('button', { name: 'Iniciar ciclo' }).click();
  await application.evaluate(() => Promise.race([
    globalThis.cancelProbe.writerStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('El redactor no recibió la tarjeta.')), 8000)),
  ]));
  await page.getByRole('button', { name: 'Detener' }).click();
  await page.getByRole('heading', { name: 'Bloqueadas' }).waitFor();
  const title = 'Abrir tarjeta: Preparar una tarjeta verificable';
  await page.getByRole('button', { name: title }).click();
  assert.equal(await page.locator('#detail-status').textContent(), 'Bloqueada');
  await page.getByRole('button', { name: 'Reintentar' }).click();
  await page.getByRole('region', { name: 'Pendientes' }).getByRole('button', { name: title }).waitFor();

  const { active, cards } = await page.evaluate(() => window.kanban.snapshot());
  assert.equal(active, false);
  assert.equal(cards[0].status, 'pending');
  assert.equal(cards[0].artifact, '');
  assert.deepEqual(await application.evaluate(() => globalThis.cancelProbe.trace),
    { planner: 1, writer: 1, reviewer: 0, aborted: 1 });
});
