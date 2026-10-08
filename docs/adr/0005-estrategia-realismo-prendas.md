# ADR 0005 — Realismo de prendas: geometría densa procedural + PBR + tela simulada

- Estado: aceptada

## Contexto

Requisito: las prendas deben verse reales, no animaciones de pocos polígonos. No hay assets 3D con licencia disponibles (hosts externos bloqueados) y
las prendas deben **ajustarse a cualquier cuerpo y talla**, lo que invalida modelos fijos.

## Decisión

1. **Geometría**: prendas generadas a partir del cuerpo paramétrico (offset por campo de _ease_ + recorte anatómico + remallado), 25–90 k triángulos,
   con dobladillos con grosor, costuras en relieve, cuellos/puños/capuchas con volumen, botones, pliegues estáticos, AO horneado y UV con escala física.
2. **Material**: `MeshPhysicalMaterial` con albedo/normal/ORM **procedurales y tileables** por familia de tela (denim, punto, lino, satén…), `sheen` en fibras, `clearcoat` en cuero.
3. **Dinámica**: skinning LBS en CPU + **PBD sobre malla proxy** (≤ 8 k partículas) con restricciones de distancia máxima al estado skinneado y colisión con cápsulas; los deltas se interpolan a la malla de render.
   **Arrugas dependientes de la pose**: la compresión de aristas alimenta un atributo `wrinkle` que mezcla un normal map de pliegues en el shader.
4. **Extensibilidad**: el contrato `GarmentGeometry` admite sustituir el generador procedural por activos glTF/CLO3D skinneados al esqueleto canónico sin tocar la app.

## Consecuencias

- Cualquier talla/cuerpo/tela sin assets; el ajuste (apretado/holgado) se VE.
  − No iguala a un simulador de patrones de producción (CLO3D) ni a escaneos reales; aceptable para MVP. Siguiente salto de calidad: assets artesanales por prenda estrella.
