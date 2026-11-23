/**
 * Structured output: a JSON Schema in, a validated object out.
 *
 * The schema goes to the provider's native mechanism (`--json-schema` on
 * Claude, `--output-schema` on Codex) and the runtime re-validates the answer
 * against the same schema. A response that does not match raises
 * StructuredOutputError with the original text attached — it never turns into
 * a silent `undefined`.
 *
 * Run: node --experimental-strip-types examples/03-structured-output.ts
 * Cost: one model turn.
 */
import { Agent, StructuredOutputError } from 'hiveagents-runtime';

const classifier = new Agent({ model: 'opus-5', permissions: { mode: 'analyze' } });

const riskSchema = {
  type: 'object',
  properties: {
    risk: { enum: ['low', 'medium', 'high'] },
    rationale: { type: 'string' },
  },
  required: ['risk', 'rationale'],
  additionalProperties: false,
} as const;

try {
  const turn = await classifier.run(
    'Classify the risk of running an autonomous agent with write access on an untrusted repository.',
    { outputSchema: riskSchema },
  );
  const assessment = turn.output as { risk: string; rationale: string };
  console.log('risk:', assessment.risk);
  console.log('rationale:', assessment.rationale);
} catch (error) {
  if (!(error instanceof StructuredOutputError)) throw error;
  console.error('The response failed schema validation:', error.code);
  process.exitCode = 1;
} finally {
  await classifier.close();
}
