# Qué podés aprender con cada ejemplo

Para aprender a construir una app de agentes, empezá por el [tablero Kanban](../README.md). Para elegir qué parte del SDK usar en tu próxima integración, buscá el problema en las tablas siguientes. Todos los imports pertenecen al mismo paquete npm, `hiveagents-runtime@0.1.0-beta.3`.

## Hasta dónde llega el tablero

La ventana permite crear tarjetas, detener un ciclo, reintentar, leer el documento corregido y recuperar el estado al reabrir. El planificador elige entre tarjetas pendientes, el redactor produce Markdown y otro agente lo revisa. El SDK ejecuta los turnos, aplica los perfiles del proveedor, valida las respuestas estructuradas y conserva los recibos de selección. La cola, los estados de las tarjetas, las pruebas de términos y el presupuesto de dos borradores son decisiones de esta app.

El recorrido principal importa tres entradas públicas del SDK. Usa el core, `/routing` y el almacén de archivos de `/orchestration`. Cada rol abre un agente independiente. El tablero intenta Claude primero y consulta Codex si el preflight se abstiene. El historial se reconstruye desde `board.json`. La reproducción abre una copia de datos ya guardados. [Agentes y selección](../src/agents.mjs) · [Cola y detenciones](../src/board.mjs) · [Persistencia](../src/store.mjs)

Las corridas registradas usaron Claude Code y Codex por separado. Demuestran redacción, veto, corrección y reintento para dos tarjetas. El fallback entre proveedores y las cancelaciones tardías se pueden reproducir con respuestas controladas. Una prueba adicional pulsa Iniciar, Detener y Reintentar desde Electron y comprueba que se descarta la respuesta tardía del redactor. [Prueba de la ventana](../tests/cancel.e2e.mjs) La presencia de los cuatro CLIs en el catálogo y la cantidad de pruebas del tablero miden cosas distintas de la compatibilidad en vivo de cada integración. [Corrida de Claude](../evidence/verified-run.json) · [Corrida de Codex](../evidence/codex-run.json) · [Pruebas del adaptador de la app](../tests/agents.test.mjs)

## Probá una capacidad en forma aislada

Desde la carpeta del tutorial, instalá las dependencias de la app y ejecutá los laboratorios locales. Requieren Node.js 22.16 o posterior. Consumen cero turnos comerciales. Los ejercicios con persistencia crean su propio estado temporal.

```sh
npm ci
npm run labs
```

Podés repetir sólo un ejercicio con `node labs/nombre.mjs`. Para recorrerlos como desarrollador, empezá por el CLI propio y el selector, seguí por el plan que se interrumpe y se reanuda, y terminá con memoria por tarjeta.

| Pregunta al integrar el SDK | Ejercicio | Resultado que podés comprobar |
| --- | --- | --- |
| ¿Puedo conservar los proveedores incluidos y sumar mi propio CLI? ¿Cómo elijo según la tarea? | [custom-cli.mjs](custom-cli.mjs) | Conserva los cuatro proveedores. Una regla por etiquetas selecciona un quinto CLI, que cuenta tres palabras en un proceso Node real. Antes del turno se comprueban la regla, el fallback y la ausencia de coincidencias. El permiso para autenticación desconocida se limita al contador local, que sólo consume stdin. |
| ¿Cómo ordeno tarjetas dependientes y retomo un plan después de detenerlo? | [plan.mjs](plan.mjs) | Rechaza un ciclo, estima dos llamadas y reutiliza el paso completado al reabrir el journal. Los pasos usan un ejecutor local determinista. |
| ¿Cómo evito que redactor y revisor ocupen el mismo cupo? | [capacity.mjs](capacity.mjs) | Dos clientes comparten una base SQLite. El segundo obtiene `concurrency-limit` y puede reservar después de la liberación del primero. |
| ¿Cómo conservo una regla de edición cuando falta espacio para el historial? | [context.mjs](context.mjs) | Conserva la versión exigida de una regla, recorta el historial y detecta cuando el presupuesto ni siquiera alcanza para el contexto obligatorio. Prepara el canal de instrucciones de Claude sin enviar un turno. |
| ¿Cómo hago que una persona autorice una revisión exacta? | [approval.mjs](approval.mjs) | Simula la decisión del operador en una bandeja real. Cambiar la revisión invalida la autorización y ésta sólo se puede consumir una vez. |
| ¿Cómo aprende una tarjeta sin contaminar a otra? | [memory.mjs](memory.mjs) | Propone una lección, mide su utilidad con un control léxico, la promueve en SQLite y comprueba aislamiento y reversión. |
| ¿Cómo sé si una entrega terminó después de cerrar un proceso? | [history.mjs](history.mjs) | Reabre el historial en SQLite, comprueba la huella de la entrega y distingue un resultado completado de otro desconocido. |
| ¿Cómo usa evidencia previa el selector de modelos? | [learning.mjs](learning.mjs) | Compara dos redactores sintéticos sobre diez encargos distintos. El estimador pasa del primer candidato a uno con mejores resultados verificados. La política en sombra se evalúa en memoria. |
| ¿Qué recibe un worker cuando el Host le niega admisión? | [hosted.mjs](hosted.mjs) | Un Host simulado procesa una revisión y rechaza la segunda cuando se ocupa el cupo. El ejemplo usa el protocolo público dentro de un proceso. |

