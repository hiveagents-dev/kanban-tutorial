import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Agent, Runtime } from 'hiveagents-runtime';
import cases from './fixtures/kanban-benchmark.mjs';

const defaults = 'claude/claude-sonnet-5,codex/gpt-5.6-sol';
const { values: options } = parseArgs({ options: {
  live: { type: 'boolean' }, out: { type: 'string' }, models: { type: 'string', default: defaults },
  format: { type: 'string', default: 'structured' }, repeats: { type: 'string', default: '1' },
  roles: { type: 'string', default: 'planificar,redactar,revisar' }, cases: { type: 'string' },
} });
if (!options.live) {
  console.log('node labs/benchmark.mjs --live --out resultado.json [--format structured|text] [--models proveedor/modelo,...] [--repeats 1] [--roles planificar,redactar,revisar] [--cases id1,id2]');
  process.exit(0);
}
const format = options.format;
const models = options.models.split(',');
const roles = options.roles.split(',');
const repeats = Number(options.repeats);
assert.ok(options.out && ['structured', 'text'].includes(format));
assert.ok(models.length >= 1 && models.length <= 4 && models.length === new Set(models).size);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 3);
assert.ok(roles.length && roles.every(role => cases.some(test => test.role === role)));

assert.ok(!process.env.HIVE_GEMINI_AUTH || ['vertex', 'api-key'].includes(process.env.HIVE_GEMINI_AUTH));

const timeoutMs = 120_000;
const runtime = new Runtime();
const profiles = {
  claude: { instructions: 'Respondé al ejercicio con su salida solicitada y no uses herramientas.', permissions: { mode: 'respond' }, requireAuth: 'subscription', context: { profile: 'clean', memory: 'off' },
    providerOptions: { claude: { systemPromptMode: 'replace', tools: [] } } },
  codex: { permissions: { mode: 'analyze', minimumEnforcement: 'sandbox' }, requireAuth: 'subscription', context: { profile: 'native', memory: 'off' },
    providerOptions: { codex: { skipGitRepoCheck: true, ignoreRules: true, ignoreUserConfig: true, ephemeral: true } } },
  gemini: { permissions: { mode: 'analyze' }, requireAuth: 'any' },
  antigravity: { permissions: { mode: 'edit' } },
};
const resolved = models.map(input => {
  const { provider, id } = runtime.resolveModel(input);
  assert.ok(Object.hasOwn(profiles, provider));
  if (format === 'structured') assert.ok(['claude', 'codex'].includes(provider), 'Gemini y Antigravity requieren --format text.');
  return { model: provider + '/' + id, provider };
});
assert.equal(resolved.length, new Set(resolved.map(item => item.model)).size, 'Hay alias duplicados.');

const metadata = new URL('../package.json', import.meta.resolve('hiveagents-runtime'));
const { name, version } = JSON.parse(await readFile(metadata, 'utf8'));
const digest = input => createHash('sha256').update(input).digest('hex');
const corpusSha256 = digest(await readFile(new URL('./fixtures/kanban-benchmark.mjs', import.meta.url)));
const runnerSha256 = digest(await readFile(new URL(import.meta.url)));
const startedAt = new Date().toISOString();
const selectedIds = options.cases?.split(',');
assert.ok(!selectedIds || selectedIds.every(id => cases.some(item => item.id === id)), 'Caso desconocido.');
const selected = cases.filter(item => roles.includes(item.role) && (!selectedIds || selectedIds.includes(item.id)));
assert.ok(selected.length, 'Seleccioná al menos un caso.');
const work = await mkdtemp(join(tmpdir(), 'kanban-benchmark-'));

function parseText(text, schema) {
  const output = JSON.parse(text.trim().replace(/^\x60{3}json\s*([\s\S]+?)\s*\x60{3}$/i, '$1'));
  assert.ok(output && typeof output === 'object' && !Array.isArray(output));
  assert.equal(Object.keys(output).length, schema.required.length);
  for (const [key, rule] of Object.entries(schema.properties)) {
    assert.ok(Object.hasOwn(output, key));
    if (rule.enum) assert.ok(rule.enum.includes(output[key]));
    if (rule.type) assert.equal(typeof output[key], rule.type);
  }
  return output;
}
function errorCode(error) {
  if (error instanceof SyntaxError || error instanceof assert.AssertionError) return 'INVALID_JSON_OUTPUT';
  return typeof error?.code === 'string' && /^[A-Z][A-Z_]{2,80}$/.test(error.code) ? error.code : 'ERROR';
}
function reportedUsage(usage) {
  const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'reportedCostUsd'];
  const details = Object.fromEntries(fields.filter(key => Number.isFinite(usage?.[key]) && usage[key] >= 0).map(key => [key, usage[key]]));
  return { ...details, costMeaning: usage?.costMeaning ?? 'unavailable' };
}

