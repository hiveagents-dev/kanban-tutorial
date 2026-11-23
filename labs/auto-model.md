# Elegí un modelo sin pasar su nombre

La aplicación entrega la tarea y pide `model: { mode: 'auto' }`. El SDK obtiene los candidatos del catálogo del runtime. Con `new Runtime()` están registrados los proveedores de Claude Code, Codex, Gemini CLI y Antigravity CLI. La app puede pedir un permiso o una capacidad requerida según el trabajo. [Ejemplo ejecutable](auto-model.mjs)

```js
const { agent, receipt } = await createAgent({
  model: { mode: 'auto', allowUnverifiedModels: true },
  permissions: { mode: 'analyze' },
}, { runtime, receipts });
```

Este ejemplo admite candidatos con disponibilidad de catálogo por verificar. El SDK sigue comprobando el CLI, la autenticación y los permisos. La autenticación desconocida queda excluida en la corrida con tus CLIs. El selector toma el primer candidato elegible según el orden del catálogo. El recibo distingue al elegido, el motivo de la decisión y los candidatos que quedaron sin consultar.

## Probalo con tus CLIs

Desde la raíz del tutorial, ejecutá estos comandos.

```sh
npm ci
node labs/auto-model.mjs
```

El resultado muestra la selección y sus motivos sin ejecutar un modelo. Si la cuenta o las capacidades requeridas carecen de un candidato elegible, vas a ver `decision: "abstained"` y el motivo. En la corrida de referencia, el SDK eligió Claude Opus 5 por `PRIORITY`, con cero turnos. Gemini y Antigravity tienen laboratorios propios con su autenticación y permisos verificados. [Gemini por Vertex AI](gemini.md) · [Antigravity](antigravity-live.md)

Para enviar hasta un turno real, agregá `--live`. El ejemplo entrega una tarjeta sintética al agente elegido y verifica que devuelva el estado exacto. Para recorrer selección y ejecución sin credenciales ni turnos comerciales, usá el CLI local de prueba con `--fixture`.

```sh
node labs/auto-model.mjs --fixture
```

## Elegí según la calidad de la tarea

El primer candidato preparado es una política inicial. Para elegir con evidencia, el laboratorio de aprendizaje arma los candidatos desde el catálogo de un CLI local y usa un verificador independiente. Tras evaluar casos nuevos, el router elige al especialista para consultas de prioridad. Si los resultados cambian y una nueva evaluación favorece al candidato inicial, el router revierte la política. El pedido de producción pasa la tarea y el verificador. La configuración del laboratorio deriva las opciones del catálogo.

```sh
node labs/learning-cycle.mjs
```

La evidencia del ejercicio es sintética y demuestra el mecanismo de selección. Para elegir con calidad, costo o latencia en tu producto, medí trabajos representativos con esos mismos proveedores y un criterio comprobable. [Aprendizaje de punta a punta](learning-cycle.md) · [Comparación de modelos reales](benchmark.md)
