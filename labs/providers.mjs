// Inspecciona la instalación local sin enviar prompts.
import assert from 'node:assert/strict';
import { Agent, AgentRuntimeError, Runtime, doctor } from 'hiveagents-runtime';

const runtime = new Runtime();
const report = await doctor({ runtime, environment: { mode: 'minimal' } });
assert.deepEqual(report.providers.map(row => row.provider).sort(), ['antigravity', 'claude', 'codex', 'gemini']);

console.table(report.providers.map(({ provider, installation, auth, models, warnings }) => ({
  proveedor: provider,
  versión: installation.version ?? 'sin detectar',
  autenticación: auth.state ?? (auth.authenticated ? 'authenticated' : 'not-authenticated'),
  modelosEnCatálogo: models.models.length,
  avisos: warnings.map(warning => warning.code).join(', '),
})));

for (const [model, mode] of [
  ['gemini/gemini-2.5-flash', 'analyze'],
  ['antigravity/flash-low', 'edit'],
]) {
  const agent = new Agent({ model, permissions: { mode }, environment: { mode: 'minimal' } }, runtime);
  try {
    const { plan, capabilities } = await agent.ready({ timeoutMs: 15_000, awaitSettlement: true });
    assert.equal(plan.transport, 'exec');
    assert.equal(capabilities.features.structuredOutput, 'unsupported');
    console.log(model, {
      permisos: capabilities.enforcement.effective,
      turnos: capabilities.features.turns,
      esquemaDeSalida: capabilities.features.structuredOutput,
      evidencia: plan.capabilities.turns.evidence.map(item => item.source),
    });
  } catch (error) {
    // Un CLI ausente o una credencial inválida son resultados útiles del diagnóstico.
    if (!(error instanceof AgentRuntimeError)) throw error;
    console.log(model, 'Preflight sin completar:', error.code);
  } finally {
    await agent.close();
  }
}
console.log('Los cuatro registros vienen en el SDK. La disponibilidad del modelo depende de la cuenta y se comprueba con un turno real.');
