import assert from 'node:assert/strict';
import { runToolDemo } from './control-tools.ts';

const [mode = 'mock', model] = process.argv.slice(2);
assert.ok(['mock', 'claude', 'codex'].includes(mode), 'Elegí mock, claude o codex.');
if (mode !== 'mock') assert.ok(model?.startsWith(mode + '/'), 'Indicá el modelo con su prefijo.');
const { readCalls, writeCalls, output, summary, session } = await runToolDemo({ mode, model });
assert.equal(readCalls, 1);
assert.equal(writeCalls, 1);
assert.equal(summary, 'Operations document reviewed.');
console.log(JSON.stringify({ mode, readCalls, writeCalls, output, summary, provider: session.provider,
  transport: session.transport, persistence: session.persistence }, null, 2));
