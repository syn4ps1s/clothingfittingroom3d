READY v1: completeMeasurements, buildBody, worldColliders, measureBody

Estado (agente BODY) — versión 1, usable pero sin pulir:

- `completeMeasurements(partial)` + `validateMeasurementCoherence(m)`: completos (regresión antropométrica, respeta lo dado).
- `buildBody(m)`: malla cerrada manifold (~25 k vértices), A-pose coherente con `buildRestSkeleton(m)`, pies en y = 0, x centrado,
  pesos LBS de 4 influencias, `regions`, `colliders`, caché LRU (8). Lanza `BodyInputError` si las medidas son inválidas.
- `buildBodyAsync(m)`: cede al bucle de eventos entre fases.
- `worldColliders(body, skinMatrices, out?)`: sin asignaciones si se pasa `out`.
- `measureBody(body)`: perímetros por corte de plano, alturas y anchos para auditar el modelo.
- Limitaciones de v1: `buildBody` tarda ~0,7–1,2 s en frío (se está optimizando; la caché hace instantáneas las repeticiones),
  la forma del cuerpo (hombros, cadera, manos) se está refinando; las firmas NO cambiarán.
