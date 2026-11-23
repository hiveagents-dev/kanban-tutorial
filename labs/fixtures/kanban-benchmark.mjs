const object = properties => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const policies = [
  'Detener bloquea únicamente la tarjeta asignada.',
  'Las tarjetas pendientes conservan su estado.',
  'Reintentar devuelve una tarjeta bloqueada a pendientes.',
  'Iniciar ciclo procesa pendientes. Abrir la app no inicia trabajo.',
].join(' ');
const review = object({ approved: { type: 'boolean' }, issue: { enum: ['reintento', 'ninguno'] } });
const draft = object({ markdown: { type: 'string' } });

function rows(markdown) {
  if (typeof markdown !== 'string') return [];
  return markdown.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('|') && line.endsWith('|'))
    .map(line => line.slice(1, -1).split('|').map(cell => cell.trim().replace(/^[*\x60]+|[*\x60]+$/g, '').toLowerCase()));
}
const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
function verifyTable(columns, records) {
  return output => {
    const [header = [], separator = [], ...items] = rows(output?.markdown);
    return {
      'columnas en orden': equal(header, columns),
      'separador Markdown válido': separator.length === columns.length && separator.every(cell => /^:?-{3,}:?$/.test(cell)),
      'registros exactos sin filas extra': items.length === records.length && items.every((record, index) => equal(record, records[index])),
    };
  };
}

export default [
  {
    id: 'prioridad-incidente', role: 'planificar', schema: object({ cardId: { enum: ['arte', 'guia', 'incidente'] } }),
    task: 'Elegí la primera tarjeta. Aplicá en orden: (1) una tarjeta bloqueada no es elegible; (2) un incidente activo que impide operar a clientes precede a una tarea editorial; (3) ante igualdad, gana el vencimiento más próximo. Tarjetas: arte (pendiente, editorial, vence en un minuto); guia (bloqueada, corrige una caída activa, vence ahora); incidente (pendiente, restaura las compras de clientes, vence en una hora). Devolvé su id.',
    verify: output => ({ 'respeta elegibilidad e impacto de operación': output?.cardId === 'incidente' }),
  },
  {
    id: 'redaccion-turnos', role: 'redactar', schema: draft,
    task: 'Escribí una nota operativa Markdown en español con una tabla de columnas ID, Estado, Próximo paso. Usá una fila por tarjeta ordenada por ID y el estado posterior a la última acción. A-17 estaba en curso al pulsar Detener, por lo que queda Bloqueada y debe pulsarse Reintentar. A-18 pasó las comprobaciones y la revisión, por lo que queda Terminada y debe pulsarse Archivar. A-19 estaba pendiente al pulsar Detener, por lo que queda Pendiente y debe pulsarse Iniciar ciclo. Sin filas adicionales ni otros pasos en las celdas.',
    verify: verifyTable(['id', 'estado', 'próximo paso'], [
      ['a-17', 'bloqueada', 'reintentar'], ['a-18', 'terminada', 'archivar'], ['a-19', 'pendiente', 'iniciar ciclo'],
    ]),
  },
  {
    id: 'redaccion-resumen', role: 'redactar', schema: draft,
    task: 'Escribí un resumen operativo Markdown con una tabla de dos columnas, Estado y Cantidad. Cada tarjeta cuenta una vez según su último estado. E-5: Pendiente → En curso → Terminada. E-6: Pendiente → En curso → Bloqueada → Pendiente. E-7: Pendiente → En curso → Bloqueada. E-8: Pendiente → En curso → Terminada. E-9: Pendiente. Orden de filas: Bloqueada, Pendiente, Terminada. Usá dígitos y no agregues totales ni otras filas.',
    verify: verifyTable(['estado', 'cantidad'], [['bloqueada', '1'], ['pendiente', '2'], ['terminada', '2']]),
  },
  {
    id: 'revision-rechazo', role: 'revisar', schema: review,
    task: 'Revisá la exactitud del borrador frente a la política de la aplicación. ' + policies +
      ' Borrador: «Al pulsar Detener, la tarjeta asignada pasa a Bloqueadas. Las pendientes conservan su estado. Si cerrás y volvés a abrir, la tarjeta bloqueada se reanuda sola. Reintentar e Iniciar ciclo están disponibles en el tablero.» Devolvé approved e issue. Usá issue=reintento cuando el procedimiento de reintento sea incorrecto y issue=ninguno si es correcto.',
    verify: output => ({ 'detecta la falsa reanudación': output?.approved === false && output.issue === 'reintento' }),
  },
  {
    id: 'revision-aprobacion', role: 'revisar', schema: review,
    task: 'Revisá la exactitud del borrador frente a la política de la aplicación. ' + policies +
      ' Borrador: «Detener bloquea la tarjeta asignada y conserva las pendientes. Para volver a procesar la bloqueada, pulsá Reintentar y después Iniciar ciclo. Abrir el tablero conserva el estado.» Devolvé approved e issue. Usá issue=reintento cuando el procedimiento de reintento sea incorrecto y issue=ninguno si es correcto.',
    verify: output => ({ 'aprueba el procedimiento correcto': output?.approved === true && output.issue === 'ninguno' }),
  },
];
