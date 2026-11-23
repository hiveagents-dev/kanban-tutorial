import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Runtime } from 'hiveagents-runtime';
import { runProcess } from 'hiveagents-runtime/adapter-kit';

const id = 'kanban-fixture';
const script = fileURLToPath(new URL('./learning-cycle-cli.mjs', import.meta.url));
const target = { command: process.execPath, argsPrefix: [script] };
const models = ['base', 'especialista'].map(modelId => ({
  provider: id, id: modelId, aliases: [], source: 'explicit', availability: 'available',
}));

function adapter(launch) {
  return {
    id,
    async detect() {
      return { installed: true, version: '1.0.0', launchTarget: launch, identityFiles: [script] };
    },
    async auth() {
      return { authenticated: false, state: 'unknown', source: 'oss' };
    },
    async models() { return models; },
    async execute(request) {
      assert.ok(['open', 'one-shot'].includes(request.mode), 'Each candidate gets an independent turn');
      const { code, stdout, signal } = await runProcess({
        command: launch.command,
        args: [...launch.argsPrefix, request.modelId],
        stdin: request.prompt,
        cwd: request.cwd,
        env: request.env,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: 4096,
      });
      assert.equal(signal, null);
      assert.equal(code, 0);
      const { sessionId, answer } = JSON.parse(stdout);
      assert.equal(typeof sessionId, 'string');
      assert.equal(typeof answer, 'string');
      return {
        completed: true, failed: false, refused: false, sessionId,
        text: JSON.stringify({ answer }), events: [], nativeEvents: [],
      };
    },
  };
}

export function fixtureRuntime() {
  // An isolated runtime sees only the Node fixture, even on machines with CLIs and credentials.
  return new Runtime({
    providers: [{
      id,
      apiVersion: 1,
      modelCatalog: models,
      resolveModel(modelId) {
        const model = models.find(item => item.id === modelId);
        assert.ok(model, 'Unknown fixture model');
        return model;
      },
      exec: { token: 'kanbanFixtureExecV1', adapterVersion: '1.0.0', adapter: adapter(target), withTarget: adapter },
      execCapabilities: { turns: 'supported', resume: 'unsupported', structuredOutput: 'unsupported' },
      translateContext({ profile = 'native', memory = 'inherit' } = {}) {
        assert.equal(profile, 'native');
        assert.equal(memory, 'inherit');
        return { args: [], unsupported: [], warnings: [], report: { profile, memory, active: [], inactive: [], unavoidable: [], unknown: [] } };
      },
      translatePermissions(requested, transport) {
        assert.equal(transport, 'exec');
        assert.equal(requested.mode, 'analyze');
        assert.ok(!requested.network && !requested.minimumEnforcement && !requested.additionalDirectories?.length,
          'The fixture provides no OS sandbox or network policy');
        return {
          args: [],
          report: {
            requested, unsupported: [], warnings: [],
            effective: { filesystem: 'lee un archivo de fase local', network: 'el fixture no usa red', approvals: 'sin herramientas', enforcedBy: [] },
          },
        };
      },
      validateOptions(options) {
        assert.equal(options.environment.mode, 'minimal');
      },
    }],
  });
}

export async function fixtureDefinition(runtime, cwd) {
  const catalog = await runtime.models(id);
  const candidates = catalog.map(model => ({ id: model.id, model: model.provider + '/' + model.id }));
  return {
    cwd,
    // This exception is for the registration above. The fixture has no login or credentials.
    model: {
      mode: 'auto', allowUnknownAuth: true, providers: [id],
      candidates,
    },
    permissions: { mode: 'analyze' },
    environment: { mode: 'minimal' },
    transport: 'exec',
  };
}
