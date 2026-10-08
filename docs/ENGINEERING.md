# Manual de ingeniería — Probador 3D

Documento de referencia para TODOS los contribuyentes (humanos y agentes). Léelo entero antes de escribir código.

## 1. Producto en una frase

El usuario abre el navegador, pulsa **«Encender cámara»**; el sistema detecta su postura y estima sus medidas/talla
(o las introduce a mano); le ofrece prendas de un catálogo con muestras de tela; y se las **prueba en tiempo real como en un
espejo**: al moverse y cambiar de pose, la prenda 3D (realista, PBR, con caída de tela) se ajusta al cuerpo. Toda la UI vive
dentro de un **mundo 3D inmersivo** (una boutique/atelier), no en una web plana con un canvas incrustado.

Principios no negociables:

1. **Privacidad por diseño**: vídeo, fotos y medidas se procesan SÓLO en el dispositivo. Ningún fotograma ni landmark sale del
   navegador. Sin analítica de terceros, sin CDNs externos en runtime (todo se sirve del mismo origen).
2. **Realismo**: las prendas NO son mallas de pocos polígonos. Geometría densa (decenas de miles de triángulos), materiales PBR
   con micro-normales de tejido, costuras, dobladillos con grosor, oclusión ambiental, arrugas dependientes de la pose y
   movimiento secundario de tela.
3. **Honestidad de la estimación**: toda medida estimada por cámara lleva incertidumbre y la persona puede revisarla/editarla.
4. **Accesible**: la UI in-world tiene una capa DOM semántica real (teclado, lector de pantalla, `prefers-reduced-motion`).
5. **Robusto ante lo imprevisto**: NaN/Inf, pérdida de tracking, varias personas, permisos denegados, poca luz, sin WebGL.

## 2. Convenciones globales (¡críticas!)

- Unidades SI en el código: **metros**, kg, radianes. Las medidas de persona/prenda en **cm** sólo en los tipos de `measurements`/`catalog`.
- Mano derecha, **+Y arriba, +Z hacia donde MIRA el cuerpo** (hacia la cámara cuando el usuario la mira), **+X = lado IZQUIERDO de la persona**
  (= derecha de la imagen NO espejada). El efecto «espejo» se aplica como volteo horizontal FINAL del compuesto (vídeo + prendas juntos),
  nunca invirtiendo la geometría.
- Cuaterniones `[x, y, z, w]`. Triángulos CCW vistos desde fuera. UV con origen abajo-izquierda (como three.js).
- Espacio cámara: cámara en el origen mirando a **−Z**, +Y arriba.
- Esqueleto canónico de 21 joints (`packages/shared/src/skeleton.ts`), pose de reposo **A-pose**. `SkeletonPose.rotations[i]` es un delta
  local sobre el reposo. Skinning LBS con 4 influencias, **en CPU** (la simulación de tela necesita las posiciones).
- Landmarks MediaPipe: índices en `LM`. «left/right» son de la PERSONA.

## 3. Arquitectura y propiedad

```
packages/shared   contratos (tipos, zod, esqueleto, malla, FK/skinning)        ← propiedad: ORQUESTADOR (cambios sólo aditivos)
packages/body     cuerpo paramétrico + completeMeasurements + colisionadores   ← agente BODY
packages/pose     MediaPipe, suavizado, retargeting, escaneo de talla          ← agente POSE
packages/garments generador de prendas (GEO) + telas PBR/solver de tela (FABRIC) ← agentes GARMENT-GEO y GARMENT-FABRIC
packages/catalog  datos de catálogo + recomendación de talla                   ← agente CATALOG
apps/web          app (Vite + React + R3F)                                     ← WORLD (app/world/ui/i18n/state/styles) y MIRROR (camera/mirror/runtime)
infra/            AWS CDK                                                      ← agente INFRA  (+ .github/workflows, docs/deploy)
```

Dependencias permitidas (sin ciclos): `shared ← body ← garments`; `shared ← pose`; `shared ← catalog`; `apps/web` depende de todos.
**Los paquetes core (`shared`, `body`, `garments`, `catalog`) son puros**: sin DOM, sin `three`, sin React (lo impone ESLint). `pose` puede usar DOM
(adaptador MediaPipe) pero su lógica (filtros, retargeting, escaneo) es pura y testeable en Node.

Contratos públicos: `packages/shared/src/*.ts` y `apps/web/src/contracts.ts`. Los **stubs** que lanzan `NotImplementedError` marcan lo que
cada agente debe implementar con EXACTAMENTE esas firmas (puedes añadir exports; no cambies firmas existentes sin avisar en tu informe final).

## 4. Reglas de trabajo en el repositorio compartido

