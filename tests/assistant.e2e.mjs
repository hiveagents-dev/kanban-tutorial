import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assistantScenario } from '../scripts/assistant-scenario.mjs';
import { openStore } from '../src/store.mjs';
import { launchDesktop } from './launch.mjs';

test('responder la alerta de A2, confirmar la recuperación y encontrar el trabajo terminado', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-kanban-assistant-e2e-'));
  const a2 = assistantScenario();
  openStore(directory).save([a2]);
  let application;
  t.after(async () => {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const launched = await launchDesktop(directory);
  application = launched.application;
  const { page } = launched;
  const sdk = fileURLToPath(import.meta.resolve('hiveagents-runtime'));

  await application.evaluate((_electron, sdkPath) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const { Agent } = createRequire(sdkPath)(sdkPath);
    const trace = { prompts: [], planning: 0 };
    globalThis.assistantE2e = trace;
    Agent.prototype.ready = async function () {
      return {
        ready: true, provider: this.model.provider, model: this.model, installation: { installed: true },
        auth: { authenticated: true, source: 'subscription' }, capabilities: { unsupported: [] }, plan: { transport: 'exec' },
      };
    };
    Agent.prototype.run = async (prompt, { outputSchema }) => {
      const input = JSON.parse(prompt);
      const fields = outputSchema.properties;
      if (fields.action) {
        trace.prompts.push(input);
        return { status: 'completed', output: {
          message: 'A2 quedó bloqueada después de dos intentos. Podemos reintentarla para aplicar las observaciones.',
          action: 'retryAndRun', cardId: 'A2',
        } };
      }
      if (fields.cardId) {
        trace.planning++;
        return { status: 'completed', output: { cardId: input.cards[0].id, reason: 'Recuperación autorizada.' } };
      }
      if (fields.markdown) {
        if (!input.feedback.includes('Falta')) throw new Error('No llegó la observación anterior al redactor.');
        return { status: 'completed', output: {
          markdown: '# Recuperación\n\nPulsá Reintentar y luego ejecutá la tarjeta.',
        } };
      }
      return { status: 'completed', output: { approved: true, feedback: 'Describe la recuperación correctamente.' } };
    };
  }, sdk);

  await page.locator('#assistant-open').click();
  await page.locator('#assistant-alerts').getByText(/A2/).first().waitFor();
  await page.locator('#assistant-alerts [data-alert-reply]').first().click();
  await page.locator('#assistant-message').fill('¿Por qué quedó trabada y podés reintentarla ahora?');
  await page.locator('#assistant-send').click();
  await page.locator('#assistant-thread').getByText(/después de dos intentos/).waitFor();
  const confirm = page.locator('[data-proposal-decision="confirm"]');
  await confirm.waitFor();
  const before = await page.evaluate(() => window.kanban.snapshot());
  assert.equal(before.cards[0].status, 'blocked');
  const { prompts, planning } = await application.evaluate(() => globalThis.assistantE2e);
  assert.equal(planning, 0);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].board.counts.blocked, 1);
  assert.equal(prompts[0].alert.cardId, 'A2');

  await confirm.click();
  await page.waitForFunction(async () => (await window.kanban.snapshot()).cards[0].status === 'done');
  await page.locator('#assistant-alerts [data-alert-reply]').waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Nueva tarjeta' }).click();
  await page.getByLabel('Título', { exact: true }).fill(a2.title);
  await page.locator('#related-cards [data-related-card]').first().waitFor();
  assert.match(await page.locator('#related-cards').innerText(), /Terminada/);

  await application.close();
  application = null;
  const reopened = await launchDesktop(directory);
  application = reopened.application;
  await reopened.page.locator('#assistant-open').click();
  await reopened.page.locator('#assistant-thread').getByText(/después de dos intentos/).waitFor();
  const restored = await reopened.page.evaluate(() => window.kanban.assistantSnapshot());
  assert.equal(restored.alerts.length, 0);
  assert.equal(restored.messages.find(message => message.role === 'user').alertTitle, a2.title);
  assert.equal(restored.messages.find(message => message.role === 'assistant').proposal.status, 'applied');
});
