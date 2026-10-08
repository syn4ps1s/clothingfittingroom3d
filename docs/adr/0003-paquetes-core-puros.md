# ADR 0003 — Paquetes core puros (sin DOM, three ni React) y contratos en `shared`

- Estado: aceptada

## Contexto

Cuerpo, prendas, tallaje y matemática son lógica numérica pesada. Si dependen de three/DOM, no son testeables en Node ni portables a Web Workers.

## Decisión

`shared`, `body`, `garments`, `catalog` son **puros** (lo impone ESLint con `no-restricted-imports`). Intercambian **arrays tipados**
(`MeshData`, `SkinnedMeshData`) y tipos de `shared`. La capa web (`apps/web`) los convierte a `BufferGeometry` y aplica materiales.
`pose` tiene un adaptador de navegador (MediaPipe) pero su lógica (filtros, retargeting, escaneo) es pura.
Convenciones únicas (ejes, unidades, esqueleto de 21 joints, A-pose) en `shared`; cualquier cambio de contrato es explícito y revisado.

## Consecuencias

- Pruebas de propiedades y fuzz masivos en Node (rápidos, deterministas), trabajo en paralelo de varios equipos/agentes sin pisarse.
- Posibilidad de mover generación a Workers sin reescribir.
  − Una conversión por malla en la frontera con three (barata: comparte buffers).
