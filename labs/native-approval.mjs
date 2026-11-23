import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, Runtime, createClaudeControlRegistration, createCodexControlRegistration } from 'hiveagents-runtime';
import { approvalFixture } from './fixtures/native-approval-fixtures.mjs';

const models = { claude: 'claude/sonnet', codex: 'codex/gpt-5.6-sol' };
const marker = 'FICHA-VERDE-592';
const approval = decision => ({ kind: 'approval', decision });

async function withWorkspace(run) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'hive-native-approval-')));
  try {
    const target = join(workspace, 'ficha.txt');
    await writeFile(target, marker, { mode: 0o600, flag: 'wx' });
    return await run(workspace, target);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function agent(provider, cwd, runtime) {
  return new Agent({
    model: models[provider], cwd, transport: 'control',
    permissions: { mode: 'analyze', strict: true },
    environment: { mode: 'minimal' }, requireAuth: 'subscription',
    context: { profile: provider === 'claude' ? 'clean' : 'native', memory: 'off' },
    providerOptions: { experimentalControl: true },
  }, runtime);
}

function exactClaudeRead(request, target) {
  return request.kind === 'tool-approval' && request.binding.method === 'canUseTool'
    && request.toolName === 'Read' && request.input?.file_path === target
    && Object.keys(request.input).length === 1 && request.availableDecisions.includes('allow');
}

function checkBinding(request, provider) {
  const { binding } = request;
  assert.equal(binding.provider, provider);
  assert.ok(binding.interactionId && binding.sessionId && binding.transportEpoch);
  assert.match(binding.payloadDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(binding), true);
}

async function runFixture(provider, scenario) {
  return withWorkspace(async (workspace, target) => {
    const fixture = approvalFixture(provider, workspace, target, scenario);
    const model = agent(provider, workspace, fixture.runtime);
    const session = await model.openSession({ persistence: 'process' });
    let finishHandler;
    let requestShown;
    const pending = new Promise(resolve => { finishHandler = resolve; });
    const shown = new Promise(resolve => { requestShown = resolve; });
    try {
      // The UI captures the request and responds later by interaction ID.
      // The callback stays pending until the simulation has verified the reply.
      const handle = session.start('Procesá la ficha sintética.', { timeoutMs: 5_000, onInteraction(request) {
        requestShown(request);
        return pending;
      } });
      const request = await Promise.race([
        shown,
        handle.result.then(() => { throw new Error('El turno terminó antes de solicitar aprobación'); }),
      ]);
      checkBinding(request, provider);
      assert.equal(request.signal.aborted, false);
      const id = request.binding.interactionId;

      if (provider === 'claude') {
        assert.ok(exactClaudeRead(request, target));
        if (scenario === 'cancel') {
          fixture.cancelClaudeRequest();
          await assert.rejects(handle.respond(id, approval('allow')), { code: 'INTERACTION_EXPIRED' });
        } else {
          await handle.respond(id, approval(scenario));
          await assert.rejects(handle.respond(id, approval(scenario)), { code: 'PROTOCOL_ERROR' });
        }
      } else {
        const command = scenario === 'decline-command';
        assert.equal(request.kind, command ? 'command-approval' : 'file-change-approval');
        assert.equal(request.binding.method, command ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval');
        assert.equal(request.binding.providerRequestId, 7);
        assert.equal(request.binding.itemId, 'fixture-action');
        if (scenario !== 'ceiling-refusal') {
          await handle.respond(id, approval('decline'));
          await assert.rejects(handle.respond(id, approval('decline')), { code: 'PROTOCOL_ERROR' });
        } else {
          assert.ok(request.availableDecisions.includes('accept'));
          await assert.rejects(handle.respond(id, approval('accept')), error =>
            error.code === 'UNSUPPORTED_CAPABILITY' && error.context.sanitizedDiagnostics.wireDecision === 'decline');
        }
      }
      assert.equal((await handle.result).status, 'completed');
      assert.equal(request.signal.aborted, true);
      const wire = provider === 'codex' ? 'decline' : scenario === 'allow' ? 'allow' : 'deny';
      assert.deepEqual(fixture.settlement, [wire]);
      assert.equal(await readFile(target, 'utf8'), marker);
      return { provider, scenario, wire, nativeExecution: false, settlementCount: 1 };
    } finally {
      finishHandler(approval(provider === 'claude' ? 'deny' : 'decline'));
      await session.close();
      assert.equal(session.state, 'closed');
      await model.close();
    }
  });
}

export async function runNativeApprovalFixtures() {
  const results = [];
  for (const scenario of ['allow', 'deny', 'cancel']) results.push(await runFixture('claude', scenario));
  for (const scenario of ['decline-file', 'decline-command', 'ceiling-refusal']) results.push(await runFixture('codex', scenario));
  return results;
}

export async function runLiveClaudeApproval() {
  const native = await import('@anthropic-ai/claude-agent-sdk');
  // Clamp the actual SDK tool set to Read and make Read ask even inside the workspace.
  const sdk = { query({ prompt, options }) {
    return native.query({
      prompt,
      options: {
        ...options, tools: ['Read'], allowedTools: [], settingSources: [],
        settings: { permissions: { ask: ['Read'] } },
      },
    });
  } };
  const runtime = new Runtime({ controlAdapters: [createClaudeControlRegistration({ sdk, sdkVersion: '0.3.252' })] });
  const results = [];
  for (const scenario of ['allow', 'deny']) {
    results.push(await withWorkspace(async (workspace, target) => {
      const model = agent('claude', workspace, runtime);
      const ready = await model.ready({ timeoutMs: 15_000 });
      const session = await model.openSession({ persistence: 'process' });
      let matched = 0;
      let requested = 0;
      try {
        const turn = await session.send(
          'Use your native Read tool exactly once on this absolute path: ' + target
            + '. Respond only with the file contents or DENEGADO if the read was denied. Do not use any other tool.',
          { timeoutMs: 45_000, async onInteraction(request) {
            requested++;
            checkBinding(request, 'claude');
            if (!exactClaudeRead(request, target) || request.signal.aborted) return approval('deny');
            matched++;
            return approval(scenario === 'allow' && matched === 1 ? 'allow' : 'deny');
          } },
        );
        assert.equal(turn.status, 'completed');
        assert.equal(requested, 1, 'Se esperaba una aprobación nativa durante el turno');
        assert.equal(matched, 1, 'La aprobación nativa debe corresponder a la lectura de la ficha');
        assert.equal(turn.text.trim(), scenario === 'allow' ? marker : 'DENEGADO');
        return { provider: 'claude', scenario, cliVersion: ready.installation.version,
          nativeExecution: true, nativeApprovals: matched, verifiedOutcome: true };
      } finally {
        await session.close();
        await model.close();
      }
    }));
  }
  return results;
}

export async function runLiveCodexApproval() {
  return withWorkspace(async (workspace, target) => {
    const runtime = new Runtime({ controlAdapters: [createCodexControlRegistration({
      // In this dedicated process, send approval requests to the calling app.
      args: ['--config', 'approvals_reviewer="user"', 'app-server', '--stdio'],
    })] });
    const model = agent('codex', workspace, runtime);
    const ready = await model.ready({ timeoutMs: 15_000 });
    const session = await model.openSession({ persistence: 'process' });
    const requests = [];
    try {
      const turn = await session.send(
        'Attempt one change of ficha.txt within the current work directory using the built-in apply_patch tool only. '
          + 'The application should decide any approval for the native edit. If the edit is denied, stop. '
          + 'Do not run commands or use other tools.',
        { timeoutMs: 45_000, async onInteraction(request) {
          checkBinding(request, 'codex');
          assert.ok(['file-change-approval', 'command-approval'].includes(request.kind));
          assert.ok(request.availableDecisions.includes('decline'));
          requests.push(request.binding.method);
          return approval('decline');
        } },
      );
      assert.equal(turn.status, 'completed');
      const observed = await readFile(target, 'utf8');
      assert.ok(observed === marker, 'La ficha temporal cambió. Solicitudes observadas: ' + requests.length);
      return [{ provider: 'codex', cliVersion: ready.installation.version, nativeExecution: true,
        requests, fileUnchanged: true,
        editEvents: turn.events.filter(event => event.type === 'tool.started'
          && ['fileChange', 'file_change', 'patchApply', 'patch_apply'].includes(event.name)).length,
        approvalObserved: requests.length > 0 }];
    } finally {
      await session.close();
      await model.close();
    }
  });
}

const entry = process.argv[1] && await realpath(process.argv[1]).catch(() => undefined);
if (entry === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  if (flags.length === 0) {
    console.log(JSON.stringify({ mode: 'fixtures', results: await runNativeApprovalFixtures() }, null, 2));
  } else if (flags.length === 1 && ['--live-claude', '--live-codex'].includes(flags[0])) {
    const run = flags[0] === '--live-claude' ? runLiveClaudeApproval : runLiveCodexApproval;
    console.log(JSON.stringify({ mode: 'live', results: await run() }, null, 2));
  } else {
    process.exitCode = 2;
    console.error('Uso: node labs/native-approval.mjs [--live-claude | --live-codex]');
  }
}
