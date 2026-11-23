/**
 * Sessions: multi-turn context, export/resume across processes, and fork.
 *
 * The conversation lives in the provider's own session store, not in a list of
 * strings this SDK keeps. That is why a session survives the Node process and
 * why a fork is a real native fork rather than a fresh empty agent.
 *
 * Run: node --experimental-strip-types examples/02-sessions.ts
 * Cost: about four model turns.
 */
import { Agent } from 'hiveagents-runtime';

const agent = new Agent({ model: 'opus-5', permissions: { mode: 'analyze' } });

// A session has no id until the provider confirms one, so `ref` is undefined
// until the first turn lands. The SDK never invents an id it has not seen.
const session = await agent.openSession();
console.log('before first turn, ref:', session.ref);

await session.send('Remember this number: 42. Reply with just OK.');
await session.send('What number did I ask you to remember? Answer with the number only.');
console.log('native session id:', session.ref?.id);

// `export()` returns a validated reference, not a bare string: it carries the
// provider, the canonicalized cwd and the persistence mode, so a resume that
// would land in the wrong place fails before spawning anything.
const ref = session.export();
console.log('exported ref:', { provider: ref.provider, persistence: ref.persistence, cwd: ref.cwd });

// A different Agent instance — in a real app, a different process entirely —
// picks the conversation up with its full native context.
const elsewhere = await new Agent({ model: 'opus-5', permissions: { mode: 'analyze' } })
  .openSession({ resume: ref });
const resumed = await elsewhere.send('Still the same number? Answer with the number only.');
console.log('resumed answer:', resumed.text.trim());

// Fork copies the native history and confirms a NEW id. Both CLIs support
// forking with a prompt; neither supports a promptless fork on exec, which is
// why those are two separate capabilities rather than one fuzzy verdict.
const branch = await elsewhere.forkAndSend('Double that number and reply with the result only.');
console.log('parent id:', elsewhere.ref?.id);
console.log('child id: ', branch.session.ref?.id, '| child answer:', branch.turn.text.trim());

await Promise.all([session.close(), elsewhere.close(), branch.session.close()]);
