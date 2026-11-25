import { createHash } from 'node:crypto';
import { inputDigest, learningDigest } from 'hiveagents-runtime/routing/learning';

const VERSION = 2;

function caseFor(id, family, title, table, brief, expectedLines) {
  const card = {
    id, title,
    brief: table + '\n' + brief + ' Entregá un Markdown operativo corto. Usá las etiquetas exactas. Escribí primero Resultado y después Control, cada uno en su propia línea y sin viñetas. Limitá el documento a esas dos líneas.',
    requiredTerms: ['Resultado', 'Control'],
  };
  return { family, data: { card, feedback: '' }, expectedLines };
}

export const train = [
  caseFor('train-cuotas', 'cupos-activos', 'Conciliar cupos de revisión',
    'Cada turno activo ocupa un cupo. Tabla: A1 en revisión (2 cupos); A2 terminada (4 cupos); A3 en revisión (3 cupos); A4 pendiente (8 cupos).',
    'Escribí Resultado: <número> con el total activo de revisión y Control: <número> con cuántas filas participan.',
    ['Resultado: 5', 'Control: 2']),
  caseFor('train-reintentos', 'umbral-reintentos', 'Preparar el parte de reintentos',
    'Sólo se recuperan bloqueadas con menos de tres intentos. A5 bloqueada (2); A6 bloqueada (3); A7 en curso (1); A8 bloqueada (1).',
    'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad> de tarjetas recuperables.',
    ['Resultado: A5, A8', 'Control: 2']),
  caseFor('train-criterios', 'controles-pendientes', 'Revisar comprobaciones pendientes',
    'Guía Norte tiene 2 comprobaciones de 4 aprobadas, Guía Sur 3 de 3 y Guía Este 1 de 4.',
    'Escribí Resultado: <cantidad de controles sin aprobación> y Control: <cantidad de guías que los tienen>.',
    ['Resultado: 5', 'Control: 2']),
  caseFor('train-lotes', 'filtro-lotes', 'Preparar la lista de lotes elegibles',
    'Se permite si hay entre 2 y 4 tarjetas y ninguna alerta. L1: 2 sin alerta; L2: 5 sin alerta; L3: 3 con alerta; L4: 4 sin alerta.',
    'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad> de lotes elegibles.',
    ['Resultado: L1, L4', 'Control: 2']),
];

// Additional tables vary inputs and decisions independently of the held-out episodes.
for (let fixture = 1; fixture <= 8; fixture++) {
  const first = fixture * 5 + 7;
  const last = fixture * 3 + 4;
  const prefix = 'R' + fixture;
  const left = fixture % 2 === 0 ? 1 : 2;
  const right = 5 - left;
  train.push(
    caseFor('train-cupos-' + fixture, 'cupos-activos', 'Conciliar cupos activos de revisión',
      'Activas: ' + prefix + '1 con ' + first + ' cupos y ' + prefix + '3 con ' + last +
        ' cupos. Terminada: ' + prefix + '2 con 200 cupos. Pendiente: ' + prefix + '4 con 100 cupos.',
      'Escribí Resultado: <cupos activos> y Control: <cantidad de filas activas>.',
      ['Resultado: ' + (first + last), 'Control: 2']),
    caseFor('train-recuperar-' + fixture, 'umbral-reintentos', 'Preparar el parte de tarjetas para reintentar',
      'Sólo retomá bloqueadas con menos de ' + left + ' intentos. ' + prefix + '1 bloqueada (' + (left - 1) +
        '); ' + prefix + '2 bloqueada (' + right + '); ' + prefix + '3 en revisión (0); ' + prefix + '4 bloqueada (0).',
      'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad de tarjetas recuperables>.',
      ['Resultado: ' + prefix + '1, ' + prefix + '4', 'Control: 2']),
    caseFor('train-pendientes-' + fixture, 'controles-pendientes', 'Revisar controles pendientes por guía',
      'Guía ' + prefix + '1 aprobó ' + first + ' de ' + (first + left) +
        '; Guía ' + prefix + '2 aprobó todos los ' + last + '; Guía ' + prefix + '3 aprobó ' + last + ' de ' + (last + right) + '.',
      'Escribí Resultado: <cantidad de controles sin aprobación> y Control: <cantidad de guías con pendientes>.',
      ['Resultado: ' + (left + right), 'Control: 2']),
    caseFor('train-filtro-' + fixture, 'filtro-lotes', 'Preparar la lista de lotes elegibles de revisión',
      'Se admite un lote de ' + left + ' a ' + right + ' tarjetas y sin alerta. ' + prefix + '1: ' + left +
        ' y sin alerta; ' + prefix + '2: ' + (right + 1) + ' y sin alerta; ' + prefix + '3: ' + right +
        ' y con alerta; ' + prefix + '4: ' + right + ' y sin alerta.',
      'Escribí Resultado: <IDs separados por coma y espacio> ordenados y Control: <cantidad de lotes elegibles>.',
      ['Resultado: ' + prefix + '1, ' + prefix + '4', 'Control: 2']),
  );
}

export const fixed = [
  caseFor('fixed-identificadores', 'deduplicacion-normalizada', 'Depurar los identificadores del registro',
    'El registro contiene A-01, B-02, a-01, C-03 y b-02. Normalizá cada identificador a mayúsculas, conservá la primera ocurrencia y descartá el resto.',
    'Escribí Resultado: <IDs que quedan en su orden de aparición separados por coma y espacio> y Control: <cantidad descartada>.',
    ['Resultado: A-01, B-02, C-03', 'Control: 2']),
  caseFor('fixed-cuorum', 'cuorum-ponderado', 'Comprobar el quórum del comité',
    'Se aprueba con al menos seis puntos a favor. Coordinación (4 puntos) se abstuvo, Validación (2) votó a favor, Documentación (1) votó a favor y Revisión (2) votó a favor.',
    'Escribí Resultado: aprobado o Resultado: rechazado y Control: <puntaje a favor>.',
    ['Resultado: rechazado', 'Control: 5']),
];

