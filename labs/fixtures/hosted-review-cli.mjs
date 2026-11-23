// CLI local de prueba. El documento entra por stdin y la respuesta sale por stdout.
let markdown = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) markdown += chunk;
const hasEvidence = /^## Evidencia\s*$/m.test(markdown);
process.stdout.write(hasEvidence ? 'Contiene la sección de evidencia.' : 'Falta la sección de evidencia.');
