# ADR 0007 — UI inmersiva dentro del mundo 3D, con capa DOM accesible

- Estado: aceptada

## Decisión

La experiencia ocurre dentro de un atelier 3D (perchero, mesa de muestras, libro de medidas, espejo). Los controles son **DOM real anclado en el espacio 3D**
(drei `Html transform`/capas alineadas) → teclado, foco, ARIA, lectores de pantalla y `prefers-reduced-motion`. Existe un camino completo **sin cámara**
(entrada manual de medidas) y un fallback sin WebGL2. Textos vía i18n tipado (es/en). Pistas del escaneo en una región `aria-live`.

## Consecuencias

- Inmersión sin sacrificar accesibilidad ni testabilidad (Playwright + axe).
  − Más trabajo de alineación que un HUD 2D plano; se acepta como diferenciador de producto.
