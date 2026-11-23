// Registra un CLI propio de conteo de palabras junto a los cuatro proveedores integrados.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime, UnsupportedCapabilityError, createDefaultProviders } from 'hiveagents-runtime';
import { FileWorkflowStore } from 'hiveagents-runtime/orchestration';
import { createAgent, RoutingSelectionError, WorkflowRoutingReceiptStore } from 'hiveagents-runtime/routing';
import { runProcess } from 'hiveagents-runtime/adapter-kit';

const provider = 'contador';
const script = fileURLToPath(new URL('./fixtures/word-count-cli.mjs', import.meta.url));
const model = { provider, id: 'palabras', aliases: [], source: 'explicit', availability: 'available' };
const features = {
  turns: 'supported', resume: 'unsupported', structuredOutput: 'unsupported', forkWithPrompt: 'unsupported',
};

function unsupported(message) {
  return new UnsupportedCapabilityError({ provider, transport: 'exec', retryable: false }, message);
}

function createAdapter(target) {
  return {
    id: provider,
    async detect(env, probe) {
      const version = await runProcess({
        command: target.command, args: [...target.argsPrefix, '--version'], cwd: process.cwd(),
        env, stdin: '', timeoutMs: probe?.remainingMs() ?? 3000, maxOutputBytes: 1024, signal: probe?.signal,
      });
      return {
        installed: version.code === 0 && version.stdout.trim() === '1.0.0', version: version.stdout.trim(),
        launchTarget: target, identityFiles: [script],
      };
    },
    // Este programa local carece de un mecanismo de login.
    auth: async () => ({ authenticated: false, state: 'unknown', source: 'oss' }),
    models: async () => [model],
    compatibility: async (_env, cliVersion) => ({
      provider, cliVersion, transport: 'exec', evidence: 'unverified', features,
      missingFlags: [], knownIssues: [],
    }),
    async execute(request) {
      if (request.mode !== 'one-shot' || request.outputSchema) throw unsupported('El contador acepta un turno de texto.');
      const result = await runProcess({
        command: target.command, args: target.argsPrefix, stdin: request.prompt, cwd: request.cwd,
        env: request.env, signal: request.signal, timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes,
      });
      if (result.code !== 0) throw new Error('Falló el CLI contador.');
      const { sessionId, words } = JSON.parse(result.stdout);
      assert.match(sessionId, /^[a-f0-9-]{36}$/u);
      assert.ok(Number.isSafeInteger(words) && words >= 0, 'El CLI devolvió una cantidad inválida');
      return { completed: true, failed: false, refused: false, sessionId, text: String(words), events: [], nativeEvents: [] };
    },
  };
}

const counter = {
  apiVersion: 1, id: provider, modelCatalog: [model],
  resolveModel(id) {
    if (id !== model.id) throw new Error('Modelo de contador desconocido.');
    return model;
  },
  exec: {
    token: 'contadorExecV1', adapterVersion: '1.0.0',
    adapter: createAdapter({ command: process.execPath, argsPrefix: [script] }),
    withTarget: createAdapter,
  },
  translateContext({ profile = 'native', memory = 'inherit' } = {}) {
    if (profile !== 'native' || memory !== 'inherit') throw unsupported('El contador no tiene perfiles de contexto.');
    return { args: [], unsupported: [], warnings: [], report: { profile, memory, active: [], inactive: [], unavoidable: [], unknown: [] } };
  },
  translatePermissions(requested) {
    if (requested.mode !== 'analyze' || requested.network || requested.minimumEnforcement || requested.additionalDirectories?.length) {
      throw unsupported('El contador admite analyze y carece de sandbox configurable.');
    }
    return { args: [], report: { requested, unsupported: [], warnings: [], effective: {
      filesystem: 'lee stdin y escribe stdout', network: 'sin llamadas de red en el programa',
      approvals: 'sin herramientas', enforcedBy: [],
    } } };
  },
  validateOptions(options) {
    if (options.instructions || options.effort || Object.keys(options.providerOptions?.external?.[provider] ?? {}).length) {
      throw unsupported('El contador admite únicamente el texto de entrada.');
    }
  },
};

const runtime = new Runtime({ providers: [...createDefaultProviders(), counter] });
assert.deepEqual(runtime.providers().sort(), ['antigravity', 'claude', 'codex', 'contador', 'gemini']);
const local = 'contador/palabras';
const text = 'Revisar una tarjeta';
const task = { id: 'medir-tarjeta', version: '1', inputDigest: createHash('sha256').update(text).digest('hex') };
const policy = {
  mode: 'auto', candidates: [local], providers: [provider],
  // Este contador de stdin no usa cuentas. El permiso para auth desconocida queda limitado al contador.
  allowUnknownAuth: true,
  rules: [{ id: 'conteo-urgente', allTags: ['texto', 'urgente'], models: [local] }],
};
const directory = await mkdtemp(join(tmpdir(), 'kanban-reglas-'));
const receipts = new WorkflowRoutingReceiptStore(new FileWorkflowStore(directory));

function select(tags, modelPolicy = policy) {
  return createAgent({ model: modelPolicy, environment: { mode: 'minimal' } }, {
    runtime, receipts, task: { ...task, tags }, timeoutMs: 5000,
  });
}
try {
  // Para la misma tarea, quitar una etiqueta deja la regla sin coincidencia.
  await assert.rejects(select(['texto']), error => error instanceof RoutingSelectionError
    && error.code === 'NO_ROUTE' && error.receipt.reason === 'NO_MATCHING_RULE' && error.receipt.nativeDispatches === 0);
  const backup = await select(['texto'], { ...policy, fallback: local });
  try {
    assert.equal(backup.receipt.reason, 'FALLBACK');
    assert.equal(backup.receipt.nativeDispatches, 0);
  } finally {
    await backup.agent.close();
  }

  const { agent, receipt } = await select(['texto', 'urgente']);
  try {
    assert.equal(receipt.reason, 'RULE');
    assert.equal(receipt.policy.ruleId, 'conteo-urgente');
    assert.equal(receipt.nativeDispatches, 0);
    console.log('Selección previa: NO_MATCHING_RULE, FALLBACK y RULE. Sólo la aplicación inicia el proceso de trabajo.');
    const turn = await agent.run(text, { timeoutMs: 5000, awaitSettlement: true });
    assert.equal(turn.status, 'completed');
    assert.equal(turn.text, '3');
    console.log(receipt.selected.model, 'contó', turn.text, 'palabras. Proveedores registrados:', runtime.providers().join(', '));
  } finally {
    await agent.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