function seedValue(seed, family, range) {
  return createHash('sha256').update(seed).update('|').update(family).digest().readUInt32BE() % range;
}

export function freshCases(seed) {
  if (typeof seed !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(seed)) {
    throw new TypeError('La semilla admite de 1 a 64 letras, números, guiones o guiones bajos.');
  }
  const pathShift = seedValue(seed, 'dependency-path', 11);
  const medianShift = seedValue(seed, 'median-latency', 19);
  const version = 4 + seedValue(seed, 'version-replay', 12);
  const firstMinute = 1 + seedValue(seed, 'deadline-sort', 4);
  const alias = idx => 'R' + (10 + seedValue(seed, 'cycle-replay', 61) + idx);
  const tag = idx => 'C' + (10 + seedValue(seed, 'review-intersection', 53) + idx);
  return [
    caseFor('fresh-ruta-' + seed, 'ruta-critica', 'Calcular una ruta de dependencias',
      `A tarda 2 minutos. Tras A pueden empezar B (${6 + pathShift} minutos) y C (${4 + pathShift} minutos). D tarda 3 minutos y espera a B y C. Las tareas sin dependencias entre sí pueden superponerse.`,
      'Escribí Resultado: <IDs de la ruta más larga, separados por coma y espacio> y Control: <duración total en formato n minutos>.',
      ['Resultado: A, B, D', `Control: ${11 + pathShift} minutos`]),
    caseFor('fresh-orden-' + seed, 'orden-estable-horarios', 'Ordenar vencimientos con un criterio de desempate',
      `A vence 09:05 y es ordinaria. B vence 09:0${firstMinute} y es ordinaria. C vence 09:05 y es urgente. D vence 09:07 y es urgente. Incluí sólo los vencimientos hasta las 09:06. Ordená por hora y, a igual hora, urgente primero.`,
      'Escribí Resultado: <IDs en el orden indicado, separados por coma y espacio> y Control: <cantidad incluida>.',
      ['Resultado: B, C, A', 'Control: 3']),
    caseFor('fresh-reproduccion-' + seed, 'reproduccion-de-transiciones', 'Reconstruir el tablero a partir de sus eventos',
      `${alias(1)} y ${alias(2)} empiezan pendientes y ${alias(3)} bloqueada. Asignar lleva de pendiente a en curso. Aprobar lleva de en curso a terminada. Fallar o cancelar lleva de en curso a bloqueada. Reintentar lleva de bloqueada a pendiente. Eventos en orden: asignar ${alias(1)}, aprobar ${alias(1)}, asignar ${alias(2)}, fallar ${alias(2)}, reintentar ${alias(3)}, asignar ${alias(3)}, cancelar ${alias(3)}.`,
      'Escribí Resultado: <ID=estado de cada tarjeta en el orden original, separado por punto y coma y espacio> y Control: <cantidad bloqueada al final>.',
      [`Resultado: ${alias(1)}=terminada; ${alias(2)}=bloqueada; ${alias(3)}=bloqueada`, 'Control: 2']),
    caseFor('fresh-latencia-' + seed, 'mediana-y-dispersion', 'Resumir la distribución de latencias',
      `Las latencias medidas fueron ${[2, 17, 11, 8, 50].map(value => value + medianShift).join(', ')} milisegundos. Ordená las cinco mediciones para hallar la mediana. Para la dispersión, restá la mínima a la máxima.`,
      'Escribí Resultado: <mediana en milisegundos como número sin unidad> y Control: <dispersión como número sin unidad>.',
      [`Resultado: ${11 + medianShift}`, 'Control: 48']),
    caseFor('fresh-acuerdo-' + seed, 'interseccion-de-revisores', 'Reconstruir el acuerdo entre tres revisores',
      `Ana observó ${tag(1)}, ${tag(3)} y ${tag(4)}. Teo observó ${tag(2)}, ${tag(3)} y ${tag(4)}. Mila observó ${tag(3)} y ${tag(5)}.`,
      'Escribí Resultado: <código observado por los tres> y Control: <código observado por exactamente dos>.',
      [`Resultado: ${tag(3)}`, `Control: ${tag(4)}`]),
    caseFor('fresh-version-' + seed, 'reconciliacion-por-version', 'Determinar la última versión aprobada',
      `El orden de llegada es arbitrario y manda la versión numérica más alta de cada documento. A versión 1 aprobada, B versión ${version} aprobada, A versión 3 en revisión, C versión 7 bloqueada, B versión 2 bloqueada y C versión 6 aprobada.`,
      'Escribí Resultado: <ID cuyo último estado es aprobado> y Control: <número de la versión vigente de ese ID>.',
      ['Resultado: B', `Control: ${version}`]),
  ];
}

export function corpusManifest(seed) {
  const summarize = cases => cases.map(({ family, data, expectedLines }) => ({
    id: data.card.id,
    family,
    inputDigest: inputDigest(JSON.stringify(data)),
    oracleDigest: learningDigest(expectedLines),
  }));
  const manifest = {
    format: VERSION,
    seed,
    scorer: 'json-markdown-exact-lines-v2',
    splits: { train: summarize(train), fixed: summarize(fixed), fresh: summarize(freshCases(seed)) },
  };
  return { ...manifest, digest: learningDigest(manifest) };
}
