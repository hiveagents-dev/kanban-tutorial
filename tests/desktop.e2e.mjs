import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { launchDesktop } from './launch.mjs';

test('crear desde la ventana, inspeccionar y recuperar la tarjeta al reabrir', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-kanban-e2e-'));
  let application;
  t.after(async () => {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const launched = await launchDesktop(directory);
  application = launched.application;
  const { page } = launched;
  const title = 'Documentar <b>entregas</b>';
  const cardButton = { name: 'Abrir tarjeta: ' + title };
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const { sandbox, nodeIntegration, contextIsolation } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox, nodeIntegration, contextIsolation };
  });
  assert.deepEqual(preferences, { sandbox: true, nodeIntegration: false, contextIsolation: true });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.getByRole('button', { name: 'Nueva tarjeta' }).click();
  await page.getByLabel('Título', { exact: true }).fill(title);
  await page.getByLabel('Consigna', { exact: true }).fill('Prepará instrucciones para el equipo.');
  await page.getByLabel('Términos obligatorios', { exact: true }).fill('Entrega');
  const original = '  # Entrega\n\nDocumento para revisión.  ';
  await page.getByLabel('Borrador inicial', { exact: true }).fill(original);
  await page.getByRole('button', { name: 'Crear tarjeta' }).click();
  await page.getByRole('button', cardButton).click();
  assert.equal(await page.locator('#detail-status').textContent(), 'Pendiente');
  assert.equal(await page.locator('#detail-title').textContent(), title);
  assert.equal(await page.locator('#detail-title b').count(), 0);
  assert.equal(await page.locator('#detail-terms').innerText(), 'Entrega');
  assert.equal(await page.locator('#detail-artifact').textContent(), original);

  await application.close();
  application = null;
  const reopened = await launchDesktop(directory);
  application = reopened.application;
  await reopened.page.getByRole('button', cardButton).waitFor();
  const snapshot = await reopened.page.evaluate(() => window.kanban.snapshot());
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.cards.length, 2);
  assert.equal(snapshot.cards.find(card => card.title === title).initialDraft, original);
  assert.ok(snapshot.cards.every(card => card.status === 'pending' && card.attempts === 0));
});

test('la ventana permite recuperar la última tarjeta después de un fallo de escritura', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-kanban-recovery-'));
  let application;
  t.after(async () => {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const launched = await launchDesktop(directory);
  application = launched.application;
  const { page } = launched;
  // The board suite covers disk errors. Simulate its last durable snapshot at the IPC boundary.
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    let status = 'working';
    const notify = () => BrowserWindow.getAllWindows()[0].webContents.send('board:changed');
    ipcMain.removeHandler('board:snapshot');
    ipcMain.removeHandler('board:run');
    ipcMain.handle('board:snapshot', () => ({ active: false, cards: [{
      id: 'disk-full', title: 'Recuperar entrega', brief: 'Interrumpida', status,
      requiredTerms: ['Entrega'], artifact: '', attempts: 1, checks: [], events: [],
    }] }));
    ipcMain.handle('board:run', () => { status = 'blocked'; notify(); });
    notify();
  });
  await page.getByRole('button', { name: 'Recuperar tablero' }).click();
  await page.getByRole('heading', { name: 'Bloqueadas' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Iniciar ciclo' }).isDisabled(), true);
});
