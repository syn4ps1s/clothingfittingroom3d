# Datos del catálogo, generación y seguridad

## Contenido

`src/data/*.json` (≈ 135 KB en total, límite de la suite: 250 KB): `fabrics.json` (21 telas, las 13 familias de
`FABRIC_FAMILIES`), `tops.json` (9), `bottoms.json` (6), `dresses.json` (3), `outerwear.json` (4) = 22 prendas, 4–5 muestras
cada una (solid, stripes, plaid, dots, herringbone, floral). Marcas **ficticias** (Atelier Norte, Costa Lino, Maison Verbena,
Rumbo Denim Co., Taller Arce, Lana Bruma, Puerto Sur). Textos `es`/`en` redactados a mano.

Sistemas de tallas (tablas corporales de marca, `size.body`) y gradación:

| Sistema | Tallas                        | Usado en                                                             | Gradación                                              |
| ------- | ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| `alpha` | XS…4XL (camisas: 35/36…49/50) | superiores, exteriores, bermudas, pantalón de pana, vestido de punto | pecho +6, cadera +4,5, cintura +6,5…7, hombros +2,5 cm |
| `inch`  | 24…46                         | vaqueros y chinos                                                    | cintura +5 cm (= 2 pulgadas), cadera +3…4 cm           |
| `euw`   | 34…56                         | faldas y vestidos                                                    | pecho/cadera +4…5, cintura +4…6 cm                     |

Cada talla de **prenda** se construye como «centro corporal de la talla + holgura nominal del ajuste»
(4/10/16/24 cm de pecho en superiores, 8/14/20/28 en exteriores; ver `docs/sizing.md`), más largos y mangas que crecen con la
estatura. Los rangos corporales son contiguos (el límite entre tallas es el punto medio de los centros); la primera y la
última talla se abren 1–2 cm hacia fuera para cubrir cuerpos extremos. Cubren los 4 cuerpos de `REFERENCE_MEASUREMENTS`
(pecho 80 → 126 cm).

## Regenerar

Los JSON son artefactos **generados y versionados**. Se editan las definiciones fuente (`tools/*.ts`: telas, paleta, tablas,
textos, muestras) y se regeneran:

```bash
pnpm --filter @fitroom/catalog build:data      # escribe src/data/*.json (con prettier) tras validar con el esquema estricto
pnpm --filter @fitroom/catalog test            # data-sync.test.ts falla si un JSON no coincide con el generador
```

## Validación en la carga

`loadCatalogData()` y `createStaticCatalog(data?)` pasan SIEMPRE por `parseCatalogData`:

1. **Pre-escaneo** del JSON crudo (iterativo, acotado): claves `__proto__`/`constructor`/`prototype`, getters/setters, tipos
   no serializables, profundidad ≤ 12, ≤ 250 000 nodos, ≤ 500 telas y ≤ 2 000 prendas.
2. **`CatalogDataSchema`** (zod, `strictObject`: campos extra → error; ids kebab-case sin `/`, `.` ni mayúsculas; colores
   `#rrggbb`; longitudes máximas).
3. **Reglas de integridad** (`CatalogDataStrictSchema`): ids únicos, telas existentes, plantilla ↔ categoría ↔ ranura
   coherentes, etiquetas kebab-case, claves de parámetros alfanuméricas, **texto plano** (sin `<`, `>`, controles, marcas
   bidi, espacios de ancho cero), tallas con etiqueta válida y única, rangos corporales bien formados y **monótonos**, medidas de
   prenda crecientes.

Ante cualquier fallo se lanza `CatalogDataError` (`code: 'CATALOG_INVALID'`, `issues[]` con ruta y mensaje): mensaje
legible, ≤ ~2 KB, sin saltos de línea ni eco ilimitado de datos hostiles. El resultado válido es **profundamente
inmutable** (`Object.freeze` recursivo) y los repositorios devuelven listas congeladas.

## Seguridad: la UI debe renderizar TODO como texto

El catálogo es dato externo potencial (hoy empaquetado, mañana una API). Aunque la validación rechaza `<`/`>` y caracteres de
control, **la defensa principal es que la interfaz nunca interprete estos campos como HTML**:

- Mostrar `name`, `description`, `brand`, nombres de muestra y de tela con `textContent` / nodos de texto de React
  (`{texto}`), **jamás** `innerHTML` / `dangerouslySetInnerHTML` / `eval` / construcción de URLs a partir de ellos.
- No usar ids ni etiquetas como selectores, rutas de fichero o claves de objeto sin comprobar (`Map` en vez de `{}`).
- Los colores son `#rrggbb` validados: pueden usarse en `style`/materiales; cualquier otra cadena es dato, no código.
- Compatible con CSP estricta: el paquete no genera scripts, no usa `eval`/`new Function` y no hace peticiones.

Un texto como `javascript:alert(1)` (sin HTML) es válido como texto: es inofensivo mostrado como texto y dañino sólo si la UI
lo enlazara como URL, de ahí la regla anterior.
