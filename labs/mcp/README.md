# Leer la memoria de una tarjeta por MCP

Un cliente de Model Context Protocol abre un proceso Node por stdio, descubre `memory_search` y consulta el término «liquidación». El servidor atiende la búsqueda con `serveMemoryMcp` de HiveAgents Runtime. La referencia se limita a la tarjeta Pagos y queda en memoria durante la ejecución.

Desde la carpeta del tutorial, instalá el cliente MCP opcional y la beta del SDK en una carpeta temporal.

```sh
mcp_lab_dir=$(mktemp -d)
cp labs/mcp/client.mjs labs/mcp/server.mjs "$mcp_lab_dir/"
cd "$mcp_lab_dir"
npm install --prefix "$mcp_lab_dir" --ignore-scripts --no-audit --no-fund hiveagents-runtime@0.1.0-beta.3 @modelcontextprotocol/sdk@1.29.0
node client.mjs
```

La salida contiene «La liquidación semanal cierra el viernes». El cliente comprueba el identificador del registro y que `memory_search` sea la única herramienta expuesta. El ejercicio usa IPC real entre dos procesos locales y consume cero turnos de modelo.

Para implementar el servidor en tu aplicación, reemplazá el proveedor del glosario por el almacenamiento que uses para las referencias aprobadas. El laboratorio de memoria muestra cómo hacer esa promoción en SQLite. [Servidor](server.mjs) · [Cliente](client.mjs) · [Memoria por tarjeta](../memory.mjs)
