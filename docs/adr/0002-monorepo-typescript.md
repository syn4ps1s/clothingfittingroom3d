# ADR 0002 — Monorepo pnpm + TypeScript estricto + Vite/React/R3F

- Estado: aceptada

## Decisión

- **pnpm workspaces** (`apps/*`, `packages/*`, `infra`), paquetes internos consumidos como **fuente TS** (`exports` → `src/index.ts`), sin paso de build intermedio.
- TypeScript 5.9 `strict`, ESLint 9 (flat) + Prettier, Vitest + fast-check (propiedades), Playwright 1.56 (e2e; versión ligada al Chromium del entorno).
- UI: Vite 7, React 19, three.js + @react-three/fiber/drei (escena declarativa), zustand (estado).
- Infra: AWS CDK (TypeScript) para compartir lenguaje y tipos con el equipo.

## Consecuencias

- Cambios atómicos entre contratos y consumidores; refactors seguros por el compilador.
  − Sin build de librerías: el bundler transpila todo (aceptable a este tamaño).
