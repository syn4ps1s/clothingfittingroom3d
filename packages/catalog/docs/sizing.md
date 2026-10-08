# Recomendación de talla (`recommendSize`)

Algoritmo **determinista, explicable y puro** (sin DOM, sin azar, sin estado global). Código: `src/sizing/recommend.ts`;
perfiles por plantilla: `src/sizing/profiles.ts`.

```ts
recommendSize({ garment, measurements, preference?, sigmaCm?, fabric? }): SizeRecommendation
```

`fabric?: { stretch: number }` es una ampliación aditiva de `SizingInput`: la elasticidad de la tela relaja la holgura
mínima. Si falta se usa un valor típico de la plantilla.

## Entradas y errores

`measurements` se valida con `MeasurementsSchema` (límites de plausibilidad humana de `@fitroom/shared`); `sigmaCm` con
valores finitos en [0, 100]; `preference` ∈ `snug | regular | roomy`; la prenda debe tener tabla de tallas utilizable
(≤ 64 tallas, rangos finitos y bien ordenados). Cualquier incumplimiento lanza `SizingInputError` con `code`
(`invalid-measurements | invalid-sigma | invalid-preference | invalid-garment`) y una lista de problemas con ruta. Nunca se
«corrige» una entrada en silencio y la salida **nunca contiene NaN**.

## Pasos

### 1. Puntuación por rango (a)

Para cada talla `i` y cada dimensión `d` de `size.body` con peso `w_d` (según la plantilla, renormalizado sobre las
dimensiones disponibles), con `s_d` = escalón de la tabla (mediana de la diferencia entre centros de rango consecutivos):

```
dist_d  = max(0, lo − b, b − hi) / s_d          # distancia normalizada al rango (0 dentro)
off_d   = (b − centro) / s_d
coste_i = Σ w_d · (dist_d² + 0,05 · off_d²)     # el 2.º término desempata tallas con distancia 0
```

Pesos por plantilla (resumen): camiseta/polo/manga larga `pecho .50, hombros .17, cintura .10, cadera .08, estatura .15`;
camisa/jersey/sudadera `pecho .45, hombros .20 …, estatura .18`; abrigos `pecho .45, hombros .22 …`; pantalón/vaquero
`cintura .38, cadera .32, entrepierna .14, estatura .16`; pantalón corto `cintura .50, cadera .43`; falda
`cintura .48, cadera .40`; vestido `pecho .28, cintura .26, cadera .28, hombros .06, estatura .12`.

### 2. Holgura real y veredicto (b)

Para cada medida de la prenda con contrapartida corporal (pecho, hombros, cintura, cadera, muslo y, si es «larga», manga ↔
brazo y entrepierna ↔ entrepierna):

```
ease = medida_prenda − medida_cuerpo
x    = (ease − holgura_nominal(ajuste)) / (unidad · escala_ajuste)
```

- Holguras nominales de pecho en prendas superiores: **4 / 10 / 16 / 24 cm** para slim / regular / relaxed / oversized
  (8 / 14 / 20 / 28 en prendas exteriores, que se llevan sobre otra capa). Resto de dimensiones: ver `profiles.ts`.
  El generador de datos usa estas mismas constantes, así que tablas y clasificador no pueden contradecirse.
- `escala_ajuste` = 0,8 / 1 / 1,3 / 1,7: lo holgado tolera más desviación absoluta; lo entallado, menos.
- Veredicto por dimensión: `x < −2` **too-tight** · `x < −0,75` **snug** · `x ≤ 1` **good** · `x ≤ 2,25` **roomy** ·
  si no, **too-loose**.
- **Suelo físico**: si `ease < suelo − alivio · elasticidad` la dimensión es _too-tight_ aunque encaje con el ajuste
  nominal (no se puede vestir una prenda menor que el cuerpo). Un tejido elástico baja ese suelo.
- **Veredicto global** (`overall`): una dimensión importante (peso normalizado ≥ 0,2) _too-tight_ basta para _too-tight_;
  si no, media ponderada de los veredictos (−2…+2): ≤ −1,5 too-tight · ≤ −0,5 snug · ≤ 0,5 good · ≤ 1,5 roomy · resto too-loose.

