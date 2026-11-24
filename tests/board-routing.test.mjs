import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Agent, Runtime, createClaudeProvider, createCodexProvider, createGeminiCliProvider } from 'hiveagents-runtime';
import { createAgents } from '../src/agents.mjs';
import { boardRoutingDefinition, boardRoutingProfiles } from '../src/board-routing.mjs';

const card = { id: 'guia', title: 'Guía', brief: 'Explicá el flujo', requiredTerms: ['flujo'] };
const model = (provider, id, availability = 'available') => ({ id, provider, aliases: [], source: 'explicit', availability });

function runtimeWithCatalog() {
  return new Runtime({ providers: [
    { ...createClaudeProvider(), modelCatalog: [
      model('claude', 'catalog-retired', 'unavailable'),
      model('claude', 'catalog-allowed'),
    ] },
    { ...createCodexProvider(), modelCatalog: [model('codex', 'catalog-codex')] },
    createGeminiCliProvider(),
  ] });
}

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'kanban-routing-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function stubReady(t, check) {
  return t.mock.method(Agent.prototype, 'ready', async function () {
    const { provider, id } = this.model;
    const ready = check?.(provider, id) ?? {};
    return {
      provider, model: this.model, ready: true, installation: { installed: true },
      auth: { authenticated: true, source: 'subscription' },
      capabilities: { unsupported: [] }, plan: { transport: 'exec' }, ...ready,
    };
  });
}

test('usa los catálogos del runtime y conserva los perfiles exactos de permisos', () => {
  const runtime = runtimeWithCatalog();
  const [claude, codex] = boardRoutingProfiles(runtime);
  assert.deepEqual(claude.candidates, ['claude/catalog-retired', 'claude/catalog-allowed']);
  assert.deepEqual(codex.candidates, ['codex/catalog-codex']);
  assert.deepEqual(claude.options.permissions, { mode: 'respond' });
  assert.deepEqual(claude.options.context, { profile: 'clean', memory: 'off' });
  assert.deepEqual(claude.options.providerOptions.claude.tools, []);
  assert.deepEqual(codex.options.permissions, { mode: 'analyze', minimumEnforcement: 'sandbox' });
  assert.deepEqual(codex.options.context, { profile: 'native', memory: 'off' });
  assert.equal(codex.options.providerOptions.codex.ephemeral, true);
  assert.deepEqual(boardRoutingDefinition(claude, { cwd: '/private' }).model, {
    mode: 'auto', providers: ['claude'], allowUnverifiedModels: true,
  });
  assert.throws(() => boardRoutingProfiles(runtime, 'gemini/gemini-2.5-flash'), /schema nativo/);
  const [explicit] = boardRoutingProfiles(runtime, 'claude/catalog-allowed');
  assert.equal(explicit.explicit, true);
  assert.deepEqual(boardRoutingDefinition(explicit, { cwd: '/private' }).model.candidates, ['claude/catalog-allowed']);
});

test('el selector excluye modelos retirados y perfiles sin capacidad antes del despacho', async t => {
  const runtime = runtimeWithCatalog();
  const cwd = await workspace(t);
  const probes = [];
  const ready = stubReady(t, (provider, id) => {
    probes.push(provider + '/' + id);
    if (provider === 'claude') return { capabilities: { unsupported: ['context.clean'] } };
  });
  const run = t.mock.method(Agent.prototype, 'run', async function (_prompt, { outputSchema, awaitSettlement }) {
    assert.equal(this.model.id, 'catalog-codex');
    assert.equal(outputSchema.properties.markdown.type, 'string');
    assert.equal(awaitSettlement, true);
    return { status: 'completed', output: { markdown: '# Flujo' } };
  });
  const agents = createAgents({ cwd, runtime });
  const result = await agents.write({ card });
  assert.equal(result.execution.model, 'codex/catalog-codex');
  assert.deepEqual(probes, ['claude/catalog-allowed', 'codex/catalog-codex']);
  assert.equal(ready.mock.callCount(), 2);
  assert.equal(run.mock.callCount(), 1);
});

test('la política de aprendizaje se aplica sólo al redactor en automático y no reintenta un despacho fallido', async t => {
  const cwd = await workspace(t);
  const runtime = runtimeWithCatalog();
  stubReady(t);
  const run = t.mock.method(Agent.prototype, 'run', async function () {
    return { status: 'completed', output: { cardId: card.id, reason: 'Es elegible.', markdown: '# Flujo' } };
  });
  const learning = {
    async write(input) {
      assert.equal(input.profile.provider, 'codex');
      assert.equal(input.role, 'write');
      assert.equal(input.cwd, cwd);
      assert.equal(input.outputSchema.properties.markdown.type, 'string');
      throw new Error('interrumpido después de ejecutar');
    },
  };
  const agents = createAgents({ cwd, runtime, learning, learningProvider: 'codex' });
  assert.equal((await agents.plan({ cards: [card] })).execution.model, 'claude/catalog-allowed');
  await assert.rejects(agents.write({ card }), /interrumpido después de ejecutar/);
  assert.equal(run.mock.callCount(), 1);

  const explicitAgents = createAgents({ cwd, runtime, learning, learningProvider: 'codex', model: 'claude/catalog-allowed' });
  assert.equal((await explicitAgents.write({ card })).execution.model, 'claude/catalog-allowed');
  assert.equal(run.mock.callCount(), 2);
});