async function execute(item, arm, round) {
  const cwd = await mkdtemp(join(work, 'turno-'));
  const cell = { model: arm.model, role: item.role, case: item.id, round, status: 'preflight', passed: false };
  const totalStarted = performance.now();
  const geminiEnv = arm.provider === 'gemini' && process.env.HIVE_GEMINI_AUTH;
  const passthrough = geminiEnv === 'vertex'
    ? ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS']
    : ['GEMINI_API_KEY'];
  const environment = geminiEnv ? {
    mode: 'minimal', passthrough, variables: {
      GEMINI_CLI_HOME: await mkdtemp(join(work, 'gemini-')),
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      ...(geminiEnv === 'vertex' ? { GOOGLE_GENAI_USE_VERTEXAI: 'true' } : {}),
    },
  } : { mode: 'minimal' };
  const agent = new Agent({
    ...profiles[arm.provider], model: arm.model, cwd, transport: 'exec', environment,
    timeoutMs, memory: false,
  }, runtime);
  try {
    const ready = await agent.ready({ timeoutMs: 20_000, awaitSettlement: true });
    cell.cliVersion = ready.installation?.version;
    cell.authSource = ready.auth?.source;
    cell.preflightMs = Math.round(performance.now() - totalStarted);
    const prompt = item.task + '\nNo uses herramientas. Respondé sólo con un objeto JSON que respete este esquema. ' + JSON.stringify(item.schema);
    cell.status = 'turn';
    const started = performance.now();
    try {
      const result = await agent.run(prompt, { timeoutMs, awaitSettlement: true,
        ...(format === 'structured' ? { outputSchema: item.schema } : {}),
      });
      cell.turnMs = Math.round(performance.now() - started);
      cell.status = result.status;
      cell.usage = reportedUsage(result.usage);
      if (result.status === 'completed') {
        const answer = format === 'structured' ? result.output : parseText(result.text, item.schema);
        cell.outputSha256 = digest(JSON.stringify(answer));
        cell.checks = item.verify(answer);
        cell.passed = Object.values(cell.checks).every(Boolean);
      }
    } finally {
      cell.turnMs ??= Math.round(performance.now() - started);
    }
  } catch (error) {
    cell.errorCode = errorCode(error);
  } finally {
    await agent.close();
  }
  cell.totalMs = Math.round(performance.now() - totalStarted);
  return cell;
}
function median(values) {
  const ordered = values.toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return !ordered.length ? null : ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
function summarize(rows) {
  const passed = rows.filter(row => row.passed);
  const completed = rows.filter(row => row.status === 'completed');
  const priced = completed.map(row => row.usage).filter(usage => usage?.reportedCostUsd !== undefined);
  const meanings = new Set(priced.map(usage => usage.costMeaning));
  return {
    attempted: rows.length, completed: completed.length, passed: passed.length,
    medianPassedTurnMs: median(passed.map(row => row.turnMs)), medianPassedTotalMs: median(passed.map(row => row.totalMs)),
    cost: completed.length && priced.length === completed.length && meanings.size === 1
      ? { meaning: priced[0].costMeaning, sumUsd: priced.reduce((sum, usage) => sum + usage.reportedCostUsd, 0), turns: priced.length }
      : null,
  };
}

const cells = [];
try {
  for (let round = 0; round < repeats; round++) {
    for (const [index, item] of selected.entries()) {
      const offset = (round + index) % resolved.length;
      for (const arm of [...resolved.slice(offset), ...resolved.slice(0, offset)]) {
        const cell = await execute(item, arm, round + 1);
        cells.push(cell);
        console.log(arm.model, item.id, cell.passed ? 'PASS' : cell.errorCode ?? 'FAIL', cell.turnMs ?? '–', 'ms');
      }
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
const summary = resolved.map(({ model }) => {
  const rows = cells.filter(cell => cell.model === model);
  return { model, ...summarize(rows), byRole: Object.fromEntries(roles
    .map(role => [role, summarize(rows.filter(row => row.role === role))])) };
});
const report = {
  formatVersion: 1, kind: 'kanban-provider-benchmark', sdk: name + '@' + version,
  startedAt, finishedAt: new Date().toISOString(), format, repeats,
  host: { platform: process.platform, arch: process.arch, node: process.version }, corpusSha256, runnerSha256,
  method: { selectedCases: selected.map(item => item.id), order: 'rotated model order per case',
    timings: 'wall clock, total includes preflight and close', latencySample: 'turns passing every check',
    retries: 0, workspace: 'isolated temporary directory per turn', timeoutMs, output: 'checks and digest only' },
  cells, summary,
};
await writeFile(options.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.table(summary.map(({ model, passed, attempted, medianPassedTurnMs, cost }) => ({ model, passed, attempted,
  medianPassedTurnMs, reportedCostUsd: cost?.sumUsd ?? '–', costMeaning: cost?.meaning ?? 'unavailable' })));