### 3. Preferencia (c)

Antes de comparar con la tabla se desplaza el cuerpo (sólo pecho, cintura, cadera y hombros) **±0,3 escalones**
(`snug` −, `roomy` +). En el centro del rango de una talla la preferencia no cambia nada; cerca de una frontera inclina la
decisión: «o vecina sólo si la preferencia lo pide». Propiedad verificada: `snug ≤ regular ≤ roomy` en índice de talla.

### 4. Elección con veto de tallas no vestibles

Se descartan las tallas «demasiado ajustadas» (por debajo) y «demasiado holgadas» (por encima) y se elige el menor coste
dentro del intervalo restante. Si el intervalo queda vacío (cuerpo desproporcionado respecto a la tabla) se admite, al menos,
la primera talla vestible. **Ambos extremos del intervalo crecen con el cuerpo y el coste tiene diferencias decrecientes**,
de modo que la elección es **monótona** (teorema de Topkis): un cuerpo mayor nunca recibe una talla menor.

### 5. Avisos (d)

| Aviso                                        | Condición                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `between-sizes`                              | la talla cambiaría si todas las medidas variaran `±max(0,15·escalón, 0,5 cm) + 0,5·σ` (se evalúan los dos extremos de la caja; por monotonía es exacto) |
| `below-smallest-size` / `above-largest-size` | talla extrema y distancia media ponderada de los contornos al rango ≥ 0,12 escalones                                                                    |
| `height-out-of-range`                        | estatura a más de 3 cm del rango de la talla elegida                                                                                                    |
| `low-measurement-confidence`                 | σ eficaz ≥ 0,3 escalones (RMS ponderada) o alguna dimensión ≥ 0,9 escalones                                                                             |

Garantía comprobada con fast-check: _si una perturbación de ≤ 0,5 cm por medida cambia la talla, el caso original ya
incluía `between-sizes`_, y nunca se salta más de una talla.

### 6. Confianza (e)

```
confianza = 1/(1 + 1,5·R)                      # R = coste de rango de la talla elegida (sin preferencia)
          × estabilidad                        # fracción de perturbaciones ±2,5σ que dan la misma talla
          × (0,75 + 0,25 / (1 + (σ_rms/0,5)²)) # precisión de las medidas
          × veredicto (good 1 · snug/roomy 0,93 · extremos 0,55)
          × (0,6 + 0,4·cobertura)              # fracción del peso de la plantilla que la tabla cubre
          × (0,9 si la estatura no encaja)
```

`σ_k = hypot(σ_usuario, σ_base)` con σ_base = 0,5–1 cm (repetibilidad de una cinta métrica, aun sin escaneo). La
estabilidad se calcula sobre una rejilla de 21 nodos gaussianos con los desplazamientos comunes a todas las medidas.
Fuera de tabla la confianza se limita a 0,4. **Calibración medida** (Monte Carlo con σ = 1,5 cm, 8 prendas × 40 cuerpos
proporcionados × 40 repeticiones): la coincidencia empírica sube con la confianza; los casos ≥ 0,85 repiten la talla en

> 93 % de los ensayos (test `confianza calibrada…`).

### 7. Alternativas (f)

Hasta 3 tallas distintas de la elegida con coste ≤ mejor + 1,2, ordenadas por coste (empate: talla menor), cada una con su
veredicto global.

## Qué NO hace (limitaciones)

- No conoce el género ni la forma del cuerpo más allá de las medidas: la tabla se interpreta como «rango de marca».
- Las tablas del catálogo son **ficticias** (marcas ficticias) pero plausibles; con datos de marcas reales hay que
  recalibrar `profiles.ts` (holguras, pesos).
- Las holguras no consideran caída de tela (peso, rigidez) más allá de la elasticidad.
- La manga y la entrepierna sólo se evalúan si la prenda las tiene «largas» (≥ 45 cm / ≥ 55 cm).
