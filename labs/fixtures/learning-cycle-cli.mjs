import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const model = process.argv[2];
const { document, field } = JSON.parse(readFileSync(0, 'utf8'));
const value = new Map(document.split('\n').slice(1).map(line => line.split(': '))).get(field);

// The workspace file simulates a service whose answers change over time,
// while the installed executable and the model IDs stay the same.
const phase = readFileSync('phase.txt', 'utf8').trim();
const inaccurate = phase === 'initial' ? 'base' : 'especialista';
if (!['base', 'especialista'].includes(model) || !value || !['initial', 'drift'].includes(phase)) {
  throw new Error('Invalid fixture request');
}
const answer = field === 'Prioridad' && model === inaccurate ? 'desconocida' : value;
console.log(JSON.stringify({ sessionId: randomUUID(), answer }));
