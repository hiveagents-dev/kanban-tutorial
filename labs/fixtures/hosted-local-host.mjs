import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeProvider } from 'hiveagents-runtime';
import { runProcess } from 'hiveagents-runtime/adapter-kit';
import { captureHostedDescriptor, captureHostedReply, captureHostedRequest, hostedDigest } from 'hiveagents-runtime/hosted';
import { HostLedger, LaunchRefusedError } from 'hiveagents-runtime/orchestration';

const hostProvider = 'claude';
const modelId = 'kanban-local';
const workerFile = new URL('./hosted-local-worker.mjs', import.meta.url);
const maxTurnMs = 8_000;
const maxOutputBytes = 1_024;

async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function openLocalHost({ directory, cwd, onFirstOutput }) {
  const target = await realpath(process.execPath);
  const cli = await realpath(fileURLToPath(new URL('./hosted-review-cli.mjs', import.meta.url)));
  const [executableDigest, cliDigest] = await Promise.all([fileDigest(target), fileDigest(cli)]);
  // La traducción pública permite reutilizar el proxy de Claude para un programa local determinista.
  const provider = createClaudeProvider();
  const modelCatalog = [{ id: modelId, provider: hostProvider, source: 'explicit', availability: 'available', aliases: [] }];
  const recipe = {
    recipeId: randomUUID(), contextArgs: [],
    permissionArgs: provider.translatePermissions({ mode: 'analyze' }, 'exec').args,
    providerOptionsDigest: hostedDigest({}), clientEnvironmentPolicyDigest: hostedDigest({ mode: 'minimal' }),
    environmentPolicyId: 'local-reference', modelIds: [modelId], efforts: [], allowInstructions: false, cwdRoots: [cwd],
  };
  const descriptorData = {
    schemaVersion: 1, provider: hostProvider, bindingId: randomUUID(),
    token: provider.exec.token, adapterVersion: provider.exec.adapterVersion, modelCatalog,
    execCapabilities: { turns: 'supported' },
    target: { command: target, argsPrefix: [cli], identityFiles: [cli], executableDigest },
    probeRecipeId: recipe.recipeId, recipes: [{ ...recipe, recipeDigest: hostedDigest(recipe) }],
    limits: { maxTurnMs, maxProbeMs: 5_000, maxOutputBytes },
  };
  const descriptor = captureHostedDescriptor({ ...descriptorData, bindingDigest: hostedDigest(descriptorData) });
  const probes = {
    detect: { installed: true, path: target, realpath: target, identityFiles: [cli],
      launchTarget: { command: target, argsPrefix: [cli] }, version: 'local-reference' },
    compatibility: { provider: hostProvider, cliVersion: 'local-reference', transport: 'exec',
      evidence: 'unverified', features: { turns: 'supported', resume: 'unsupported' }, missingFlags: [], knownIssues: [] },
    auth: { authenticated: true, source: 'oss' },
    models: modelCatalog,
  };
  const ledger = new HostLedger({ databasePath: join(directory, 'admission.sqlite'),
    concurrency: { mode: 'limited', maxConcurrent: 1 } });
  const workers = new Set();
  const counters = { dispatches: 0, capacityRefusals: 0, scopeRefusals: 0 };
  const admissionReasons = new Set(['concurrency-limit', 'hourly-limit', 'daily-limit', 'quota-cooldown', 'wait-timeout']);

  async function respond(message, channel, seen, signal) {
    const request = captureHostedRequest(message);
    const header = { ...channel, bindingId: descriptor.bindingId, requestId: request.requestId };
    const accept = (data) => captureHostedReply({ ...header, ok: true, data });
    const reject = (error) => captureHostedReply({ ...header, ok: false, error });
    const halted = () => reject({ code: 'EXECUTION_HALTED' });

    if (request.channelId !== channel.channelId || request.systemId !== channel.systemId
      || request.generation !== channel.generation || request.bindingId !== descriptor.bindingId
      || request.recipeId !== recipe.recipeId || seen.has(request.requestId)) return halted();
    seen.add(request.requestId);

    if (Object.hasOwn(probes, request.method)) return request.cwd === cwd ? accept(probes[request.method]) : halted();
    if (request.method !== 'execute') return reject({ code: 'UNSUPPORTED_CAPABILITY' });
    const turn = request.turn;
    if (turn.cwd !== cwd || turn.modelId !== modelId || turn.mode !== 'one-shot'
      || Buffer.byteLength(turn.prompt) > 4_096
      || ['sessionId', 'instructions', 'effort', 'outputSchema', 'intentId', 'priority'].some(key => Object.hasOwn(turn, key))) {
      counters.scopeRefusals++;
      return halted();
    }

    try {
      const result = await ledger.withSlot(hostProvider, 'worker:' + channel.channelId, { maxWaitMs: 0, signal }, async () => {
        if (await fileDigest(target) !== executableDigest || await fileDigest(cli) !== cliDigest) {
          throw new Error('Cambió el programa registrado');
        }
        signal.throwIfAborted();
        const firstDispatch = ++counters.dispatches === 1;
        return runProcess({
          command: target, args: [cli], cwd, env: {}, stdin: turn.prompt, signal,
          timeoutMs: Math.min(turn.timeoutMs, request.remainingMs, maxTurnMs),
          maxOutputBytes: Math.min(turn.maxOutputBytes, maxOutputBytes),
          ...(firstDispatch && onFirstOutput ? { onStdoutAsync: onFirstOutput } : {}),
        });
      });
      if (result.code !== 0 || result.signal !== null) return reject({ code: 'PROVIDER_UNAVAILABLE' });
      return accept({
        completed: true, failed: false, refused: false, sessionId: randomUUID(),
        text: result.stdout, events: [], nativeEvents: [],
      });
    } catch (error) {
      if (error instanceof LaunchRefusedError && admissionReasons.has(error.admission.reason)) {
        const reason = error.admission.reason;
        counters.capacityRefusals++;
        return reject({ code: 'ADMISSION_REFUSED', reason, receiptDigest: hostedDigest({ ...header, reason }) });
      }
      if (['ABORTED', 'TIMEOUT', 'OUTPUT_LIMIT'].includes(error?.code)) return reject({ code: error.code });
      return halted();
    }
  }

  function runWorker(task) {
    const channel = { schemaVersion: 1, systemId: 'kanban-local', generation: 1, channelId: randomUUID().replaceAll('-', '') };
    const child = fork(workerFile, [], { cwd, env: {}, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const abort = new AbortController();
    const completion = Promise.withResolvers();
    const entry = { child, done: completion.promise };
    workers.add(entry);
    let job;
    let outcome;
    let failure;
    const seen = new Set();
    const fail = (error) => {
      failure ??= error;
      abort.abort();
      child.kill();
    };
    const deadline = setTimeout(() => fail(new Error('Venció el plazo del worker')), 12_000);
    child.on('error', fail);
    child.once('disconnect', () => abort.abort());
    child.on('message', (message) => {
      if (message?.type === 'result') { outcome = message.result; return; }
      if (message?.type !== 'request' || job || seen.size >= 24) {
        fail(new Error('Solicitud del worker fuera del contrato'));
        return;
      }
      job = respond(message.request, channel, seen, abort.signal).then(
        (reply) => {
          job = undefined;
          if (child.connected) child.send({ type: 'reply', reply }, error => { if (error && child.connected) fail(error); });
        },
        (error) => { job = undefined; fail(error); },
      );
    });
    child.once('close', async (code) => {
      clearTimeout(deadline);
      abort.abort();
      await job;
      workers.delete(entry);
      completion.resolve(failure || code !== 0 || !outcome
        ? { status: 'worker-failed', reason: failure?.message ?? `exit ${code}` }
        : outcome);
    });
    child.send({ context: { ...channel, dataDirectory: cwd, descriptors: [descriptor] }, task },
      error => { if (error) fail(error); });
    return entry.done;
  }

  return {
    runWorker,
    status: () => ({ ...counters, active: ledger.status(hostProvider).status?.active }),
    async close() {
      for (const { child } of workers) child.kill();
      await Promise.all([...workers].map(worker => worker.done));
      ledger.close();
    },
  };
}
