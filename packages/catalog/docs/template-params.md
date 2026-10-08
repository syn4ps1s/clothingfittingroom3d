# Parámetros de plantilla (`GarmentDefinition.params`)

Acuerdo entre **CATALOG** (datos) y **GARMENT-GEO** (geometría). Fuente de verdad en código: `src/params.ts`
(`TEMPLATE_PARAM_SPECS`: claves, rango válido y valor por defecto; `templateParam(def, key)` devuelve el valor de la
prenda o su defecto). Un test del catálogo exige que **toda prenda defina las claves obligatorias de su plantilla, dentro de
rango, y ninguna clave desconocida**.

Convención: todo número es finito. Las magnitudes que escalan con la talla son **ratios adimensionales**; las absolutas
son pequeñas profundidades/anchos en **cm**. Las dimensiones grandes (contornos, largos, mangas…) NO están aquí: viven
en `sizes[].garment`.

## Medidas de `sizes[].garment` que el generador puede leer (cm, contornos completos)

| Clave                                           | Significado                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `chestCm`                                       | contorno de pecho de la prenda (sisa)                                                                                                       |
| `waistCm`                                       | contorno a la altura de la cintura natural                                                                                                  |
| `hipCm`                                         | contorno a la altura de la cadera                                                                                                           |
| `hemCm`                                         | contorno del bajo                                                                                                                           |
| `shoulderWidthCm`                               | ancho de hombros de costura a costura. **Camisetas de tirantes y vestido lencero:** ancho exterior entre tirantes (≈ 0,8 × hombro corporal) |
| `lengthCm`                                      | largo de espalda desde el punto alto del hombro (cuello) hasta el bajo; en falda, desde la cintura                                          |
| `sleeveLengthCm`                                | de la costura del hombro al puño; `0` = sin manga (tirantes)                                                                                |
| `thighCm`, `legOpeningCm`, `inseamCm`, `riseCm` | pantalones: muslo, abertura, entrepierna, tiro delantero                                                                                    |

## Claves por plantilla

`●` obligatoria · `○` opcional. Rango entre corchetes; entre paréntesis, valor por defecto.

### Prendas superiores

| Clave                                                                                   | Descripción                                                     | tee · long_sleeve | tank | polo · shirt | sweater | hoodie |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------- | :---------------: | :--: | :----------: | :-----: | :----: |
| `neckWidthRatio` [0,25–0,6] (0,4)                                                       | ancho de la abertura / ancho de hombros                         |         ●         |  ●   |      ●       |    ●    |   ●    |
| `neckDropCm` [0–25] (8)                                                                 | descenso del cuello delantero respecto al punto alto del hombro |         ●         |  ●   |      ●       |    ●    |   ●    |
| `neckDropBackCm` [0–15] (2,5)                                                           | descenso del cuello trasero                                     |         ●         |  ●   |      ●       |    ●    |   ●    |
| `armholeDepthRatio` [0,17–0,3] (0,21)                                                   | profundidad de sisa / `chestCm`                                 |         ●         |  ●   |      ●       |    ●    |   ●    |
| `sleeveTaper` [0,5–1,1] (0,85)                                                          | contorno de puño / contorno de bíceps (1 = tubo)                |         ●         |  –   |      ●       |    ●    |   ●    |
| `hemFoldCm` [0–4] (1,5)                                                                 | dobladillo o cinta de bajo                                      |         ●         |  ●   |      ●       |    ●    |   ●    |
| `sideVentCm` [0–15] (0)                                                                 | abertura lateral del bajo                                       |         ●         |  ●   |      ●       |    ●    |   ●    |
| `strapWidthCm` [0,5–8] (3)                                                              | ancho del tirante                                               |         –         |  ●   |      –       |    –    |   –    |
| `collarHeightCm` [3–10] (5)                                                             | altura del cuello de camisa/polo                                |         –         |  –   |      ●       |    –    |   –    |
| `placketLengthCm` [8–80] (15)                                                           | largo de la tapeta                                              |         –         |  –   |      ●       |    –    |   –    |
| `placketWidthCm` [2–5] (3)                                                              | ancho de la tapeta                                              |         –         |  –   |      ●       |    –    |   –    |
| `buttonCount` [0–10] (3)                                                                | nº de botones                                                   |         –         |  –   |      ●       |    –    |   –    |
| `ribHeightCm` [0–10]                                                                    | altura del canalé de cuello/puños/bajo                          |         –         |  –   |      –       |  ● (5)  | ● (7)  |
| `hoodHeightCm` [25–45] (36) · `hoodWidthCm` [20–35] (27) · `pocketWidthCm` [15–40] (28) | capucha y bolsillo canguro                                      |         –         |  –   |      –       |    –    |   ●    |

