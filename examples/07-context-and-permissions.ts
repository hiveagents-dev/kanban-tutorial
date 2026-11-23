/**
 * Context and permissions: what the agent inherits, and what it is allowed to do.
 *
 * Two decisions the SDK makes you take explicitly, because both have real
 * consequences and neither has a safe universal default:
 *
 *   - which of YOUR local configuration an agent inherits (CLAUDE.md, skills,
 *     hooks, MCP servers, durable memory);
 *   - what enforcement you are actually getting, which is not the same across
 *     providers and is never promised to be.
 *
 * Run: node --experimental-strip-types examples/07-context-and-permissions.ts
 * Cost: none — no model turns.
 */
import { Agent, UnsupportedCapabilityError } from 'hiveagents-runtime';

// `native` is the default: full fidelity with your local setup, exactly like
// running the CLI yourself. It is also the least reproducible and the most
// expensive — a heavily configured machine can add tens of thousands of cache
// tokens to every fresh session — and it loads plugins and hooks that have
// side effects.
const native = await new Agent({ model: 'opus-5', context: { profile: 'native' } }).capabilities();

// `clean` disables customizations, memory, hooks, plugins and discovered
// instructions. On Claude this uses --safe-mode, never --bare: --bare would
// also stop OAuth and keychain reads, breaking the subscription auth this
// whole SDK depends on.
const clean = await new Agent({
  model: 'opus-5',
  context: { profile: 'clean', memory: 'off' },
}).capabilities();

for (const [label, report] of [['native', native], ['clean', clean]] as const) {
  console.log(`\ncontext profile: ${label}`);
  console.log('  active:', report.contextSources.active.join(', ') || '(none)');
  console.log('  inactive:', report.contextSources.inactive.join(', ') || '(none)');
  // Some sources cannot be removed at all: an admin-managed policy still
  // applies under --safe-mode, and the report says so rather than implying a
  // clean profile is a sandbox.
  console.log('  unavoidable:', report.contextSources.unavoidable.join(', ') || '(none)');
}

// Permissions describe intent, not flags. Strict mode is the default, and it
// means what it says: asking for something this provider cannot enforce fails
// before anything is spawned. Claude exec has no network isolation, so a
// network deny is refused rather than quietly ignored.
try {
  await new Agent({
    model: 'opus-5',
    permissions: { mode: 'analyze', network: 'deny' },
  }).capabilities();
  console.log('\nunexpected: network deny was accepted on claude exec');
} catch (error) {
  if (error instanceof UnsupportedCapabilityError) {
    console.log('\nstrict mode refused an unenforceable policy:', error.message);
  } else {
    throw error;
  }
}

// Opting out of strict is allowed, but it is an explicit decision and the cost
// is visible: the request still appears under `unsupported`, so the gap is
// reported rather than hidden.
const relaxed = await new Agent({
  model: 'opus-5',
  permissions: { mode: 'analyze', network: 'deny', strict: false },
}).capabilities();

const enforcement = relaxed.enforcement;
if (!enforcement) throw new Error('this provider reported no enforcement detail');

console.log('\npermissions: analyze + network deny, strict disabled');
console.log('  filesystem:', enforcement.effective.filesystem);
console.log('  network:', enforcement.effective.network);
console.log('  approvals:', enforcement.effective.approvals);
console.log('  enforced by:', enforcement.effective.enforcedBy.join(', '));
console.log('  unsupported:', enforcement.unsupported.join(', ') || '(none)');
for (const warning of enforcement.warnings) console.log('  warning:', warning);

// The honest bit: a permission mode is a harness-level decision, not an OS
// sandbox. If you need containment for untrusted code, run the whole thing
// inside a container or VM. The SDK reports what it enforces and refuses to
// call that the same guarantee.
