// Host de protocolo en memoria. Las sondas y las respuestas son sintéticas.
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClaudeProvider } from 'hiveagents-runtime';
import { captureHostedRequest, hostedDigest } from 'hiveagents-runtime/hosted';

export async function exampleHost(cwd) {
  const provider = createClaudeProvider();
  const modelId = 'kanban-lab';
  const modelCatalog = [{ id: modelId, provider: provider.id, aliases: [], source: 'explicit', availability: 'available' }];
  const recipe = {
    recipeId: randomUUID(), contextArgs: [],
    permissionArgs: provider.translatePermissions({ mode: 'analyze' }, 'exec').args,
    providerOptionsDigest: hostedDigest({}), clientEnvironmentPolicyDigest: hostedDigest({ mode: 'minimal' }),
    environmentPolicyId: 'laboratorio', modelIds: [modelId], efforts: [], allowInstructions: false, cwdRoots: [cwd],
  };
  // El destino identifica al proveedor simulado. El laboratorio nunca lanza ese ejecutable.
  const command = join(cwd, 'cli-simulado');
  const fixture = '#!/usr/bin/env node\nprocess.exit(1);\n';
  await writeFile(command, fixture, { mode: 0o700 });
  const descriptor = {
    schemaVersion: 1, provider: provider.id, bindingId: randomUUID(),
    token: provider.exec.token, adapterVersion: provider.exec.adapterVersion, modelCatalog,
    execCapabilities: {}, target: { command, argsPrefix: [], identityFiles: [], executableDigest: createHash('sha256').update(fixture).digest('hex') },
    probeRecipeId: recipe.recipeId, recipes: [{ ...recipe, recipeDigest: hostedDigest(recipe) }],
    limits: { maxTurnMs: 30000, maxProbeMs: 5000, maxOutputBytes: 16384 },
  };
  descriptor.bindingDigest = hostedDigest(descriptor);
  const channel = { schemaVersion: 1, systemId: 'kanban-lab', generation: 1, channelId: randomUUID().replaceAll('-', '') };
  const probes = {
    detect: { installed: true, path: command, realpath: command, launchTarget: { command, argsPrefix: [] }, version: 'laboratorio' },
    compatibility: { provider: provider.id, cliVersion: 'laboratorio', transport: 'exec', evidence: 'unverified',
      features: { turns: 'supported' }, missingFlags: [], knownIssues: [] },
    auth: { authenticated: true, source: 'subscription' },
    models: modelCatalog,
  };

  let occupied = false;
  let executions = 0;
  const client = {
    async call(message) {
      const request = captureHostedRequest(message);
      const reply = { ...channel, bindingId: descriptor.bindingId, requestId: request.requestId };
      const refuse = () => ({ ...reply, ok: false, error: { code: 'INVALID_RUNTIME_PROTOCOL' } });
      if (request.channelId !== channel.channelId || request.systemId !== channel.systemId
          || request.generation !== channel.generation || request.bindingId !== descriptor.bindingId
          || request.recipeId !== recipe.recipeId) return refuse();

      if (Object.hasOwn(probes, request.method) && request.cwd === cwd) {
        return { ...reply, ok: true, data: probes[request.method] };
      }
      if (request.method !== 'execute' || request.turn.modelId !== modelId || request.turn.cwd !== cwd) return refuse();

      if (occupied) {
        return { ...reply, ok: false, error: {
          code: 'ADMISSION_REFUSED', reason: 'concurrency-limit', receiptDigest: hostedDigest({ requestId: request.requestId, occupied }),
        } };
      }
      executions++;
      const text = request.turn.prompt.includes('## Evidencia') ? 'Contiene la sección de evidencia.' : 'Falta la sección de evidencia.';
      return { ...reply, ok: true, data: { completed: true, failed: false, refused: false, sessionId: randomUUID(), text, events: [], nativeEvents: [] } };
    },
    close() {},
  };
  return {
    worker: { ...channel, dataDirectory: cwd, descriptors: [descriptor], client },
    occupySlot() { occupied = true; },
    countExecutions() { return executions; },
  };
}
