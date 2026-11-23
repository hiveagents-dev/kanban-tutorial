import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { launchDesktop } from './launch.mjs';

test('buscar, editar, duplicar y ejecutar una tarjeta con evidencia copiable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-kanban-actions-'));
  let application;
  t.after(async () => {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const launched = await launchDesktop(directory);
  application = launched.application;
  const { page } = launched;
  const entry = fileURLToPath(import.meta.resolve('hiveagents-runtime'));

  await application.evaluate(({ clipboard }, sdkEntry) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const { Agent } = createRequire(sdkEntry)(sdkEntry);
    const planning = Promise.withResolvers();
    const writing = Promise.withResolvers();
    globalThis.actionsProbe = { planning, writing, eligible: [], copied: [] };
    clipboard.writeText = value => { globalThis.actionsProbe.copied.push(value); };
    Agent.prototype.ready = async function () {
      return {
        ready: true, provider: this.model.provider, model: this.model, installation: { installed: true },
        auth: { authenticated: true, source: 'subscription' }, capabilities: { unsupported: [] }, plan: { transport: 'exec' },
      };
    };
    Agent.prototype.run = async (prompt, { outputSchema }) => {
      const fields = outputSchema.properties;
      if (fields.cardId) {
        const { cards } = JSON.parse(prompt);
        globalThis.actionsProbe.eligible = cards.map(card => card.title);
        await planning.promise;
        return { status: 'completed', output: { cardId: cards[0].id, reason: 'La solicitó la operadora.' } };
      }
      if (fields.markdown) {
        await writing.promise;
        return { status: 'completed', output: { markdown: '# Entrega\n\n<em>Contenido literal</em>' } };
      }
      return { status: 'completed', output: { approved: true, feedback: 'Coincide con la consigna.' } };
    };
  }, entry);

  const original = 'Preparar una tarjeta verificable';
  const title = 'Guía de entrega';
  const open = name => page.getByRole('button', { name: 'Abrir tarjeta: ' + name, exact: true });
  await page.getByRole('button', { name: 'Nueva tarjeta' }).click();
  await page.getByLabel('Título', { exact: true }).fill('Primera guía');
  await page.getByLabel('Consigna', { exact: true }).fill('Documentá el flujo de entrega.');
  await page.getByLabel('Términos obligatorios', { exact: true }).fill('Entrega');
  await page.getByRole('button', { name: 'Crear tarjeta' }).click();
  await open('Primera guía').click();
  await page.locator('#edit-card').click();
  assert.equal(await page.getByLabel('Términos obligatorios', { exact: true }).inputValue(), 'Entrega');
  await page.getByLabel('Título', { exact: true }).fill(title);
  await page.locator('#submit-card').click();
  await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  if (await page.locator('#detail-dialog').isVisible()) await page.keyboard.press('Escape');
  await open(title).waitFor();

  const search = page.locator('#card-search');
  await search.fill('flujo de entrega');
  await open(original).waitFor({ state: 'hidden' });
  await open(title).click();
  await page.locator('#duplicate-card').click();
  assert.equal(await page.getByLabel('Consigna', { exact: true }).inputValue(), 'Documentá el flujo de entrega.');
  await page.getByLabel('Título', { exact: true }).fill('Guía alternativa');
  await page.locator('#submit-card').click();
  await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  if (await page.locator('#detail-dialog').isVisible()) await page.keyboard.press('Escape');

  await page.locator('#reset-filters').click();
  await open(original).waitFor();
  await open(title).click();
  await page.locator('#run-card').click();
  if (await page.locator('#detail-dialog').isVisible()) await page.keyboard.press('Escape');

  await page.waitForFunction(async () => (await window.kanban.snapshot()).cycle?.phase === 'planning');
  await page.locator('#cycle-title').filter({ hasText: /seleccionando|planific/i }).waitFor();
  await application.evaluate(() => globalThis.actionsProbe.planning.resolve());
  await page.waitForFunction(async () => (await window.kanban.snapshot()).cycle?.phase === 'writing');
  await page.locator('#cycle-title').filter({ hasText: /redact/i }).waitFor();
  assert.match(await page.locator('#cycle-panel').innerText(), /Guía de entrega/);
  await application.evaluate(() => globalThis.actionsProbe.writing.resolve());

  await page.getByRole('region', { name: 'Terminadas' }).getByRole('button', { name: 'Abrir tarjeta: ' + title }).waitFor();
  await page.locator('#state-filter').selectOption('done');
  await open(original).waitFor({ state: 'hidden' });
  await open(title).click();
  assert.equal(await page.locator('#detail-artifact').textContent(), '# Entrega\n\n<em>Contenido literal</em>');
  assert.equal(await page.locator('#detail-artifact em').count(), 0);
  assert.match(await page.locator('#detail-events').innerText(), /Coincide con la consigna/);
  await page.locator('#copy-markdown').click();
  await page.locator('#detail-events details summary').first().click();
  const copyReceipt = page.locator('[data-copy-receipt]').first();
  await copyReceipt.click();

  const { cards } = await page.evaluate(() => window.kanban.snapshot());
  const completed = cards.find(card => card.title === title);
  const copied = await application.evaluate(() => globalThis.actionsProbe.copied);
  assert.equal(copied[0], completed.artifact);
  assert.ok(completed.events.some(event => event.execution?.receiptId === copied[1]));
  assert.deepEqual(await application.evaluate(() => globalThis.actionsProbe.eligible), [title]);
  assert.deepEqual(cards.filter(card => card.status === 'pending').map(card => card.title), [original, 'Guía alternativa']);
  await assert.rejects(page.evaluate(id => window.kanban.copy(id, 'id-inventado'), completed.id));
});
