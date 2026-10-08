# @fitroom/catalog — estado

READY v1: loadCatalogData, createStaticCatalog, recommendSize

- `loadCatalogData(): CatalogData` — 21 telas, 22 prendas (≈108 muestras), validado con `CatalogDataSchema` + integridad; lanza `CatalogDataError` si hay datos corruptos. Resultado inmutable y memoizado.
- `createStaticCatalog(data?): StaticCatalog` — `CatalogRepository` en memoria (filtro categoría/ranura/texto insensible a mayúsculas y acentos, es/en; orden estable; resultados congelados). Extra: `.data` (datos validados, uso síncrono).
- `recommendSize(input: SizingInput & { fabric?: { stretch: number } }): SizeRecommendation` — determinista, explicable (`docs/sizing.md`). Lanza `SizingInputError` (`code`: invalid-measurements | invalid-sigma | invalid-preference | invalid-garment).
- Otros exports: `parseCatalogData(raw)` (validar JSON externo), `normalizeText`, `CatalogDataError`, `SizingInputError`.

Pendiente para READY v2: `rankGarments`, `suggestOutfits` (armonía de color y ocasión), documentación de parámetros de plantilla.