### Prendas inferiores

| Clave                                               | Descripción                                | jeans · chinos · shorts | skirt |
| --------------------------------------------------- | ------------------------------------------ | :---------------------: | :---: |
| `kneeRatio` [0,6–1,05] (0,85)                       | contorno de rodilla / `thighCm`            |            ●            |   –   |
| `waistbandCm` [1–8] (4 / 3,5)                       | altura de la pretina                       |            ●            |   ●   |
| `cuffFoldCm` [0–6] (0)                              | vuelta del bajo                            |            ●            |   –   |
| `flyLengthCm` [8–18] (14)                           | largo de la bragueta                       |            ●            |   –   |
| `backRiseExtraCm` [1–8] (4)                         | tiro trasero extra respecto al delantero   |            ●            |   –   |
| `pleatCount` [0–120] (0) · `pleatDepthCm` [0–6] (2) | pliegues de la falda (0 = lisa/acampanada) |            –            |   ●   |
| `slitLengthCm` [0–60] (0)                           | abertura del bajo                          |            –            |   ●   |

### Vestidos

| Clave                                                                                                              | Descripción                                                    | Obligatoria |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | :---------: |
| `neckWidthRatio`, `neckDropCm`, `neckDropBackCm`, `armholeDepthRatio`                                              | igual que en prendas superiores (`neckDropCm` 0 = cuello alto) |      ●      |
| `waistLevelRatio` [0,3–0,55] (0,4)                                                                                 | altura de la cintura sobre el largo total (cuello → bajo)      |      ●      |
| `gatherRatio` [0–0,6] (0)                                                                                          | fruncido en la costura de cintura                              |      ●      |
| `slitLengthCm` [0–60] (0)                                                                                          | abertura lateral                                               |      ●      |
| `sleeveTaper`, `collarHeightCm`, `placketLengthCm`, `placketWidthCm`, `buttonCount`, `strapWidthCm`, `ribHeightCm` | según el modelo                                                |      ○      |

### Exterior (blazer · jacket · coat)

| Clave                                                | Descripción                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `neckWidthRatio`, `armholeDepthRatio`, `sleeveTaper` | como en superiores                                                |
| `lapelWidthCm` [0–14] (8)                            | ancho de solapa (0 = sin solapa)                                  |
| `lapelRollRatio` [0,3–0,65] (0,5)                    | punto de pliegue de la solapa, fracción del largo delantero       |
| `collarHeightCm` [3–10] (5)                          | altura del cuello                                                 |
| `buttonCount` [0–10] (2)                             | botones (0 = sin botones)                                         |
| `buttonStanceRatio` [0,35–0,75] (0,55)               | posición del cierre principal, fracción del largo desde el cuello |
| `ventLengthCm` [0–60] (0)                            | abertura trasera                                                  |
| `shoulderPadCm` [0–3] (0)                            | grosor de la hombrera                                             |

## Lo que GEO consume hoy (comprobado en `packages/garments/src/geometry/`)

`neckDropCm` (cuello delantero), `waistbandCm` (pretina) y, de `sizes[].garment`, `chestCm`, `hemCm`, `waistCm`, `lengthCm`,
`shoulderWidthCm`, `sleeveLengthCm`, `hipCm`, `thighCm`, `legOpeningCm`, `riseCm`, `inseamCm`. El resto de claves son datos
**preparados** para los siguientes constructores (cuello de camisa, solapas, capucha, pliegues…); GEO puede ignorarlas
mientras tanto, y debe tratar cualquier clave ausente con el valor por defecto de la tabla.
`edgeMm` (resolución de malla) es una perilla propia de GEO: el catálogo no la define.
