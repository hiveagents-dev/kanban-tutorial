import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const lab = fileURLToPath(new URL('../labs/native-approval.mjs', import.meta.url));

test('native Control approvals are correlated and settle once without model turns', async () => {
  const { stdout } = await run(process.execPath, [lab], { timeout: 20_000 });
  const { mode, results } = JSON.parse(stdout);
  assert.equal(mode, 'fixtures');
  assert.deepEqual(results.map(({ provider, scenario, wire }) => [provider, scenario, wire]), [
    ['claude', 'allow', 'allow'],
    ['claude', 'deny', 'deny'],
    ['claude', 'cancel', 'deny'],
    ['codex', 'decline-file', 'decline'],
    ['codex', 'decline-command', 'decline'],
    ['codex', 'ceiling-refusal', 'decline'],
  ]);
  assert.ok(results.every(row => row.nativeExecution === false && row.settlementCount === 1));
});
