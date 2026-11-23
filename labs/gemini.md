# Gemini CLI con credenciales oficiales

El laboratorio usa el adaptador `exec` de `hiveagents-runtime@0.1.0-beta.3` con Gemini CLI **0.56.0** y un modelo explícito. El CLI se inicia mediante el SDK. Desde Workspace vacío y temporal, la prueba envía un token sintético, lo recupera en otro proceso con el mismo ID de sesión y verifica que el canario de escritura no aparezca bajo `analyze`. El canario prueba el resultado en esa ejecución. En la corrida guardada no se observó una llamada de escritura. [Información de autenticación de Gemini CLI](https://geminicli.com/docs/get-started/authentication/)

## Vertex AI

Desde la carpeta de la app, ejecutá el ejemplo con un proyecto y una ubicación habilitados para el modelo. Usá credenciales de aplicación ya configuradas. La prueba registrada usó la cuenta de servicio que señalaba `GOOGLE_APPLICATION_CREDENTIALS`, el endpoint `global` y el ID `gemini-3.7-flash`. El laboratorio hace hasta tres lanzamientos del CLI y pueden consumir cuota del proyecto. [Modelo Gemini 3.7 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-7-flash)

```sh
npm ci
export GOOGLE_CLOUD_PROJECT="tu-proyecto-habilitado"
export GOOGLE_CLOUD_LOCATION=global
HIVE_LIVE_TURNS=1 HIVE_GEMINI_AUTH=vertex \
  HIVE_GEMINI_MODEL=gemini/gemini-3.7-flash \
  HIVE_GEMINI_REPORT=gemini-vertex.json node labs/gemini-live.mjs
```

El modelo `gemini-2.5-flash` que trae el catálogo inicial de la beta fue retirado de Vertex AI en octubre de 2026. El adaptador admite un modelo nativo indicado explícitamente. Elegí un ID que tu cuenta y tu región puedan usar. [Ciclo de vida de modelos de Vertex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)

## Gemini API

También podés ejecutar el archivo con `HIVE_GEMINI_AUTH=api-key` y `GEMINI_API_KEY` configurada en tu sesión. Indicá un ID devuelto por tu catálogo de Gemini API. La prueba guardada usó Vertex AI. [Autenticación con clave de la Gemini API](https://geminicli.com/docs/get-started/authentication/#use-gemini-api-key)

```sh
HIVE_LIVE_TURNS=1 HIVE_GEMINI_AUTH=api-key \
  HIVE_GEMINI_MODEL=gemini/ID-DE-TU-CATALOGO node labs/gemini-live.mjs
```

## Leer la evidencia

Cada etapa devuelve resultado, latencia de pared, tokens si el CLI los informa y códigos de diagnóstico acotados. Si usás `HIVE_GEMINI_REPORT`, el mismo JSON queda en un archivo. Durante el preflight el adaptador identifica el método local y conserva estado de autenticación `unknown`. El turno completado verifica que esas credenciales funcionan para ese modelo y configuración. La prueba usa `Agent` con un modelo fijo y `requireAuth: 'any'`. El routing automático exige confirmar la autenticación salvo opt-in explícito.

La sesión se guarda en el perfil temporal del CLI mientras dura la comprobación y se elimina al final. El informe conserva la coincidencia de identidad y del token como resultados de las aserciones. Los recuentos de tokens corresponden a input, output y caché reportados por el CLI, que incluyen el contexto propio del proveedor. El costo en dinero queda `unavailable`.

Google trasladó la oferta para cuentas individuales a Antigravity en junio de 2026. El acceso de Gemini CLI para Code Assist Standard o Enterprise y mediante las APIs pagas sigue la política publicada por Google. [Anuncio de Google](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
