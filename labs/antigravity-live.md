# Antigravity CLI en vivo

Este ejercicio usa Antigravity CLI **1.5.15** y `hiveagents-runtime@0.1.0-beta.4`. Instalá y autenticá Antigravity con el procedimiento habitual de Google. El laboratorio usa la sesión local y envía dos turnos con un token sintético. [Guía de modo headless](https://antigravity.google/docs/cli/headless/)

Desde la carpeta de la app con sus dependencias instaladas:

```sh
node labs/antigravity-live.mjs --allow-live
```

Para validar el tarball exacto de una beta desde un consumidor temporal, copiá este laboratorio e instalá el archivo con npm. El argumento final vincula la integridad del lock con los bytes del tarball.

```sh
proof_dir=$(mktemp -d)
mkdir -p "$proof_dir/labs"
cp labs/antigravity-live.mjs "$proof_dir/labs/"
cd "$proof_dir"
npm install /ruta/absoluta/hiveagents-runtime.tgz
node labs/antigravity-live.mjs --allow-live /ruta/absoluta/hiveagents-runtime.tgz
```

Podés apuntar `HIVE_ANTIGRAVITY_BIN` a la ruta absoluta de una copia local del ejecutable. La prueba compara su huella antes de cada turno y al terminar. Una actualización del ejecutable durante la prueba invalida esa corrida.

El programa espera dos turnos completados con deltas de mensaje, la misma conversación nativa en procesos independientes, la misma respuesta sintética y cero eventos de herramienta. Compara un archivo de comprobación y el contenido del directorio antes y después. La salida contiene hashes y métricas disponibles. La prueba usa el permiso explícito `edit` con el modo nativo `request-review`, que respeta los permisos locales de Antigravity. El archivo testigo documenta lo observado en estas dos ejecuciones. [Código del laboratorio](antigravity-live.mjs)
