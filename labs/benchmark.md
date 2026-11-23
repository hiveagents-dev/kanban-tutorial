# Comparar modelos con tareas verificables

Este laboratorio ejecuta los mismos casos de Kanban con cada modelo seleccionado. La prioridad se verifica contra la tarjeta elegible. La redacción se comprueba leyendo los estados y cantidades de la tabla, y la revisión compara el dictamen con la política de reintentos. Fijamos los casos y las verificaciones antes de ejecutar los modelos. [Casos y verificadores](fixtures/kanban-benchmark.mjs)

## Resultados del 23 de noviembre de 2026

| Modelo solicitado | CLI | Aciertos | Mediana por turno | Importe informado |
| --- | --- | --- | --- | --- |
| Codex GPT-5.6 Sol | 0.153.4 | 4/4 | 4,45 s | Sin dato |
| Claude Sonnet 5 | 2.1.228 | 4/4 | 5,07 s | USD 0,014163 equivalentes de API por los 4 turnos |
| Antigravity Gemini 3.8 Flash Low | 1.5.15 | 4/4 | 9,09 s | Sin dato |
| Gemini 3.7 Flash por Vertex AI | 0.56.0 | 4/4 | 11,40 s | Sin dato |

Los cuatro modelos acertaron al priorizar, calcular el resumen, detectar el procedimiento falso y aprobar el correcto. Codex tuvo la menor mediana en esta muestra. En la redacción y el rechazo, Claude terminó unos 90 y 150 ms antes que Codex. Cada diferencia por caso proviene de un único turno. La corrida separada de Antigravity coincidió en parte con la de los otros proveedores, de modo que la latencia también refleja la carga local. Para decidir un primer candidato para estos ejercicios cortos, usá Codex por la mediana observada o Claude si preferís el perfil sin herramientas. Considerá Gemini si tu proyecto usa Vertex AI y Antigravity si usás ese CLI y su perfil de trabajo. El corpus no distinguió la calidad de los cuatro. Los importes disponibles son insuficientes para ordenar los costos.

Claude, Codex y Gemini se probaron con la beta.3 de npm. Antigravity usó un candidato local con el mismo número de versión y soporte para agy 1.5.15. Ambos recibos identifican el artefacto, los hashes del mismo corpus y ejecutor, y los resultados por rol. [Evidencia con la beta de npm](../evidence/model-benchmark-text.json) · [Evidencia de Antigravity](../evidence/model-benchmark-antigravity.json)

Con el esquema nativo que usa el tablero, repetimos los cuatro casos con Claude y Codex. Ambas configuraciones acertaron 4/4. La mediana fue 5,24 s para Codex y 6,24 s para Claude. Claude informó USD 0,0385507 equivalentes de API por los cuatro turnos. Codex omitió el importe. [Evidencia con esquema nativo](../evidence/model-benchmark-structured.json)

## Reproducí el estudio de texto

Desde la carpeta de la app, el siguiente comando ejecuta cuatro casos por proveedor, una vez cada uno. Abrí una sesión local en Claude Code y Codex para usar suscripciones. Para agregar Gemini usá las credenciales de Vertex AI ya configuradas y declaradas en el entorno. Vertex AI puede generar consumo de API según tu proyecto y plan.

```sh
HIVE_GEMINI_AUTH=vertex \
GOOGLE_CLOUD_PROJECT="$(gcloud config get project 2>/dev/null)" \
GOOGLE_CLOUD_LOCATION=global \
node labs/benchmark.mjs --live --format text --out ./mi-medicion.json \
  --models claude/claude-sonnet-5,codex/gpt-5.6-sol,gemini/gemini-3.7-flash \
  --cases prioridad-incidente,redaccion-resumen,revision-rechazo,revision-aprobacion
```

Después de instalar un SDK compatible con el CLI de Antigravity, podés incluir `antigravity/gemini-3.8-flash-low` en la misma lista. Antigravity usa el perfil `edit` que requiere el adaptador en una carpeta temporal dedicada a un solo turno. Si querés comparar el esquema nativo de Claude Code y Codex, elegí `--format structured` con sólo esos candidatos. Esa ejecución se evalúa separadamente de la comparación de texto. Sin `--live`, el laboratorio imprime ayuda y consume cero turnos. Elegí un nombre de salida nuevo para cada corrida.

## Interpretá el resultado

- **Aciertos.** Una respuesta pasa cuando satisface todos los controles del caso. En redacción éstos analizan los registros de una tabla sobre tareas acotadas. La calidad editorial de documentos abiertos requiere otras evaluaciones.
- **Latencia.** `turnMs` abarca la llamada a `agent.run` en el reloj de la aplicación. `totalMs` incluye preparación y cierre. Las medianas corresponden a los turnos aprobados. Para comparar un rol, revisá la cantidad de casos de ese rol junto con su duración.
- **Costo.** `costMeaning` indica qué significa el importe observado. Un importe de Claude marcado como `api-equivalent` es la equivalencia informada por su CLI. La factura de la cuenta se consulta en el proveedor. Si los importes faltan o su significado difiere, la tabla deja la comparación de costo pendiente.
- **Selección.** Usá el resultado como referencia inicial para tareas similares. Para cambiar prioridades de producción, repetí con casos nuevos del dominio, medí la calidad y el tiempo en tu entorno, y compará el costo con una métrica común.
