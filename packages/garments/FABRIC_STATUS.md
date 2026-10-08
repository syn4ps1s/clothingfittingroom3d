# GARMENT-FABRIC — estado

**READY v1**: `generateFabricTextures` (13 familias: cotton-jersey, cotton-poplin, denim, linen, wool-knit, merino, satin,
silk-crepe, leather, corduroy, fleece, twill, tweed × 6 patrones), `generateFabricTexturesAsync`, `generateWrinkleNormalMap`
y `createClothSolver` (PBD con malla proxy; ≤ 4 ms para 50 k vértices de render).

Pulido en curso (se anunciará **READY v2** al cerrar tests/cobertura/informe).

## API (importar desde `@fitroom/garments`)

```ts
generateFabricTextures(fabric: FabricDef, variant: SwatchVariant, size: 512|1024|2048, seed?: number): FabricTextureResult
generateFabricTexturesAsync(fabric, variant, size, seed?, { sliceMs?, signal? }): Promise<FabricTextureResult>
generateWrinkleNormalMap(size: 512|1024, seed?): Uint8Array            // RGBA8 tangent-space, tileable
generateWrinkleNormalMapAsync(size, seed?, sliceMs?): Promise<Uint8Array>
createClothSolver(geometry: GarmentGeometry, options?: ClothSolverOptions): ClothSolverEx   // ClothSolverEx extends ClothSolver
```

### Texturas

- `FabricTextureResult` = `FabricTextureSet` (+ `info`: hilos reales usados, px/hilo, ajuste de patrón, intensidad de normal).
- **Orientación**: fila 0 del buffer = `v = 0` (como `THREE.DataTexture` con `flipY = false`). Normal tangent-space **OpenGL** (+Y = v creciente).
  `albedo` es sRGB → `texture.colorSpace = SRGBColorSpace`; `normal` y `orm` en `NoColorSpace`/lineal. `orm`: R = AO, G = rugosidad, B = metal (siempre 0).
  Usa `orm` como `aoMap` (canal R), `roughnessMap` (G) y `metalnessMap` (B); `wrapS = wrapT = RepeatWrapping`. Repeticiones de textura por unidad UV:
  `repeat = GarmentGeometry.uvMetersPerTile / tileMeters` (la UV de la prenda está en múltiplos de `uvMetersPerTile` metros).
- **Escala física**: `tileMeters = tileCm/100`. Hilos por tile = `threadsPerCm × tileCm`, limitado a `size/8` (≥ 8 px por hilo; ≥ 12 px por puntada en los
  punto) y redondeado al repetido del ligamento. Si hubo que bajar la frecuencia, `info.frequencyLowered = true` (el hilo se ve más grueso que en la realidad;
  el tile conserva su tamaño físico).
- **Patrones**: el periodo (mm) se ajusta al divisor entero más cercano del tile (`info.pattern.repeats/effectivePeriodMm/scale`). Rayas oblicuas: red entera
  `s = a·u + b·v` (el ángulo efectivo puede diferir; `info.pattern.effectiveAngleDeg`). Ángulo de rayas medido desde +u (0° = horizontales, 90° = verticales).
- Determinista para una `seed` (por defecto, hash de `fabric.id|variant.id`). Entradas inválidas → `FabricInputError`.
- Mapa de arrugas: mezcla por vértice con el atributo `wrinkle` del solver (p. ej. `normal = normalize(mix(n_tela, n_tela + n_arruga, wrinkle))` en el shader).

### Solver de tela

- `createClothSolver(geometry, { thicknessMm?, particleBudget?, maxIterations?, gravityScale?, warn? })`. **`thicknessMm` = `FabricDef.thicknessMm`**
  (margen de colisión = espesor + 3 mm; por defecto 1 mm). El resto del ajuste de la tela llega por `geometry.cloth` (`stiffness`, `damping`, `maxDistance`, `invMass`).
- `step(dt, skinned, capsules, out)`: `out` puede ser el mismo buffer que `skinned`. `solver.wrinkle` (0..1 por vértice de render) se rellena en cada paso.
  `solver.stats` / `particleCount` / `collisionMargin` para diagnóstico. Sin asignaciones por paso. Un `dt` ≤ 0/NaN no avanza la simulación (sigue acotando/colisionando);
  `dt` > 0,5 s reinicia el estado; `dt` se acota a 1/30 s.
- Garantías (probadas con fuzz): sin NaN/Inf en `out`/`wrinkle`; `|out − skinned| ≤ maxDistance` por vértice; si el objetivo skinneado está fuera de las
  cápsulas (inflado por el margen), la salida también lo está. Vértices con `invMass = 0` o `maxDistance = 0` salen exactamente en su posición skinneada.
- Coste: ≈ 2,5 ms/paso con 50 k vértices de render (ver informe final para cifras y condiciones).

## Pendiente antes de READY v2

Tests (vitest + fast-check), cobertura ≥ 85 %, prendas reales cuando `GEOMETRY_STATUS.md` diga READY, informe final.