- Trabajáis TODOS en el mismo árbol de trabajo, **en directorios disjuntos**. Edita sólo lo que posees. Si necesitas algo de otro paquete,
  léelo y usa su API; si falta o falla, documéntalo en tu informe (no lo edites).
- **No ejecutes** `git commit/push/checkout/stash/reset/rebase/clean`. Solo el orquestador toca git. (`git status/diff/log` de lectura: OK.)
- Dependencias: ya están instaladas las previsibles. Si necesitas una más: `pnpm --filter <tu-paquete> add <dep>` (si el lockfile está ocupado,
  reintenta). No toques `package.json` raíz, `tsconfig.base.json`, `eslint.config.js`, `pnpm-workspace.yaml`.
- Cambios en `packages/shared`: sólo **aditivos** (nuevo archivo + una línea en `index.ts`, o añadir campos opcionales/exports). Documéntalo.
- Archivos temporales → carpeta scratchpad que te indiquen o `.scratch/` (ignorado por git). Nunca `/tmp` suelto en el repo.
- Idioma: código e identificadores en inglés; **comentarios y documentación en español** (como el código existente); texto de UI vía i18n (es + en).

## 5. Calidad (puertas de salida de cada paquete)

Antes de dar tu trabajo por terminado, desde la raíz:

```
pnpm --filter <tu-paquete> typecheck     # sin errores (TS estricto; prohibido `any` salvo justificado con comentario)
pnpm --filter <tu-paquete> test          # vitest en verde
pnpm lint                                # sin errores ni warnings nuevos
pnpm exec prettier --write <tus archivos>
```

- **Tests**: unitarios + de **propiedades** (`fast-check`) para invariantes numéricos + casos adversariales (NaN, ±Inf, vacíos, extremos de rango).
  Cobertura objetivo en paquetes core ≥ 85 % líneas (`vitest run --coverage`). Los tests deben ser **deterministas** (semillas fijas; nada de `Math.random()` sin semilla).
- **Sin efectos ocultos**: funciones puras donde se pueda; sin estado global mutable; sin `console.log` (usa `console.warn/error` sólo para anomalías reales).
- **Errores**: validar en los bordes con zod (`safeParse`) y devolver errores tipados; nunca tragar excepciones en silencio.
- **Rendimiento (presupuestos por fotograma a 60 fps = 16,6 ms)**: pose→esqueleto < 1 ms; skinning CPU cuerpo+prendas < 3 ms; solver de tela < 4 ms;
  sin asignaciones por fotograma en bucles calientes (reutiliza buffers `out`). Los generadores (cuerpo/prenda/texturas) pueden tardar más, pero medidlos
  y cacheadlos (el cambio de talla/prenda debe sentirse < 300 ms con workers o generación incremental; documenta lo que midas).
- **Seguridad**: sin `eval`/`new Function`/`innerHTML` con datos externos; todo dato externo (JSON del catálogo, medidas, archivos) se valida con zod;
  compatible con CSP estricta (`script-src 'self'`, sin inline scripts); sin peticiones a hosts externos en runtime.
- **Accesibilidad** (web): contraste AA, foco visible, navegación por teclado completa, `aria-*`, `prefers-reduced-motion`, alternativa sin cámara (entrada manual).

## 6. Entorno de pruebas local (todo es local; sin GPU)

- Node 22, pnpm 10. Navegador: Chromium en `/opt/pw-browsers/chromium` (Playwright **1.56.1** ↔ chromium-1194). **No ejecutes `playwright install`.**
- WebGL2 funciona vía SwiftShader (software, lento: úsalo para correctitud visual, **no** para medir fps). Lanzar con:
  `executablePath: '/opt/pw-browsers/chromium'`, args: `--no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`.
- Cámara falsa: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<archivo.y4m|mjpeg>`
  (genera vídeos con `ffmpeg`, que está instalado). `getUserMedia` sólo existe en contexto seguro: usa `http://localhost`/`127.0.0.1`.
- Modelos de pose: `NODE_USE_ENV_PROXY=1 node scripts/fetch-models.mjs` (idempotente, con SHA-256) → `apps/web/public/{models,wasm}`.
  Sólo se permiten descargas a `registry.npmjs.org` y `storage.googleapis.com`; el resto de hosts (CDNs, polyhaven, github raw…) están bloqueados.
- Capturas de pantalla para verificar visualmente: Playwright `page.screenshot` → guarda en `.scratch/` y **mira las imágenes** (herramienta Read).

## 7. Informe final de cada agente (obligatorio, breve y verificable)

1. Qué entregaste (archivos clave, API pública).
2. Resultado real de typecheck/test/lint (pega el resumen, no lo parafrasees) y cobertura.
3. Métricas medidas (tiempos, nº de triángulos, tamaños).
4. Limitaciones conocidas y riesgos honestos. Qué NO funciona todavía.
5. Cambios solicitados a otros paquetes / contratos.
