/** Offline by default. See examples/README.md for restart and explicit model mode. */
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDocumentTriage, type TriageOptions } from './document-triage/triage.ts';

const options: TriageOptions = { stateDirectory: join(tmpdir(), 'oar-document-triage') };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--stop-after-intake') options.stopAfterIntake = true;
  else if (argument === '--allow-provider-turns') options.allowProviderTurns = true;
  else if (['--state-dir', '--budget-db', '--input', '--model'].includes(argument ?? '')) {
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    if (argument === '--state-dir') options.stateDirectory = resolve(value);
    else if (argument === '--budget-db') options.budgetDatabasePath = resolve(value);
    else if (argument === '--input') options.documents = JSON.parse(await readFile(resolve(value), 'utf8')) as NonNullable<TriageOptions['documents']>;
    else options.model = value;
  } else throw new Error(`Unknown argument: ${argument}`);
}
const result = await runDocumentTriage(options);
console.log(JSON.stringify(result, null, 2));
if (!['completed', 'cancelled'].includes(result.status)) process.exitCode = 1;
