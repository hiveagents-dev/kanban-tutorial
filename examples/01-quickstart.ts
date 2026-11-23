/**
 * Quickstart: one turn on Claude Code and one on Codex using local CLI logins.
 *
 * The provider is inferred from the model — `opus-5` resolves to the installed
 * `claude` CLI, `gpt-5.6-sol` to `codex` — and both run under the login you
 * already have on this machine.
 *
 * Run: node --experimental-strip-types examples/01-quickstart.ts
 * Cost: two model turns against your own subscriptions.
 */
import { Agent } from 'hiveagents-runtime';

const architect = new Agent({
  model: 'opus-5',
  permissions: { mode: 'analyze' },
});

const reviewer = new Agent({
  model: 'gpt-5.6-sol',
  permissions: { mode: 'analyze', strict: false },
});

// Independent one-shot turns. This is composition by the application, not
// orchestration by the SDK: Promise.all is just Promise.all.
const [architecture, code] = await Promise.all([
  architect.run('Name the single biggest architectural risk in a local-first agent SDK. One sentence.'),
  reviewer.run('Name the single biggest security risk in spawning local CLIs from a library. One sentence.'),
]);

console.log(`[claude/opus-5]    ${architecture.text.trim()}`);
console.log(`[codex/gpt-5.6-sol] ${code.text.trim()}`);

// Usage is reported as the provider reports it. `costMeaning` says what the
// number is: an API-equivalent price is not what a subscription turn charges.
for (const turn of [architecture, code]) {
  console.log(`${turn.session.provider}: status=${turn.status} costMeaning=${turn.usage?.costMeaning ?? 'unavailable'}`);
}

await Promise.all([architect.close(), reviewer.close()]);
