# De una política inicial a promoción y rollback

El router adaptable decide qué modelo conviene para una tarea a partir de resultados verificados. Este laboratorio le pide que lea la prioridad o el estado de tarjetas sintéticas. Dos candidatos representan respuestas distintas de un CLI local determinista. El SDK ejecuta ese proceso, registra las observaciones y aplica las reglas de promoción en SQLite. [Ejecutor](learning-cycle.mjs) · [CLI de prueba](fixtures/learning-cycle-cli.mjs)

Desde la carpeta del tutorial, instalá las dependencias y ejecutá el ejemplo.

```sh
npm ci
node labs/learning-cycle.mjs
```

La corrida tarda unos 25 segundos en una máquina de desarrollo. Crea un directorio temporal, inicia 50 turnos del proceso local y elimina sus archivos al terminar. El runtime sólo registra el proveedor de prueba. No requiere cuentas ni consume turnos comerciales.

| Paso | Qué comprueba el ejemplo | Resultado |
| --- | --- | --- |
| Política inicial | Antes de entrenar, la primera tarjeta usa el candidato `base`. | Generación 0 |
| Entrenamiento | Ambos candidatos resuelven ocho tarjetas. La app compara cada respuesta con el valor esperado que ya conoce. La política en sombra conserva 16 observaciones verificadas. | El puntero activo sigue vacío |
| Evaluación incompleta | Se registra una tanda nueva con resultados todavía pendientes. | `INCOMPLETE` y generación 0 |
| Promoción | Dos casos fijos comprueban que el cambio conserva el comportamiento esperado y seis casos nuevos miden la mejora. Los dos candidatos ejecutan cada caso. | `promoted` con 6 victorias nuevas y generación 1 |
| Reinicio | Otro proceso abre SQLite y recupera el puntero. Una tarjeta nueva selecciona `especialista`. | `LEARNED` |
| Rollback | El fixture cambia sus respuestas. Se vuelven a ejecutar los casos fijos y se reserva otro conjunto nuevo. Otro proceso verifica el puntero restaurado. | `rolled-back` con 6 victorias de `base` y generación 2 |

## Vinculá las decisiones con la evidencia

- `LearningRouter.run()` registra el intento y pasa el resultado a un verificador controlado por la app. El resultado esperado se mantiene separado de la entrada que recibe el candidato. El contexto [1, 0] identifica una consulta de prioridad y [0, 1] una consulta de estado.
- `LearningRouter.shadow()` consolida las observaciones de entrenamiento. Los casos fijos y nuevos quedan reservados por identidad y fuera del entrenamiento. Cada caso nuevo aporta una sola comparación aunque se haya ejecutado en ambos candidatos.
- `LearningRouter.improve()` consulta la evidencia completa, verifica los resultados pareados y guarda la decisión. Para promover exige un conjunto nuevo suficiente y ausencia de regresiones en la suite fija. Una omisión conserva la política vigente.
- La reversión referencia la política anterior y exige sus propias observaciones. En este ejemplo la política inicial tiene puntero `null`, que indica que se elige el primer candidato elegible. El resultado final conserva la política revertida en `previous`.

La prueba cambia el comportamiento del CLI mediante un archivo de fase del entorno temporal. El ejecutable y los IDs de candidatos siguen siendo los mismos. Así el rollback mide un cambio en las respuestas observadas. Las comparaciones enseñan el mecanismo de decisión con datos sintéticos. Para tomar decisiones de producción, usá tus propios casos, un verificador independiente y un presupuesto de ejecución.
