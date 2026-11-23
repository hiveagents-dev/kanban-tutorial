import { AdmissionRefusedError, Agent } from 'hiveagents-runtime';
import { captureHostedRequest, createHostedRuntime } from 'hiveagents-runtime/hosted';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

function localClient() {
  let pending;
  let closed = false;
  function settle(key, value) {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    current.signal?.removeEventListener('abort', current.abort);
    current[key](value);
  }
  const onMessage = (message) => {
    if (message?.type !== 'reply' || !pending) return;
    const reply = message.reply;
    if (reply?.requestId !== pending.requestId) {
      settle('reject', new Error('Id de respuesta inesperado'));
      return;
    }
    settle('resolve', reply);
  };
  process.on('message', onMessage);
  const close = () => {
    closed = true;
    process.off('message', onMessage);
    process.off('disconnect', close);
    settle('reject', new Error('Canal cerrado'));
  };
  process.once('disconnect', close);
  return {
    call(request, { signal } = {}) {
      if (pending || closed || !process.connected || signal?.aborted) {
        return Promise.reject(new Error('Canal ocupado o cerrado'));
      }
      return new Promise((resolve, reject) => {
        const abort = () => settle('reject', new Error('El worker canceló la espera'));
        pending = {
          requestId: request.requestId, resolve, reject, signal, abort,
          timer: setTimeout(abort, request.remainingMs),
        };
        signal?.addEventListener('abort', abort, { once: true });
        process.send({ type: 'request', request }, (error) => {
          if (error && pending?.requestId === request.requestId) settle('reject', error);
        });
      });
    },
    close,
  };
}

async function execute(context, task, client) {
  if (task.kind === 'check-host-scope') {
    const descriptor = context.descriptors[0];
    // Ejercita la política del receptor con un mensaje válido que queda fuera de su alcance.
    const request = captureHostedRequest({
      schemaVersion: context.schemaVersion, channelId: context.channelId,
      systemId: context.systemId, generation: context.generation, bindingId: descriptor.bindingId,
      requestId: randomUUID(), remainingMs: 5_000, method: 'execute', recipeId: descriptor.probeRecipeId,
      turn: { mode: 'one-shot', modelId: descriptor.modelCatalog[0].id, cwd: task.cwd,
        prompt: '# Fuera del alcance', timeoutMs: 5_000, maxOutputBytes: 1_024 },
    });
    const reply = await client.call(request);
    return { status: reply.ok ? 'unexpected-success' : reply.error.code };
  }

  const agent = new Agent({
    model: 'claude/kanban-local', transport: 'exec', cwd: context.dataDirectory,
    permissions: { mode: 'analyze' }, environment: { mode: 'minimal' },
  }, createHostedRuntime({ ...context, client }));
  try {
    const review = await agent.run(task.markdown, { timeoutMs: 8_000, awaitSettlement: true });
    return { status: review.status, text: review.text };
  } catch (error) {
    if (!(error instanceof AdmissionRefusedError)) throw error;
    return { status: error.code, reason: error.reason, receiptDigest: error.context.sanitizedDiagnostics?.receiptDigest };
  } finally {
    await agent.close();
  }
}

const [bootstrap] = await once(process, 'message', { signal: AbortSignal.timeout(10_000) });
const client = localClient();
try {
  const result = await execute(bootstrap.context, bootstrap.task, client);
  await new Promise((resolve, reject) => process.send({ type: 'result', result }, error => error ? reject(error) : resolve()));
} finally {
  client.close();
  if (process.connected) process.disconnect();
}
