# @fitroom/catalog — estado

READY v1: loadCatalogData, createStaticCatalog, recommendSize
READY v2: rankGarments, rankGarmentsSync, suggestOutfits, suggestOutfitsSync, parseCatalogData, TEMPLATE_PARAM_SPECS, templateParam

## API pública (`import … from '@fitroom/catalog'`)

| Export                                                                         | Qué hace                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadCatalogData(): CatalogData`                                               | 21 telas, 22 prendas (≈ 108 muestras, 15 plantillas); validado con `CatalogDataSchema` + integridad; lanza `CatalogDataError` si hay datos corruptos. Inmutable y memoizado |
| `createStaticCatalog(data?): StaticCatalog`                                    | `CatalogRepository` en memoria (categoría/ranura/texto insensible a mayúsculas y acentos, es/en; orden estable; resultados congelados). Extra: `.data` para uso síncrono    |
| `recommendSize(input): SizeRecommendation`                                     | `SizingInput` + `fabric?: { stretch }` opcional. Determinista y explicable (`docs/sizing.md`). Lanza `SizingInputError`                                                     |
| `rankGarments(catalog, measurements, opts?)` / `rankGarmentsSync(data, …)`     | `RankedGarment[]` ordenado por ajuste × confianza, con talla recomendada y `reasons` (códigos para i18n)                                                                    |
| `suggestOutfits(catalog, measurements, opts?)` / `suggestOutfitsSync(data, …)` | `OutfitSuggestion[]`: top + bottom (o vestido) [+ exterior], muestras elegidas por armonía de color (OKLCH) y coherencia de ocasión (`tags`); `reasons` para i18n           |
| `parseCatalogData(raw)`                                                        | valida JSON externo (futura API) y devuelve datos inmutables                                                                                                                |
| `TEMPLATE_PARAM_SPECS`, `templateParam(def, key)`                              | acuerdo de `params` con GARMENT-GEO (`docs/template-params.md`)                                                                                                             |

## Para WORLD

- `recommendSize` ya funciona con la firma del contrato. Mejor resultado si se pasa la tela: `recommendSize({ garment, measurements, sigmaCm, fabric })` (elasticidad).
- `catalog.evaluate()` (tabla de una sola talla) funciona tal cual: devuelve las dimensiones y el veredicto de ESA talla.
- Todo texto del catálogo (nombres, descripciones, marcas, muestras) se muestra **como texto** (nunca `innerHTML`): ver `docs/catalog-data.md`.
- `RankedGarment.reasons` y `OutfitSuggestion.reasons` / `harmony.kind` son **códigos**: tradúcelos en i18n.
- Etiquetas (`tags`): vocabulario cerrado exportado en `CATALOG_TAGS` / `OCCASION_TAGS` (filtro `occasion`).

## Documentación

`docs/sizing.md` (algoritmo), `docs/template-params.md` (acuerdo con GEO), `docs/catalog-data.md` (datos, regeneración, seguridad).
