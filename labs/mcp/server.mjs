import { serveMemoryMcp } from 'hiveagents-runtime/memory-tools';

const scope = { tenant: 'editorial', namespace: 'kanban', subject: 'tarjeta-pagos' };
const term = { id: 'cierre', source: 'glosario', text: 'La liquidación semanal cierra el viernes.' };
const provider = {
  id: 'glosario-pagos',
  async recall(request) {
    if (request.scope.tenant !== scope.tenant || request.scope.namespace !== scope.namespace ||
        request.scope.subject !== scope.subject) return [];
    return term.text.toLowerCase().includes(request.text.toLowerCase()) ? [term] : [];
  },
};

// stdout lleva únicamente mensajes MCP. El cierre del cliente termina el servidor.
await serveMemoryMcp({
  name: 'kanban-memory', provider, scope, input: process.stdin, output: process.stdout,
}).closed;
