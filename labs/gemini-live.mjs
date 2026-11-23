import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, Runtime, createDefaultProviders, createGeminiCliProvider } from 'hiveagents-runtime';
import { runProcess } from 'hiveagents-runtime/adapter-kit';

const model = process.env.HIVE_GEMINI_MODEL;
const mode = process.env.HIVE_GEMINI_AUTH ?? 'vertex';
const passthrough = mode === 'vertex'
  ? ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS']
  : ['GEMINI_API_KEY'];
const installed = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('hiveagents-runtime')), 'utf8'));
const timeoutMs = 60_000;
const script = fileURLToPath(import.meta.url);
const release = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;

function observedReasons(data) {
  const entries = {
    unsupportedClient: /UNSUPPORTED_CLIENT/,
    apiDisabled: /SERVICE_DISABLED|API has not been used|API is disabled/i,
    permissionDenied: /PERMISSION_DENIED|permission .* denied|does not have permission/i,
    credentialRejected: /UNAUTHENTICATED|invalid[_ ]grant|invalid credential|API_KEY_INVALID/i,
    workspaceUntrusted: /not trusted|workspace trust/i,
    modelUnavailable: /NOT_FOUND|publisher model.*not found/i,
    billingRequired: /billing .* (?:disabled|required|not enabled)/i,
    uriProxyError: /ENOTFOUND|ECONNREFUSED|fetch failed/i,
  };
  return Object.entries(entries).filter(([, pattern]) => pattern.test(data)).map(([code]) => code);
}

async function runChild() {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const data = JSON.parse(input);
  const diagnostics = [];
  let launched = 0;
  let cliReportedRequestedModel;
  const runner = async request => {
    const isTurn = request.args.some(arg => arg.startsWith('--prompt='));
    if (isTurn) assert.equal(++launched, 1);
    const result = await runProcess(request);
    if (isTurn) {
      diagnostics.push(...observedReasons(result.stderr + '\n' + result.stdout));
      for (const line of result.stdout.split('\n')) {
        try {
          const frame = JSON.parse(line);
          if (frame?.type === 'init' && typeof frame.model === 'string') {
            cliReportedRequestedModel = frame.model === model.split('/')[1];
            break;
          }
        } catch {
          // The installed SDK validates the complete JSONL stream.
        }
      }
    }
    return result;
  };
  const runtime = new Runtime({
    providers: [...createDefaultProviders().filter(p => p.id !== 'gemini'), createGeminiCliProvider({ runner })],
  });
  const agent = new Agent({
    model, cwd: data.workspace, permissions: { mode: 'analyze' },
    requireAuth: 'any', memory: false,
    environment: {
      mode: 'minimal', passthrough,
      variables: { GEMINI_CLI_HOME: data.cliHome, GEMINI_CLI_TRUST_WORKSPACE: 'true', ...(mode === 'vertex' ? { GOOGLE_GENAI_USE_VERTEXAI: 'true' } : {}) },
    },
  }, runtime);
  let ready;
  let session;
  const started = performance.now();
  try {
    ready = await agent.ready();
    session = await agent.openSession(data.ref ? { resume: data.ref } : {});
    const turn = await session.send(data.prompt, { timeoutMs, awaitSettlement: true });
    process.stdout.write(JSON.stringify({
      launched, status: turn.status, text: turn.text, ref: session.export(),
      authSource: ready.auth.source, authStateAtPreflight: ready.auth.state,
      cli: release(ready.installation.version), cliReportedRequestedModel,
      elapsedMs: Math.round(performance.now() - started),
      toolCallObserved: turn.events.some(event => event.type === 'tool.started'),
      writeToolCallObserved: turn.events.some(event => event.type === 'tool.started' && event.name === 'write_file'),
      usage: turn.usage ? {
        costMeaning: 'unavailable', inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens,
        cachedInputTokens: turn.usage.cachedInputTokens,
      } : undefined,
      diagnostics: [...new Set(diagnostics)],
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      launched, status: 'error', cli: release(ready?.installation.version ?? error.context?.cliVersion),
      elapsedMs: Math.round(performance.now() - started),
      code: typeof error.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(error.code) ? error.code : 'UNEXPECTED_FAILURE',
      rawCode: error.context?.rawCode?.match(/^(?:UNSUPPORTED_CLIENT|EXIT_\d+)$/)?.[0],
      authSource: ready?.auth.source, authStateAtPreflight: ready?.auth.state,
      diagnostics: [...new Set(diagnostics)],
    }));
  } finally {
    await session?.close();
    await agent.close();
  }
}

async function runLab() {
  assert.equal(process.env.HIVE_LIVE_TURNS, '1', 'Usá HIVE_LIVE_TURNS=1 para habilitar la prueba con turnos reales.');
  assert.match(model ?? '', /^gemini\/[A-Za-z0-9._-]+$/, 'Elegí un modelo explícito mediante HIVE_GEMINI_MODEL.');
  assert.ok(['vertex', 'api-key'].includes(mode), 'HIVE_GEMINI_AUTH admite vertex o api-key.');
  const required = mode === 'vertex' ? passthrough.slice(0, 2) : passthrough;
  for (const name of required) assert.ok(process.env[name], 'Falta configurar ' + name);

  const state = await realpath(await mkdtemp(join(tmpdir(), 'hive-gemini-live-')));
  const workspace = join(state, 'workspace');
  const cliHome = join(state, 'cli');
  const token = 'HIVE-' + randomBytes(5).toString('hex');
  const report = {
    at: new Date().toISOString(), sdk: installed.version, platform: process.platform, node: process.version,
    scriptSha256: createHash('sha256').update(await readFile(script)).digest('hex'), model, authMode: mode, stages: [],
  };
  function turn(name, prompt, ref) {
    const child = spawnSync(process.execPath, [script, '--child'], {
      cwd: workspace, input: JSON.stringify({ workspace, cliHome, prompt, ref }),
      timeout: timeoutMs + 25_000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error('Falló el proceso de validación de ' + name);
    const { text, ref: nextRef, ...evidence } = JSON.parse(child.stdout);
    report.stages.push({ name, ...evidence });
    return { text, ref: nextRef, evidence };
  }

  try {
    await mkdir(workspace);
    await mkdir(cliHome);
    const first = turn('first-turn', 'Remember this synthetic token for the next message. Return exactly: ' + token + '. Use no tools.');
    assert.equal(first.evidence.status, 'completed');
    assert.equal(first.text.trim(), token);
    const resumed = turn('cross-process-resume', 'Return the exact synthetic token from the previous message. Use no tools.', first.ref);
    assert.equal(resumed.evidence.status, 'completed');
    assert.equal(resumed.text.trim(), token);
    assert.equal(resumed.ref.id, first.ref.id);
    report.sessionIdentityMatched = true;
    const canary = 'write-canary.txt';
    const restricted = turn('write-canary', 'Use write_file to create ' + canary + ' in the current directory containing CANARY. If it is unavailable or denied, say DENIED.');
    assert.equal(restricted.evidence.status, 'completed');
    await assert.rejects(access(join(workspace, canary)), { code: 'ENOENT' });
    report.writeCanaryAbsent = true;
    report.passed = true;
  } catch {
    report.passed = false;
    report.failureStage = report.stages.at(-1)?.name ?? 'setup';
    process.exitCode = 1;
  } finally {
    await rm(state, { recursive: true, force: true });
    if (process.env.HIVE_GEMINI_REPORT) await writeFile(resolve(process.env.HIVE_GEMINI_REPORT), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  }
}

if (process.argv[2] === '--child') await runChild();
else await runLab();
