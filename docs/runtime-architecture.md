# Arquitectura de HiveAgents Runtime

HiveAgents Runtime es un SDK TypeScript para ejecutar los CLI de agentes que ya usás. Tu aplicación define el trabajo, los permisos y los criterios de aceptación. El SDK traduce ese contrato al proveedor, prepara el turno y normaliza su resultado. El CLI conserva su autenticación y ejecuta el trabajo según su configuración y las capacidades negociadas. [Inicio rápido](../README.md#1-abrí-el-tablero) · [Laboratorios por capacidad](../labs/README.md)

Los diagramas cubren las interfaces de la beta y señalan dónde cambia el comportamiento según el proveedor o despliegue. El laboratorio de escritorio instala `0.1.0-beta.3` desde npm. Para probar Antigravity CLI 1.5.15 usá el artefacto de `0.1.0-beta.4` indicado en sus notas. [Compatibilidad de los laboratorios](../labs/README.md#pruebas-en-vivo-y-comparación-de-proveedores) · [Antigravity y beta.4](../labs/antigravity-live.md)

## Un paquete, varios niveles de integración

```mermaid
flowchart TD
    accTitle: Capas de HiveAgents Runtime
    accDescr: La aplicación usa el core y puede añadir selección, workflows, memoria o adaptadores en el mismo paquete. El SDK habla con procesos de proveedores.
    app["Aplicación<br/>Tareas, permisos, presupuesto y verificadores"]
    subgraph sdk["Paquete hiveagents-runtime"]
        direction TB
        route["/routing<br/>Candidatos, preflight y recibo"]
        learning["/routing/learning<br/>Selección evaluada y política activa"]
        orch["/orchestration y sus subrutas<br/>Pasos, memoria, admisión y registro"]
        tools["/memory-tools<br/>Búsqueda y propuestas vía herramientas o MCP"]
        core["Import principal<br/>Runtime, Agent y Session"]
        kit["/adapter-kit<br/>Primitivas para otros CLI"]
        ad["Registros internos de proveedores<br/>Contexto, permisos, capacidades y protocolo"]
        host["/hosted<br/>Runtime proxy del worker"]
        route --> core
        learning --> core
        orch -.->|"Los pasos pueden llamar al SDK"| core
        tools -.->|"Canal de herramientas"| core
        kit -.->|"Registro de otro proveedor"| ad
        core --> ad
        host --> core
    end
    app --> core
    app --> route
    app --> learning
    app --> orch
    app --> tools
    app --> host
    ad --> cli["CLI instalados<br/>Claude Code, Codex, Gemini y Antigravity"]
    cli --> services["Servicios del proveedor<br/>Planes, cuentas y modelos"]
```

`package.json#exports` define las once entradas del mismo paquete. Los adaptadores incluidos son detalles de implementación. Para integrar otro CLI, construí un `ProviderRegistration` que declare catálogo y capacidades y registre sus adaptadores. Para agregar estado a tu producto, componé la capa de orquestación alrededor de las llamadas al core. [Entradas públicas y ejercicios](../labs/README.md#índice-de-las-entradas-públicas-de-la-beta) · [Ejemplo de registro de otro CLI](../labs/custom-cli.mjs)

Una arquitectura agentic necesita un lugar que decida cuándo actuar. Por ejemplo, el Kanban pide al planificador elegir una tarjeta entre las elegibles y comprueba su identidad antes de asignarla. Un redactor entrega el documento, código local valida los requisitos y otro agente aporta el dictamen editorial. El tablero guarda las transiciones y limita los intentos. Esta división permite cambiar el proveedor y conservar la cola, los criterios y las pruebas de la aplicación. [Tutorial Kanban](../README.md) · [Cola y transiciones](../src/board.mjs)

## Del catálogo al turno

```mermaid
sequenceDiagram
    accTitle: Selección y ejecución de un turno
    accDescr: Primero se prepara el modelo y se guarda un recibo con cero despachos. La aplicación decide cuándo enviar el turno.
    participant App as Aplicación
    participant R as Selector createAgent
    participant SDK as Runtime y Agent
    participant S as Almacén de recibos
    participant CLI as CLI instalado

    App->>R: mode auto, permisos y metadatos de la tarea
    R->>SDK: Cargar candidatos de los registros
    loop En orden de prioridad hasta hallar un candidato elegible
        R->>SDK: Preparar el candidato y verificar capacidades
        SDK->>CLI: Comprobar instalación, compatibilidad y acceso
        CLI-->>SDK: Evidencia de diagnóstico
        SDK-->>R: Preparación y capacidades efectivas
    end
    R->>S: Guardar recibo de selección con nativeDispatches = 0
    alt Hay ruta y el pedido sigue vigente
        R-->>App: Agent preparado y recibo
        App->>SDK: agent.run con la consigna
        SDK->>CLI: Despachar el turno mediante el adaptador
        CLI-->>SDK: Eventos y resultado nativos
        SDK-->>App: Resultado normalizado y validado
    else Sin ruta elegible o selección cancelada
        R-->>App: Error tipado y recibo
    end
```

- **Modelo fijo.** Construí un `Agent` con un ID de modelo cuando tu producto requiera un proveedor o una configuración específicos. Usá `Agent.ready()` si querés mostrar el diagnóstico antes de enviar trabajo.
- **Selección automática.** Pasá `model: { mode: 'auto' }` a `createAgent`. Si omitís `candidates`, el selector usa el catálogo de los proveedores registrados. Aplica filtros de instalación, autenticación, capacidades y política. Prueba candidatos por prioridad o por la primera regla aplicable. La alternativa declarada se evalúa durante el preflight. Si luego falla un turno, la app decide cómo recuperarlo.
- **Selección con aprendizaje.** `LearningRouter` parte de candidatos explícitos en la definición. La aplicación puede derivarlos del catálogo. La ejecución registra resultados verificados y genera una política candidata en sombra. La promoción o reversión requiere pasar una evaluación con evidencia nueva y comparar contra la política activa. La aplicación aporta el presupuesto, el verificador y el protocolo.

El recibo del selector registra por qué se propuso una ruta y los filtros observados. El resultado del turno y los controles del entregable son evidencia separada. Para medir qué modelo conviene, fijá una tarea, un criterio reproducible y un presupuesto. Los objetivos de costo o latencia exigen métricas comparables y un piso de calidad. [Selección sin indicar modelo](../labs/auto-model.md) · [Evaluación, promoción y rollback](../labs/learning-cycle.md)

### Cómo cambia la política de aprendizaje

```mermaid
flowchart LR
    accTitle: Evidencia y cambios de política
    accDescr: Los resultados verificados producen una propuesta. Una evaluación separada con tareas nuevas decide si cambia la política.
    turn["Turno admitido<br/>Identidad de ejecución"]
    verify["Verificador de la aplicación<br/>Calidad, uso y latencia observados"]
    evidence[("Evidencia local")]
    shadow["Propuesta en sombra"]
    benchmark["Evaluación prospectiva<br/>Regresiones y casos nuevos"]
    gate{"¿Mejora medida<br/>sin regresiones?"}
    current["Conservar política activa"]
    next["Publicar política evaluada"]
    turn --> verify --> evidence --> shadow
    shadow --> benchmark --> gate
    gate -->|"Sí"| next
    gate -->|"Evidencia insuficiente"| current
    next -->|"Próximo turno"| turn
    current -->|"Próximo turno"| turn
```

La evaluación trata la política anterior como otra candidata para el rollback. Hace falta una prueba nueva antes de volver a activarla. Las tareas reservadas para la evaluación quedan fuera del entrenamiento. Ante un cambio de verificador o de identidad de ejecución, la evidencia se separa. [Protocolo de mejora](../labs/learning-cycle.md)

## Transportes y límites de autoridad

| Transporte | Cómo se ejecuta | Qué decide la aplicación |
| --- | --- | --- |
| `exec` | Proceso CLI por turno. El adaptador normaliza la salida y usa el mecanismo del proveedor para reanudar cuando está disponible. | Elige contexto, intención de permisos y variables permitidas. Puede pasar una señal, un plazo y `awaitSettlement: true` para esperar el cierre del trabajo observado. |
| `control` | Sesión bidireccional de Claude Agent SDK o Codex App Server. Requiere registrar el adaptador y habilitar `experimentalControl`. Las herramientas de aplicación requieren además `experimentalApi`. | Puede atender solicitudes y controles que el proveedor negocie. Una decisión queda limitada a la solicitud presentada y a la autoridad inicial de la sesión. |

```mermaid
sequenceDiagram
    accTitle: Aprobación e interrupción en Control
    accDescr: La aplicación decide sobre una solicitud vinculada al transporte. El SDK aplica el techo de permisos y expira solicitudes al cancelarse.
    participant App as Aplicación u operador
    participant SDK as SDK Control
    participant P as Claude Agent SDK o Codex App Server

    App->>SDK: Abrir sesión con permisos y activar Control
    SDK->>P: Negociar el transporte con el perfil inicial
    App->>SDK: Iniciar turno
    SDK->>P: Entregar turno
    P-->>SDK: Solicitar una decisión
    SDK-->>App: Presentar solicitud, vínculo y señal
    alt Decisión vigente
        App->>SDK: Responder por callback o handle
        SDK->>SDK: Validar vínculo, respuesta y techo de permisos
        SDK-->>P: Aplicar respuesta permitida o denegar
    else Cancelación, plazo vencido o transporte obsoleto
        SDK-->>App: Expirar solicitud y cerrar su diálogo
        SDK-->>P: Denegar la interacción o interrumpir el turno según el caso
    end
    P-->>SDK: Estado terminal cuando se confirma
    SDK-->>App: Resultado o estado de interrupción observado
```

Cada aprobación opera dentro del techo de permisos de la sesión. En Codex, bajo `analyze` o `edit`, una escalada de comandos o escritura de archivos se rechaza aunque la interfaz intente aceptarla. En Claude, la aprobación de una herramienta se liga a los argumentos presentados. Configurá el revisor nativo para entregar las solicitudes a la app si tu política depende de ese callback. Cerrar una vista, solicitar una interrupción y confirmar el cierre del proceso son operaciones distintas. [Aprobaciones nativas con ejemplos reproducibles](../labs/native-approval.md)

Los permisos describen el control que aplica cada CLI. Un perfil nativo puede cargar instrucciones, plugins, hooks, herramientas o MCP del entorno. Usá aislamiento externo para repositorios o entradas no confiables y elegí el contexto, las credenciales y los permisos explícitamente. [Aislamiento en el ejemplo de escritorio](architecture.md#procesos-y-límites)

## Despliegue y persistencia

```mermaid
flowchart LR
    accTitle: Despliegue directo o mediado por un Host
    accDescr: En local la app ejecuta el CLI. Con un Host, el worker solicita la ejecución y el Host controla el destino y la admisión.
    subgraph local["Aplicación local"]
        direction TB
        app["Proceso de la app<br/>Runtime local y política"]
        files[("Estado local de la app<br/>Checkpoints, historial y recibos")]
        cli1["CLI bajo la cuenta local"]
        app --> files
        app -->|"Adaptador"| cli1
    end
    subgraph hosted["Aplicación con autoridad separada"]
        direction TB
        worker["Worker<br/>createHostedRuntime"]
        host["Host provisto por la aplicación<br/>Valida recetas y admite trabajo"]
        ledger[("Registro de admisión<br/>del Host")]
        cli2["CLI iniciado por el Host"]
        worker -->|"Cliente del canal de ejecución"| host
        host --> ledger
        host -->|"Ejecuta y observa finalización"| cli2
    end
```

Para una app local, instalá el SDK junto a los CLI y guardá los datos debajo de un directorio de la aplicación. Cuando necesitás mediar qué puede ejecutar un worker, `/hosted` construye un runtime proxy con descriptores de un Host externo. El Host dueño de los procesos valida canal, receta, directorio y destino, aplica límites y observa la finalización antes de liberar cupos. El módulo Hosted ofrece por defecto fábricas proxy para Claude y Codex en `exec`. Otros proveedores requieren un registro explícito en el bootstrap confiable y soporte de su Host. El laboratorio usa procesos separados bajo un mismo usuario. La separación de permisos entre esos procesos depende de cómo los despliegues. [Host y worker de referencia](../labs/hosted-process.md)

| Estado | Quién lo guarda | Qué podés recuperar |
| --- | --- | --- |
| Conversación nativa | CLI | Una sesión compatible con el proveedor y el transporte a partir de una referencia exportada. |
| Progreso del workflow | Aplicación mediante `WorkflowRunner` y su almacén | Pasos ya completados y datos necesarios para continuar. Un paso que cayó en curso puede exigir reconciliar su efecto antes de repetirlo. |
| Decisión y ejecución | Aplicación mediante un almacén de recibos y, si lo configura, el registro de ejecución | La ruta que se propuso y evidencia de los turnos registrados. |
| Evidencia de aprendizaje | Aplicación mediante `SqliteLearningStore` | Intentos, observaciones y generaciones de políticas vinculados al protocolo, la tarea y el verificador. |
| Memoria compartida | Store de la aplicación, por puertos o MCP | Registros dentro del alcance declarado. La app decide qué propuestas se conservan. |

Usá claves de idempotencia donde el destino las soporte y reconciliá efectos de estado incierto. Los checkpoints y recibos aportan evidencia para tomar esa decisión. [Plan dinámico y journal](../labs/plan.mjs) · [Historial](../labs/history.mjs) · [Cupos compartidos](../labs/capacity.mjs)
