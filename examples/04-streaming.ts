/**
 * Streaming and cancellation: events as they arrive, and how a turn ends.
 *
 * Session.stream() yields exec adapter events as output arrives.
 *
 * Run: node --experimental-strip-types examples/04-streaming.ts
 * Cost: up to three model turns, including the cancellation attempt.
 */
import { AbortError, Agent } from 'hiveagents-runtime';

const agent = new Agent({ model: 'opus-5', permissions: { mode: 'analyze' } });
const session = await agent.openSession();
try {
  let deltas = 0;
  for await (const event of session.stream('List three tradeoffs of local-first agents, one line each.')) {
    if (event.type === 'message.delta') {
      deltas++;
      process.stdout.write(event.text);
    }
    if (event.type === 'turn.completed') {
      console.log('\nstatus:', event.turn.status, '| message deltas:', deltas);
      if (deltas === 0) console.log(event.turn.text);
    }
  }

  const originalId = session.ref?.id;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await session.send('Summarize the history of distributed consensus.', {
      signal: controller.signal, awaitSettlement: true,
    });
    console.log('The second turn finished before the cancellation.');
  } catch (error) {
    if (!(error instanceof AbortError)) throw error;
    console.log('State after cancellation:', session.state);
  } finally {
    clearTimeout(timeout);
  }

  const state = await session.reconcile();
  if (state === 'idle') {
    const next = await session.send('Reply with the word recovered.');
    console.log('Continuation:', next.text.trim(), '| same native session:', next.session.id === originalId);
  } else {
    console.log('Session state:', state, '| no further turn was sent.');
  }
} finally {
  await session.close();
  await agent.close();
}
