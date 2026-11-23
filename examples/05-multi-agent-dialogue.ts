/**
 * Two agents, two providers, one moderated conversation.
 *
 * A Codex orchestrator (gpt-5.6-sol) sets the topic, puts it to a Claude
 * participant (opus-5), reads the reply, challenges it, and closes with a
 * verdict. Each side keeps its own native session on its own provider.
 *
 * The moderation loop lives here, in application code. The SDK deliberately
 * has no planner, no queue and no agent-to-agent bus: it gives you agents and
 * sessions, and you decide how they talk. The two sessions share nothing but
 * the text this file passes between them.
 *
 * The same flow is asserted end-to-end in
 * tests/live/cross-provider-dialogue.test.ts.
 *
 * Run: node --experimental-strip-types examples/05-multi-agent-dialogue.ts
 * Cost: about five model turns across two subscriptions.
 */
import { Agent } from 'hiveagents-runtime';

const MODERATOR = 'You are moderating a short technical debate. Reply with JSON only.';

// Codex exec has no developer-instruction channel — it refuses `instructions`
// instead of pretending a prefixed user prompt is the same thing — so the
// orchestrator carries its role in the prompt. Claude takes a real system
// prompt. The SDK preserves that asymmetry rather than papering over it.
const orchestrator = new Agent({
  model: 'gpt-5.6-sol',
  permissions: { mode: 'analyze', strict: false },
});

const participant = new Agent({
  model: 'opus-5',
  permissions: { mode: 'analyze' },
  instructions: 'You are a debate participant. Answer in at most three sentences.',
});

const moderator = await orchestrator.openSession();
const debater = await participant.openSession();

const opening = await moderator.send(
  `${MODERATOR} Choose one narrow debate topic about software engineering and write the opening `
  + 'question. Return {"topic": string, "question": string}.',
  {
    outputSchema: {
      type: 'object',
      properties: { topic: { type: 'string' }, question: { type: 'string' } },
      required: ['topic', 'question'],
      additionalProperties: false,
    },
  },
);
const round = opening.output as { topic: string; question: string };
console.log(`\n[codex] topic: ${round.topic}\n[codex] asks: ${round.question}\n`);

const answer = await debater.send(`Topic: ${round.topic}\nQuestion: ${round.question}`);
console.log(`[claude] ${answer.text.trim()}\n`);

// The orchestrator only knows what this file told it. Its follow-up is
// evidence that the participant's words crossed from one provider to the other.
const moderation = await moderator.send(
  `${MODERATOR} The participant replied:\n"""\n${answer.text}\n"""\n`
  + 'Write one challenging follow-up. Return {"followUp": string}.',
  {
    outputSchema: {
      type: 'object',
      properties: { followUp: { type: 'string' } },
      required: ['followUp'],
      additionalProperties: false,
    },
  },
);
const { followUp } = moderation.output as { followUp: string };
console.log(`[codex] follows up: ${followUp}\n`);

// The participant answers on its own session, so it still has the first
// exchange in context without anyone replaying the transcript.
const rebuttal = await debater.send(followUp);
console.log(`[claude] ${rebuttal.text.trim()}\n`);

const closing = await moderator.send(
  `${MODERATOR} The participant answered:\n"""\n${rebuttal.text}\n"""\n`
  + 'Return {"verdict": string}.',
  {
    outputSchema: {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: false,
    },
  },
);
console.log(`[codex] verdict: ${(closing.output as { verdict: string }).verdict}\n`);
console.log(`sessions stayed native and separate: codex=${moderator.ref?.id} claude=${debater.ref?.id}`);

await Promise.all([moderator.close(), debater.close()]);
