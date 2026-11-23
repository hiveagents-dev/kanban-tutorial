import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateRoutingReceipt } from 'hiveagents-runtime/routing';

for (const file of ['verified-run.json', 'codex-run.json']) {
  test(file + ' conserva entregables exactos y recibos válidos por turno', async () => {
    const report = JSON.parse(await readFile(new URL('../evidence/' + file, import.meta.url)));
    const receipts = new Map(report.routingReceipts.map(raw => {
      const receipt = validateRoutingReceipt(raw);
      return [receipt.id, receipt];
    }));
    const executions = report.cards.flatMap(card => {
      assert.equal(createHash('sha256').update(card.artifact).digest('hex'), card.artifactSha256);
      return card.events.flatMap(event => event.execution ? [event.execution] : []);
    });
    assert.equal(receipts.size, executions.length);
    for (const execution of executions) {
      assert.equal(receipts.get(execution.receiptId).selected.model, execution.model);
    }
    const corrected = report.cards.find(card => card.initialDraft);
    assert.equal(corrected.status, 'done');
    assert.notEqual(corrected.initialDraft, corrected.artifact);
    assert.ok(corrected.events.some(event => event.role === 'reviewer' && event.message.startsWith('Pidió cambios')));
  });
}
