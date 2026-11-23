# Aprobaciones nativas con Control

Una aprobación nativa empieza cuando el proveedor pide permiso para una acción. La aplicación recibe la solicitud mediante `onInteraction` y decide qué responder. El laboratorio muestra cuándo el adaptador puede aplicar esa decisión y cómo se cierra la solicitud.

Desde la carpeta del tutorial, instalá las dependencias y corré los seis escenarios con una sesión de proceso por escenario.

```sh
npm ci
node labs/native-approval.mjs
```

Se usa `hiveagents-runtime@0.1.0-beta.3`. El SDK abre ambas sesiones con `transport: 'control'`, el registro de su proveedor, `experimentalControl: true` y permisos `analyze`. Los fixtures reproducen los mensajes de proveedores. La negociación, los adaptadores, la entrega a la aplicación y la liquidación de cada respuesta usan el SDK publicado. [Código del laboratorio](native-approval.mjs) · [Fixtures de proveedor](fixtures/native-approval-fixtures.mjs)

| Proveedor | Solicitud simulada | Respuesta comprobada |
| --- | --- | --- |
| Claude Code | Lectura de la ficha temporal | `allow` aprueba exactamente esa lectura. `deny` la rechaza. |
| Claude Code | El proveedor cancela la lectura mientras espera | Se devuelve `deny` y una aprobación tardía recibe `INTERACTION_EXPIRED`. |
| Codex | Solicitud de comando o cambio de archivo en solo lectura | La aplicación responde `decline`. El proveedor recibe una decisión por solicitud. |
| Codex | La aplicación intenta responder `accept` a un cambio en solo lectura | `respond()` devuelve `UNSUPPORTED_CAPABILITY` y el proveedor recibe `decline`. |

## Vinculá la decisión a lo que se mostró

En una interfaz, conservá el `interactionId`, el tipo y los argumentos visibles con los que se abrió el diálogo. El vínculo también identifica el método del proveedor, la sesión, el transporte y la huella del payload. Codex agrega sus identificadores RPC, de turno y de ítem cuando están disponibles.

El ejemplo responde con `handle.respond(request.binding.interactionId, ...)` desde la interfaz. La alternativa es devolver la decisión desde `onInteraction`. Elegí una modalidad por solicitud. El laboratorio retiene el callback mientras responde desde el handle, vuelve a intentar una decisión ya asentada y comprueba que el proveedor sólo recibe una respuesta. La señal `request.signal` permite cerrar un diálogo que dejó de tener autoridad. El plazo del turno acota la espera.

En Claude verificá el nombre de la herramienta y los argumentos exactos. En Codex, los modos `analyze` y `edit` conservan su techo para comandos y cambios de archivos aunque el protocolo anuncie `accept`. Los grants de `item/permissions/requestApproval` no están implementados en esta beta. [Flujo de aprobación de Claude](https://code.claude.com/docs/en/agent-sdk/permissions) · [Protocolo del App Server de Codex](https://learn.chatgpt.com/docs/app-server#approvals)

## Repetí la prueba con Claude Code

Este comando usa la autenticación local de Claude Code y ejecuta hasta dos turnos. Restringe el conjunto de herramientas nativas a `Read` y le pide al SDK de Claude una aprobación para cada lectura. El programa concede una sola lectura de un archivo que creó dentro de un directorio temporal. En el turno de rechazo pide al modelo el marcador `DENEGADO` y comprueba que recibió la solicitud y que el texto no contiene el contenido de la ficha.

```sh
npm install --no-save --package-lock=false @anthropic-ai/claude-agent-sdk@0.3.252 @modelcontextprotocol/sdk@1.29.0
node labs/native-approval.mjs --live-claude
```

La prueba registrada observó una solicitud `canUseTool` en cada turno. Cuando se autorizó, Claude devolvió el contenido exacto de la ficha. Cuando se rechazó, devolvió `DENEGADO`. [Resultados en vivo](../evidence/native-approval-live.json)

## Probá el límite de solo lectura con Codex

Este comando ejecuta un turno de prueba con Codex autenticado. El proceso usa `approvals_reviewer="user"` para dirigir las solicitudes al cliente que abrió la sesión. Pide editar la ficha temporal, responde `decline` cuando llega la solicitud y compara los bytes del archivo con el original. `approvalObserved` indica si el App Server le entregó un pedido de aprobación a la aplicación. [Configuración del revisor de Codex](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)

```sh
node labs/native-approval.mjs --live-codex
```

En la corrida registrada con Codex CLI 0.153.4 llegó un pedido `item/fileChange/requestApproval`, la aplicación respondió `decline` y la ficha conservó sus bytes. El fixture activa el pedido de manera determinista y agrega el caso en que la aplicación intenta aceptarlo bajo el techo de solo lectura. [Resultados en vivo](../evidence/native-approval-live.json)

La configuración del revisor importa. En una corrida exploratoria que heredó la revisión automática de Codex, la ficha temporal cambió. Si tu aplicación exige decidir las aprobaciones, verificá la ruta del revisor con un archivo sintético antes de usar el callback como control.
