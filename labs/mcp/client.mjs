import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { memoryMcpRecipe } from 'hiveagents-runtime/memory-tools';

const recipe = memoryMcpRecipe({
  name: 'kanban-memory', executable: process.execPath, script: fileURLToPath(new URL('./server.mjs', import.meta.url)),
});
const client = new Client({ name: 'lector-kanban', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: recipe.command, args: recipe.args, env: recipe.env }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['memory_search']);
  const response = await client.callTool({ name: 'memory_search', arguments: { query: 'liquidación' } });
  assert.ok(!response.isError);
  const [item] = response.structuredContent.items;
  assert.equal(item.id, 'cierre');
  console.log('El cliente MCP encontró una herramienta y recuperó esta referencia:', item.text);
} finally {
  await client.close();
}
