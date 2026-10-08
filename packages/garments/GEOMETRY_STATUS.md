READY v1: tee, jeans

Estado (agente GARMENT-GEO) — versión 1, usable pero sin pulir. Las firmas NO cambiarán.

- `generateGarment(def, sizeLabel, body)` → `GarmentGeometry` (caché LRU 24 por id+talla+medidas+definición; determinista).
  Devuelve además `info` (metadatos para métricas/solver: `weldIds` = vértices soldados por posición, espesor, `clothTuning`).
- Plantillas listas: `tee`, `jeans`. El resto de plantillas lanzan `GarmentGeometryError('unsupported-template')` hasta que se vayan añadiendo.
- Talla inexistente → `GarmentGeometryError('unknown-size')`.
- Escala UV: `uvMetersPerTile = 1` (1 unidad UV = 1 m de tela). Las costuras de UV duplican vértices (`weldIds` indica cuáles son el mismo punto físico: el solver de tela debe soldarlos).
- Skin 4 influencias copiadas del cuerpo y suavizadas; `ao` horneada; `cloth.maxDistance/invMass` por vértice (0 = ancla).
- Pendiente en v1: dobladillos con grosor, cuello/ribetes con volumen, costuras en relieve, pliegues, botones/bolsillos, más plantillas.
