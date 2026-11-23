/**
 * Diagnostics: what is installed, what it can do, and what it will refuse.
 *
 * None of this spends a model turn. `doctor()` and `ready()` read local status
 * commands and CLI help output, so you can answer "will this work here?"
 * before paying for an answer.
 *
 * Run: node --experimental-strip-types examples/06-diagnostics.ts
 * Cost: none — no model turns.
 */
import {
  Agent,
  RequiredTransportUnavailableError,
  UnsupportedCapabilityError,
  doctor,
} from 'hiveagents-runtime';

const report = await doctor();

for (const provider of report.providers) {
  const { installation, auth } = provider;
  console.log(`\n${provider.provider}`);
  console.log(`  installed: ${installation.installed} ${installation.version ?? ''}`);
  // Auth is reported as a source, never as an identity: the SDK reads whether
  // you are logged in and how you are billed, and drops the account details
  // the CLI returns alongside them.
  console.log(`  auth: ${auth.authenticated} via ${auth.source}${auth.account?.plan ? ` (${auth.account.plan})` : ''}`);
  console.log(`  transports: ${provider.transports.map((t) => `${t.kind}=${t.available}`).join(' ')}`);
  console.log(`  memory: ${provider.memory}`);
  for (const warning of provider.warnings) console.log(`  warning: ${warning.code} ${warning.message}`);
}

// `ready()` negotiates a plan: which transport was chosen, which binary was
// pinned, and what evidence backs each capability. Discovery never starts a turn.
const readiness = await new Agent({ model: 'opus-5' }).ready();
console.log('\nnegotiated plan');
console.log('  transport:', readiness.plan.transport);
console.log('  cli:', readiness.plan.fingerprint.cliVersion, 'at', readiness.plan.fingerprint.executableRealpath);
for (const [name, status] of Object.entries(readiness.plan.capabilities)) {
  const sources = status.evidence.map((e) => e.source).join(',');
  console.log(`  ${name}: ${status.support}${sources ? ` (${sources})` : ''}`);
}

// Strict by default: asking for something the negotiated transport cannot do
// fails before any process is spawned, instead of degrading quietly. Steering
// needs a control transport, and the error distinguishes the two reasons it
// might be missing — no adapter registered at all (this case, since control
// adapters are registered explicitly in code), versus registered but not
// enabled through the experimentalControl gate.
try {
  await new Agent({ model: 'opus-5', capabilities: { steering: 'required' } }).ready();
  console.log('\nunexpected: steering was accepted on exec');
} catch (error) {
  if (error instanceof RequiredTransportUnavailableError || error instanceof UnsupportedCapabilityError) {
    console.log('\nfails closed as designed:', error.code);
    console.log(' ', error.message);
  } else {
    throw error;
  }
}
