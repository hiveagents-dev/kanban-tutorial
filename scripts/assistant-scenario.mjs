const DAY = 24 * 60 * 60 * 1000;

export function assistantScenario(now = Date.now()) {
  const date = new Date(now - 16 * DAY).toISOString();
  return {
    id: 'A2', title: 'A2 · Documentar cómo recuperar un ciclo',
    brief: 'Prepará una guía para recuperar un ciclo detenido. Explicá qué queda bloqueado y cómo volver a ejecutar la tarjeta.',
    requiredTerms: ['Recuperación', 'Reintentar'],
    status: 'blocked', attempts: 2, artifact: '# Recuperación\n\nEl ciclo se reanuda al abrir la aplicación.',
    checks: [
      { name: 'Documento con contenido', passed: true },
      { name: 'Incluye «Recuperación»', passed: true },
      { name: 'Incluye «Reintentar»', passed: false },
    ],
    events: [
      { at: date, role: 'system', message: 'Tarjeta creada para la demo del asistente.' },
      { at: date, role: 'planner', message: 'La recuperación de ciclos necesita una guía verificable.' },
      { at: date, role: 'checks', message: 'Falta «Reintentar» en el documento.' },
      { at: date, role: 'system', message: 'Se agotaron los dos intentos. Revisá el último borrador y la devolución.' },
    ],
  };
}
