import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readRoutingReceipt, WorkflowRoutingReceiptStore } from 'hiveagents-runtime/routing';
import { FileWorkflowStore } from 'hiveagents-runtime/orchestration';
const require = createRequire(import.meta.url);

export async function captureVerifiedRun(page, directory, extra) {
  const { cards } = await page.evaluate(() => window.kanban.snapshot());
  assert.equal(cards.length, 2);
  const corrected = cards.find(card => card.title === extra.title);
  assert.equal(corrected.status, 'done', 'Revisá la devolución sobre el borrador incorrecto en ' + directory);
  assert.equal(corrected.initialDraft, extra.initialDraft);
  assert.notEqual(corrected.artifact, corrected.initialDraft);
  assert.equal(corrected.attempts, 2);
  const reviews = corrected.events.filter(event => event.role === 'reviewer');
  assert.equal(reviews.length, 2, 'El revisor debe detectar la afirmación falsa del borrador inicial y luego evaluar su corrección.');
  assert.ok(reviews[0].message.startsWith('Pidió cambios'));
  assert.ok(reviews[1].message.startsWith('Aprobado'));
  const receipts = new WorkflowRoutingReceiptStore(new FileWorkflowStore(join(directory, 'receipts')));
  const routingReceipts = [];
  for (const card of cards) {
    const lastReview = card.events.filter(event => event.role === 'reviewer').at(-1);
    if (card.status === 'done') {
      assert.ok(card.artifact.trim() && card.checks.length && card.checks.every(check => check.passed));
      assert.ok(lastReview?.message.startsWith('Aprobado'));
    } else {
      assert.equal(card.status, 'blocked');
      assert.equal(card.attempts, 2, 'El ciclo se interrumpió. Revisá el historial en ' + directory + '. ' + card.events.at(-1).message);
      assert.ok(card.events.at(-1).message.includes('agotaron'));
    }
    const roles = card.status === 'done' ? ['planner', 'writer', 'reviewer'] : ['planner', 'writer'];
    for (const role of roles) {
      assert.ok(card.events.some(event => event.role === role && event.execution), 'Falta evidencia del rol ' + role);
    }
    for (const { execution } of card.events.filter(event => event.execution)) {
      const receipt = await readRoutingReceipt(receipts, execution.receiptId);
      assert.equal(receipt.selected.model, execution.model);
      routingReceipts.push(receipt);
    }
  }
  const installed = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('hiveagents-runtime')), 'utf8'));
  const report = {
    verifiedAt: new Date().toISOString(), sdk: installed.name + '@' + installed.version,
    electron: require('electron/package.json').version, platform: process.platform, arch: process.arch,
    routingReceipts,
    cards: cards.map(card => ({
      ...card, artifactSha256: createHash('sha256').update(card.artifact).digest('hex'),
    })),
  };
  await writeFile(join(directory, 'verified-run.json'), JSON.stringify(report, null, 2) + '\n');
  await page.screenshot({ path: join(directory, 'tablero.png') });
  await page.getByRole('button', { name: 'Abrir tarjeta: ' + extra.title }).click();
  await page.locator('#compare-draft summary').click();
  await page.screenshot({ path: join(directory, 'revision.png') });
  console.log('Entregables, controles y recibos verificados:', cards.map(card => card.title + ' (' + card.status + ')').join(' · '));
}
