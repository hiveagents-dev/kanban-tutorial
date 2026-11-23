# Ejecutá un agente con un Host en otro proceso

Un revisor recibe Markdown y comprueba si contiene la sección `## Evidencia`. El worker crea un `Agent` con `createHostedRuntime`. Envía solicitudes al Host por un canal IPC privado abierto con `node:child_process`. El Host comprueba cada solicitud, reserva el cupo en SQLite y ejecuta un CLI local que lee el documento por stdin.

## Ejecutá el laboratorio

Desde la raíz del tutorial, con Node.js 22.16 o posterior:

```sh
npm ci
node labs/hosted-process.mjs
```

Vas a ver cuatro resultados en orden.

1. **Cupo ocupado.** El primer CLI ya emitió texto y el Host espera antes de entregar el resultado. El segundo worker recibe `ADMISSION_REFUSED` con motivo `concurrency-limit` y un recibo vinculado a la solicitud. El contador sigue en un despacho.
2. **Liberación.** El primero completa la revisión y el registro vuelve a cero cupos activos.
3. **Alcance.** Una solicitud de prueba cita otro directorio. El Host responde `EXECUTION_HALTED` antes de reservar o iniciar el CLI.
4. **Nueva admisión.** Un nuevo worker revisa la segunda tarjeta. El contador termina en dos despachos y cero cupos activos.

Todo usa archivos y procesos temporales, con cero turnos de modelo. El wrapper verifica los resultados y cierra workers, procesos y estado local.

## Seguí el código

| Componente | Qué decide |
| --- | --- |
| Ejercicio | Ordena las solicitudes y verifica los resultados. Retiene temporalmente la primera respuesta para hacer observable la concurrencia. [Escenario](hosted-process.mjs) |
| Worker | Usa la receta del Host, crea un runtime y envía el prompt de revisión por IPC. El SDK conserva la correspondencia entre respuesta, sesión y descriptor. [Worker](fixtures/hosted-local-worker.mjs) |
| Host | Emite el descriptor y comprueba la identidad del canal, el modelo y el directorio exactos. Guarda el cupo en `HostLedger` y fija ejecutable, argumentos, entorno y plazos. Libera la reserva al terminar la operación. [Host de referencia](fixtures/hosted-local-host.mjs) |
| CLI | Lee texto desde stdin y escribe un veredicto fijo. El Host usa `runProcess` para iniciar y esperar ese proceso. [CLI local](fixtures/hosted-review-cli.mjs) |

El descriptor usa el esquema de registro de Claude para negociar el transporte `exec`. El destino y el modelo `claude/kanban-local` pertenecen a este ejercicio. El canal admite un pedido por vez y se cierra si el worker desaparece. El Host cancela el trabajo asociado y espera su finalización antes de cerrar el registro de cupos.

El Host de referencia y sus workers corren con el mismo usuario del sistema operativo. La receta acota lo que el Host acepta por IPC. El aislamiento de archivos del worker y la recuperación tras la caída abrupta del Host requieren las garantías de la plataforma que despliegues. [Registro durable y admisión](capacity.mjs)

## Verificación de la plataforma

También reconstruimos el Host local de la plataforma con los bytes de la beta publicada. En macOS, sus pruebas separaron el worker y el proveedor, verificaron la contención de ambos, rechazaron la ejecución cuando faltaba la política y comprobaron la detención y el reinicio. Los seis casos usaron un ejecutable sintético. El ejercicio de referencia de esta página corre de forma independiente. [Resultados de la plataforma](../evidence/hosted-platform.json)
