// Comprueba los dos requisitos para negociar Control sin abrir sesiones ni consumir turnos.
import assert from 'node:assert/strict';
import {
  Agent, AgentRuntimeError, RequiredTransportUnavailableError, Runtime, UnsupportedCapabilityError,
  createClaudeControlRegistration, createCodexControlRegistration,
} from 'hiveagents-runtime';

const standard = new Runtime();
const control = new Runtime({
  controlAdapters: [createClaudeControlRegistration(), createCodexControlRegistration()],
});
for (const model of ['claude/sonnet', 'codex/gpt-5.6-sol']) {
  const options = { model, transport: 'control', permissions: { mode: 'analyze' }, environment: { mode: 'minimal' } };
  await assert.rejects(new Agent(options, standard).ready(), RequiredTransportUnavailableError);
  await assert.rejects(new Agent(options, control).ready(), UnsupportedCapabilityError);
  const registration = control.controlRegistration(control.resolveModel(model).provider);
  console.log(model, 'capacidades declaradas:', {
    aprobaciones: registration.capabilityVerdicts.interactiveApprovals,
    cambioDePermisos: registration.capabilityVerdicts.dynamicPermissions,
    evidencia: registration.evidenceSource,
  });

  const agent = new Agent({ ...options, providerOptions: { experimentalControl: true } }, control);
  try {
    const { plan } = await agent.ready({ timeoutMs: 15_000, awaitSettlement: true });
    assert.equal(plan.transport, 'control');
    console.log('Control negociado:', model, plan.fingerprint.protocolVersion);
  } catch (error) {
    if (!(error instanceof AgentRuntimeError)) throw error;
    console.log(model, 'Preflight sin completar:', error.code);
  } finally {
    await agent.close();
  }
}
console.log('Para ejecutar un turno de Control hacen falta el CLI autenticado y sus dependencias de transporte. Este laboratorio termina en el preflight.');
