import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { FileWorkflowStore } from 'hiveagents-runtime/orchestration';
import { WorkflowRoutingReceiptStore } from 'hiveagents-runtime/routing';
import { openStore } from '../src/store.mjs';
import { assistantScenario } from './assistant-scenario.mjs';

const { values } = parseArgs({ options: { assistant: { type: 'boolean' } } });
const directory = await mkdtemp(join(tmpdir(), 'hive-kanban-replay-'));
const report = JSON.parse(await readFile(new URL('../evidence/verified-run.json', import.meta.url), 'utf8'));
const receipts = new WorkflowRoutingReceiptStore(new FileWorkflowStore(join(directory, 'receipts')));
for (const receipt of report.routingReceipts) await receipts.save(receipt);
for (const card of report.cards) {
  if (createHash('sha256').update(card.artifact).digest('hex') !== card.artifactSha256) {
    throw new Error('El entregable guardado no coincide con su huella de verificación.');
  }
}
const cards = values.assistant ? [...report.cards, assistantScenario()] : report.cards;
openStore(directory).save(cards);
const env = { ...process.env, KANBAN_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
console.log(values.assistant ? 'Tablero temporal con la alerta A2:' : 'Copia local de la ejecución verificada:', directory);
const child = spawn(electronPath, [fileURLToPath(new URL('../', import.meta.url))], { env, stdio: 'inherit' });
child.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
