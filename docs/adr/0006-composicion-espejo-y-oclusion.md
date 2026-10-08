# ADR 0006 — Composición del espejo y oclusión

- Estado: aceptada

## Decisión

- El espejo es una **sub-escena** con cámara virtual de igual FOV que el vídeo, renderizada a un `RenderTarget` y mostrada como textura en el plano del espejo del mundo.
  El efecto espejo es un **volteo horizontal final** de vídeo+prendas juntos (nunca se invierte la geometría → winding y normales intactos).
- Un **cuerpo oclusor invisible** (sólo profundidad), skinneado a la pose, oculta lo que queda detrás del cuerpo (interior del cuello, espalda).
- La luz de las prendas se modula con una estimación barata de luma/color del vídeo para evitar el aspecto «pegado».
- Extra: máscara de segmentación para dejar brazos/manos reales delante de la prenda (cuando crucen el torso).

## Consecuencias

- Captura de foto exacta; el post-procesado del mundo no altera el compuesto; coste previsible.
  − Un pase de render adicional (mitigado por calidad adaptativa).
