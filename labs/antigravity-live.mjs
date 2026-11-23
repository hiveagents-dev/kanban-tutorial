import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Agent, Runtime, createAntigravityCliProvider, resolveBinary } from 'hiveagents-runtime';

const model = 'antigravity/gemini-3.8-flash-low';
const cliVersion = '1.5.15';
const script = fileURLToPath(import.meta.url);
const timeoutMs = 60_000;
const hash = text => createHash('sha256').update(text).digest('hex');

async function fileHash(file, algorithm = 'sha256', encoding = 'hex') {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest(encoding);
}

async function turn([phase, command, workspace, refPath, nonce]) {
  const runtime = new Runtime({ providers: [createAntigravityCliProvider({
    executable: { command, argsPrefix: [] },
  })] });
  const agent = new Agent({
    model, cwd: workspace, transport: 'exec', permissions: { mode: 'edit' },
    environment: { mode: 'minimal' }, requireAuth: 'any',
  }, runtime);
  let session;
  try {
    const started = performance.now();
    const { installation, auth, capabilities } = await agent.ready({
      timeoutMs: 15_000, awaitSettlement: true,
    });
    assert.equal(installation.version, cliVersion);
    const resume = phase === 'resume' ? JSON.parse(await readFile(refPath, 'utf8')) : undefined;
    session = await agent.openSession(resume ? { resume } : undefined);
    const prompt = resume
      ? 'Reply with exactly the synthetic token from my preceding message. Do not use tools or files.'
      : 'Remember the synthetic token ' + nonce + '. Reply with exactly the token. Do not use tools or files.';
    let deltas = 0;
    let toolEvents = 0;
    let result;
    for await (const event of session.stream(prompt, { timeoutMs, awaitSettlement: true })) {
      if (event.type === 'message.delta') deltas++;
      if (event.type.startsWith('tool.')) toolEvents++;
      if (event.type === 'turn.completed') result = event.turn;
    }
    assert.equal(result?.status, 'completed');
    assert.ok(deltas > 0, 'Se esperaba por lo menos un delta');
    assert.equal(toolEvents, 0);
    if (!resume) await writeFile(refPath, JSON.stringify(session.export()), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({
      phase, status: result.status, resultDigest: hash(result.text.trim()), sessionDigest: hash(result.session.id),
      elapsedMs: Math.round(performance.now() - started), usage: result.usage, deltas, toolEvents,
      preflightAuthentication: auth.state ?? 'unknown', permissionEnforcement: capabilities.enforcement.effective.enforcedBy,
    }));
  } finally {
    await session?.close();
    await agent.close();
  }
}

async function verify([tarball]) {
  if (tarball && !isAbsolute(tarball)) throw new Error('Usá una ruta absoluta al tarball con --allow-live.');
  const command = process.env.HIVE_ANTIGRAVITY_BIN ?? resolveBinary('agy')?.command;
  assert.ok(command && isAbsolute(command), 'No se encontró un ejecutable agy con ruta absoluta');
  const executable = await realpath(command);
  const nativeExecutableSha256 = await fileHash(executable);
  const nativeVersion = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim();
  assert.equal(nativeVersion, cliVersion);
  const entry = new URL(import.meta.resolve('hiveagents-runtime'));
  const { name, version } = JSON.parse(await readFile(new URL('../package.json', entry), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const installed = lock.packages['node_modules/hiveagents-runtime'];
  assert.equal(installed?.version, version);
  assert.ok(installed?.integrity, 'Instalá el SDK desde npm o un tarball con npm install.');
  if (tarball) {
    const integrity = 'sha512-' + await fileHash(tarball, 'sha512', 'base64');
    assert.equal(integrity, installed.integrity, 'El tarball difiere del SDK instalado');
  }

  const state = await mkdtemp(join(tmpdir(), 'hive-antigravity-live-'));
  try {
    const workspace = await realpath(await mkdtemp(join(state, 'workspace-')));
    const refPath = join(state, 'session.json');
    const canaryPath = join(workspace, 'canary.txt');
    const canary = 'Synthetic fixture for workspace integrity.';
    await writeFile(canaryPath, canary, { mode: 0o600 });
    const nonce = 'hive-' + randomUUID();
    const turns = [];
    for (const phase of ['initial', 'resume']) {
      assert.equal(await fileHash(executable), nativeExecutableSha256, 'agy cambió durante la prueba');
      const args = [script, '--phase', phase, executable, workspace, refPath];
      if (phase === 'initial') args.push(nonce);
      const stdout = execFileSync(process.execPath, args, {
        encoding: 'utf8', timeout: 85_000, stdio: ['ignore', 'pipe', 'inherit'],
      });
      const turn = JSON.parse(stdout);
      assert.equal(turn.resultDigest, hash(nonce), 'La respuesta no coincide con el token');
      turns.push(turn);
    }
    assert.equal(await fileHash(executable), nativeExecutableSha256, 'agy cambió durante la prueba');
    assert.equal(turns[0].sessionDigest, turns[1].sessionDigest, 'Cambió la conversación nativa');
    assert.equal(await readFile(canaryPath, 'utf8'), canary);
    assert.deepEqual(await readdir(workspace), ['canary.txt']);
    console.log(JSON.stringify({
      verifiedAt: new Date().toISOString(), sdk: name + '@' + version,
      sdkIntegrity: installed.integrity, ...(tarball ? { sdkTarballSha256: await fileHash(tarball) } : {}),
      nativeVersion, nativeExecutableSha256, model, os: process.platform, arch: process.arch, node: process.version,
      nativeDispatches: 2, independentNodeProcesses: true, fileCanaryUnchanged: true, unexpectedWorkspaceEntries: 0,
      permissionMode: 'edit/request-review', turns,
    }, null, 2));
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

const [mode, ...args] = process.argv.slice(2);
if (mode === '--allow-live' && args.length <= 1) await verify(args);
else if (mode === '--phase' && ['initial', 'resume'].includes(args[0])) await turn(args);
else {
  console.error('Uso: node labs/antigravity-live.mjs --allow-live [/ruta/absoluta/al/sdk.tgz]');
  process.exitCode = 2;
}
