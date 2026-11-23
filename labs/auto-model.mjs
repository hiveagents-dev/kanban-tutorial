import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Runtime } from 'hiveagents-runtime';
import { FileWorkflowStore } from 'hiveagents-runtime/orchestration';
import { createAgent, readRoutingReceipt, RoutingSelectionError, WorkflowRoutingReceiptStore } from 'hiveagents-runtime/routing';
import { fixtureRuntime } from './fixtures/learning-cycle-provider.mjs';

const { values } = parseArgs({ options: { fixture: { type: 'boolean' }, live: { type: 'boolean' } } });
assert.ok(!(values.fixture && values.live), 'Elegí --fixture o --live.');

const directory = await realpath(await mkdtemp(join(tmpdir(), 'hive-auto-model-')));
const task = { document: 'Tarjeta de prueba\nEstado: pendiente\nPrioridad: alta', field: 'Estado' };
const runtime = values.fixture ? fixtureRuntime() : new Runtime();
let agent;
try {
  if (values.fixture) await writeFile(join(directory, 'phase.txt'), 'initial');

  const receipts = new WorkflowRoutingReceiptStore(new FileWorkflowStore(join(directory, 'receipts')));
  const definition = {
    model: {
      mode: 'auto',
      ...(values.fixture ? { allowUnknownAuth: true } : { allowUnverifiedModels: true }),
    },
    cwd: directory,
    transport: 'exec',
    environment: { mode: 'minimal' },
    permissions: { mode: 'analyze' },
    memory: false,
  };
  const input = JSON.stringify(task);
  let receipt;
  try {
    ({ agent, receipt } = await createAgent(definition, {
      runtime, receipts, timeoutMs: 30_000,
      task: {
        id: 'leer-estado-kanban', version: '1', tags: ['extraccion'],
        inputDigest: createHash('sha256').update(input).digest('hex'),
      },
    }));
  } catch (error) {
    if (!(error instanceof RoutingSelectionError)) throw error;
    receipt = error.receipt;
  }

  // El recibo queda en disco antes de que la app pueda ejecutar el turno.
  const persisted = await readRoutingReceipt(receipts, receipt.id);
  assert.equal(persisted.digest, receipt.digest);
  assert.equal(receipt.nativeDispatches, 0);
  const result = {
    mode: values.fixture ? 'fixture' : values.live ? 'live' : 'preflight',
    selection: receipt,
    turn: null,
  };

  if (agent && (values.fixture || values.live)) {
    const prompt = values.fixture ? input
      : 'Leé los datos de esta tarjeta sintética y respondé sólo con el valor de Estado, sin usar herramientas.\n' + input;
    const turn = await agent.run(prompt, { timeoutMs: 60_000, awaitSettlement: true });
    const answer = values.fixture ? JSON.parse(turn.text).answer : turn.text.trim();
    result.turn = { status: turn.status, answer, passed: turn.status === 'completed' && answer === 'pendiente' };
    if (!result.turn.passed) process.exitCode = 1;
  }

  if (!agent && (values.fixture || values.live)) process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
} finally {
  await agent?.close();
  await rm(directory, { recursive: true, force: true });
}
