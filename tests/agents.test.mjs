import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Agent, Runtime } from 'hiveagents-runtime';
import { createAgents } from '../src/agents.mjs';

const card = {
  id: 'guia', title: 'Guía breve', brief: 'Definí un tablero Kanban', requiredTerms: ['flujo'],
  events: [{ message: 'historial privado de prueba' }], artifact: 'borrador previo',
};

async function fixture(t, model) {
  const cwd = await mkdtemp(join(tmpdir(), 'kanban-agent-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const receiptDirectory = join(cwd, 'receipts');
  return { agents: createAgents({ cwd, model, receiptDirectory }), receiptDirectory };
}

// Exercise the published router and receipt store. Replace only the CLI readiness and model turn.
function stubReadiness(t, authenticated) {
  const probes = [];
  t.mock.method(Agent.prototype, 'ready', async function () {
    const { provider } = this.model;
    probes.push(provider);
    return {
      ready: true, provider, model: this.model, installation: { installed: true },
      auth: { authenticated: authenticated(provider), source: 'subscription' },
      capabilities: { unsupported: [] }, plan: { transport: 'exec' },
    };
  });
  return probes;
}

test('tries Codex after a Claude preflight abstention and sends only the eligible card fields', async t => {
  const { agents, receiptDirectory } = await fixture(t);
  const probes = stubReadiness(t, provider => provider === 'codex');
  let sent;
  t.mock.method(Agent.prototype, 'run', async function (prompt, options) {
    assert.equal(this.model.provider, 'codex');
    assert.equal(options.awaitSettlement, true);
    assert.deepEqual(options.outputSchema.properties.cardId.enum, ['guia']);
    sent = JSON.parse(prompt);
    return { status: 'completed', output: { cardId: 'guia', reason: 'Es urgente.' } };
  });
  const result = await agents.plan({ cards: [card] });
  const runtime = new Runtime();
  const claudeModels = (await runtime.models('claude')).filter(model => model.availability !== 'unavailable');
  const [codexModel] = (await runtime.models('codex')).filter(model => model.availability !== 'unavailable');
  assert.deepEqual(probes, [...claudeModels.map(() => 'claude'), 'codex']);
  assert.equal(result.cardId, 'guia');
  assert.equal(result.execution.model, 'codex/' + codexModel.id);
  assert.deepEqual(Object.keys(sent.cards[0]).sort(), ['brief', 'id', 'requiredTerms', 'title']);
  const files = await readdir(receiptDirectory);
  assert.equal(files.length, 2);
  for (const file of files) {
    const receipt = await readFile(join(receiptDirectory, file), 'utf8');
    assert.ok(!receipt.includes(card.brief));
  }
});

test('never re-dispatches after execution has started, even if the provider fails', async t => {
  const { agents } = await fixture(t);
  const probes = stubReadiness(t, () => true);
  const run = t.mock.method(Agent.prototype, 'run', async () => { throw new Error('turn interrupted'); });
  await assert.rejects(agents.write({ card, feedback: '' }), /turn interrupted/);
  assert.deepEqual(probes, ['claude']);
  assert.equal(run.mock.callCount(), 1);
});

test('passes the previous draft and feedback to the writer and a separate context to the reviewer', async t => {
  const { agents } = await fixture(t, 'claude/sonnet');
  stubReadiness(t, () => true);
  const instances = [];
  const payloads = [];
  t.mock.method(Agent.prototype, 'run', async function (prompt) {
    instances.push(this);
    payloads.push(JSON.parse(prompt));
    return { status: 'completed', output: instances.length === 1 ? { markdown: '# Flujo' } : { approved: true, feedback: 'OK' } };
  });
  const { markdown } = await agents.write({ card, feedback: 'Agregá el término requerido.' });
  const { approved } = await agents.review({ card, markdown, checks: [{ name: 'flujo', passed: true }] });
  assert.equal(approved, true);
  assert.notEqual(instances[0], instances[1]);
  assert.equal(payloads[0].previousDraft, card.artifact);
  assert.equal(payloads[0].feedback, 'Agregá el término requerido.');
  assert.equal(payloads[1].markdown, markdown);
  assert.ok(!JSON.stringify(payloads[1]).includes(card.artifact));
  assert.ok(!JSON.stringify(payloads).includes(card.events[0].message));
});

test('cancellation before routing causes zero probes and zero turns', async t => {
  const { agents } = await fixture(t);
  const probes = stubReadiness(t, () => true);
  const run = t.mock.method(Agent.prototype, 'run', () => assert.fail('unexpected dispatch'));
  await assert.rejects(agents.plan({ cards: [card], signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.deepEqual(probes, []);
  assert.equal(run.mock.callCount(), 0);
});
