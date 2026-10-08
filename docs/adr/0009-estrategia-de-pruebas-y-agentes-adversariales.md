# ADR 0009 — Estrategia de pruebas y agentes adversariales

- Estado: aceptada

## Decisión

Pirámide: unit + **propiedades (fast-check)** en core → integración (pipeline pose→esqueleto→prenda) → e2e Playwright (cámara falsa y pose sintética) → a11y (axe) → capturas revisadas.
Además, rondas con **agentes adversariales independientes** (no vieron el diseño; su objetivo es romperlo): seguridad/privacidad, fuzz/caos numérico, crítica de realismo visual,
accesibilidad/UX y rendimiento. Cada hallazgo se prioriza (S1–S4), se reproduce con un test que **falla**, se corrige y el test queda como regresión.
Criterio de salida del MVP: 0 hallazgos S1/S2 abiertos; S3 con decisión explícita. Ver `docs/testing-strategy.md`.
