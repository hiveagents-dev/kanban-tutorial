// CLI local determinista. Lee texto de stdin y devuelve la cantidad de palabras en JSON.
import { randomUUID } from 'node:crypto';

if (process.argv[2] === '--version') {
  console.log('1.0.0');
} else {
  process.stdin.setEncoding('utf8');
  let content = '';
  for await (const chunk of process.stdin) content += chunk;
  console.log(JSON.stringify({ sessionId: randomUUID(), words: content.trim() ? content.trim().split(/\s+/u).length : 0 }));
}