## Comprobá tu instalación y elegí cuándo gastar turnos

- **Diagnóstico de cuatro CLIs.** Ejecutá `node labs/providers.mjs`. Inspecciona las instalaciones y el catálogo, y negocia Gemini con `analyze` y Antigravity con `edit`. La consulta admite que falten binarios o que una versión sea incompatible. Consume cero turnos. [Diagnóstico](providers.mjs)
- **Control experimental.** Ejecutá `node labs/control.mjs`. Probá qué ocurre al omitir el registro o el opt-in. Con la combinación compatible verás el plan que negocia cada adaptador. [Preflight de Control](control.mjs)
- **Memoria por MCP.** El laboratorio opcional instala el cliente del protocolo en un directorio temporal. Descubre y llama `memory_search` mediante stdio entre dos procesos locales. Consume cero turnos. [Cliente y servidor paso a paso](mcp/README.md)
- **Sesiones y streaming.** Ejecutá `npm ci` en la carpeta del tutorial una vez. Después podés usar `node --experimental-strip-types examples/02-sessions.ts` para exportar, reanudar y bifurcar una sesión de Claude, o `node --experimental-strip-types examples/04-streaming.ts` para ver eventos, abortar y reconciliar antes de continuar. Estos ejemplos envían prompts al proveedor autenticado. [Sesiones](../examples/02-sessions.ts) · [Streaming](../examples/04-streaming.ts)
- **Checkpoints y admisión compartida.** El ejemplo local de clasificación documental deja un trabajo guardado, reabre el mismo estado y reutiliza el resultado. Corré `node --experimental-strip-types examples/08-document-triage.ts --state-dir "$state_dir" --stop-after-intake` con un `state_dir` temporal absoluto. Después ejecutá el mismo comando sin `--stop-after-intake` dos veces. La última debería devolver `executedSteps: []`. [Flujo documental](../examples/08-document-triage.ts)

## Índice de las entradas públicas de la beta

Cada fila enlaza un consumidor que importa esa entrada. El inventario se contrasta con `exports` del paquete instalado al ejecutar los laboratorios. Una fila acredita un punto de partida por módulo. Para verificar un método, un transporte o una versión de CLI específica, consultá el ejercicio y sus condiciones.

| Entrada de npm | Consumidor | Qué usa |
| --- | --- | --- |
| `hiveagents-runtime` | [roles del tablero](../src/agents.mjs) | Runtime, configuración de proveedor y agentes |
| `hiveagents-runtime/routing` | [selector del tablero](../src/agents.mjs) | Preflight y recibos de selección |
| `hiveagents-runtime/routing/learning` | [aprendizaje](learning.mjs) | Evidencia por tarea y estimador contextual |
| `hiveagents-runtime/adapter-kit` | [CLI propio](custom-cli.mjs) | Ejecución de un proceso y validación de su respuesta |
| `hiveagents-runtime/orchestration` | [cupos](capacity.mjs) | Admisión compartida; otros ejercicios usan inbox, contexto y almacenamiento |
| `hiveagents-runtime/orchestration/graph` | [dependencias](plan.mjs) | Orden de ejecución y ciclos |
| `hiveagents-runtime/orchestration/dynamic` | [plan](plan.mjs) | Validación, límites y recuperación |
| `hiveagents-runtime/orchestration/memory` | [memoria](memory.mjs) | Proveedor de memoria basado en puertos |
| `hiveagents-runtime/orchestration/log` | [historial](history.mjs) | Identidad, estado terminal y evidencia |
| `hiveagents-runtime/memory-tools` | [herramientas de memoria](memory.mjs) | Búsqueda y propuestas con alcance por tarjeta |
| `hiveagents-runtime/hosted` | [worker](hosted.mjs) | Ejecución y denegación de admisión por un Host |

### Qué queda por validar en entornos reales

Las prioridades pendientes son registrar un turno y una reanudación de Gemini y Antigravity con versiones y autenticación compatibles, ejercitar aprobaciones y herramientas de Control con cada combinación que se quiera recomendar y validar el worker contra el Host elegido para producción. Si vas a recomendar un modelo por calidad, costo o latencia, reuní evidencia de una carga representativa con tareas nuevas, métricas comparables y un conjunto de evaluación independiente. Los ejemplos locales permiten aprender y reproducir los mecanismos antes de invertir en esas pruebas.

## Herramientas acotadas en Control

El ejemplo usa dos herramientas de aplicación con un esquema y un autorizador por herramienta. El control de aceptación verifica una lectura y una sola escritura en un directorio temporal. El resultado se puede observar con un transporte simulado.

```sh
node --experimental-strip-types examples/control-tools.mjs
```

Con el CLI Codex autenticado, el recorrido usa un App Server real y un turno. Para Claude, instalá los peers opcionales compatibles y ejecutá el ejemplo con `claude claude/sonnet`.

```sh
node --experimental-strip-types examples/control-tools.mjs codex codex/gpt-5.6-sol
npm install --no-save --package-lock=false @anthropic-ai/claude-agent-sdk@0.3.252 @modelcontextprotocol/sdk@1.29.0
node --experimental-strip-types examples/control-tools.mjs claude claude/sonnet
```

El ejemplo autoriza operaciones concretas con su propio callback. El tratamiento de aprobaciones de herramientas nativas depende de cada proveedor. [Definición y autorizadores](../examples/control-tools.ts)
