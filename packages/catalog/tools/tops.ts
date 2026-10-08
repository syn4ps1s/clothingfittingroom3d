import type { GarmentFit, GarmentTemplate } from '@fitroom/shared';
import { PALETTE as P, ease, patterned, solid, t, type Center } from './lib.js';
import type { GarmentSource } from './garment-source.js';

const TOP_BODY = ['height', 'chest', 'waist', 'hip', 'shoulder'] as const;

/** Atajo: holgura nominal del ajuste para una dimensión de la plantilla. */
const easer =
  (template: GarmentTemplate, fit: GarmentFit) =>
  (dim: Parameters<typeof ease>[2]): number =>
    ease(template, fit, dim);

const e = {
  tee: easer('tee', 'regular'),
  long: easer('long_sleeve', 'regular'),
  tank: easer('tank', 'slim'),
  polo: easer('polo', 'regular'),
  shirt: easer('shirt', 'regular'),
  linen: easer('shirt', 'relaxed'),
  chunky: easer('sweater', 'relaxed'),
  merino: easer('sweater', 'slim'),
  hoodie: easer('hoodie', 'oversized'),
};

const stripes = (color2: string, widthMm: number, gapMm: number, angleDeg: number) =>
  ({ type: 'stripes', color2, widthMm, gapMm, angleDeg }) as const;

export const TOPS: readonly GarmentSource[] = [
  {
    id: 'tee-essential',
    name: t('Camiseta Esencial de algodón peinado', 'Essential Combed-Cotton Tee'),
    description: t(
      'Jersey de algodón peinado de 160 g/m², suave y de caída limpia. Cuello redondo con cinta de refuerzo, costuras laterales y dobladillo con pespunte doble. Corte regular para llevar sola o como primera capa.',
      'Soft, clean-draping 160 gsm combed-cotton jersey. Crew neck with taped neckline, side seams and a double-stitched hem. Regular cut made to wear on its own or as a base layer.',
    ),
    brand: 'Atelier Norte',
    template: 'tee',
    fit: 'regular',
    fabricId: 'cotton-jersey-160',
    table: {
      system: 'alpha',
      body: TOP_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.tee('chestCm');
        return {
          chestCm: chest,
          waistCm: chest - 4,
          hemCm: chest - 2,
          shoulderWidthCm: c.shoulder + e.tee('shoulderWidthCm'),
          lengthCm: 69 + 1.6 * c.s,
          sleeveLengthCm: 21 + 0.8 * c.s,
        };
      },
    },
    params: {
      neckWidthRatio: 0.4,
      neckDropCm: 8,
      neckDropBackCm: 2.5,
      armholeDepthRatio: 0.205,
      sleeveTaper: 0.92,
      hemFoldCm: 1.5,
      sideVentCm: 0,
    },
    variants: [
      solid(P.optic),
      solid(P.ink),
      solid(P.heather),
      solid(P.navy),
      patterned('breton', t('Rayas marineras', 'Breton stripe'), P.ecru.hex, stripes(P.navy.hex, 10, 10, 0)),
    ],
    tags: ['casual', 'all-season', 'essential', 'weekend'],
    priceEur: 24,
  },
  {
    id: 'long-sleeve-breton',
    name: t('Camiseta marinera de manga larga', 'Long-Sleeve Breton Tee'),
    description: t(
      'Jersey de algodón de 200 g/m² con cuello barco, puños lisos y el clásico rayado marinero. Tacto firme que se suaviza con cada lavado. Corte regular, algo más largo de espalda.',
      'Boat-neck tee in 200 gsm cotton jersey with plain cuffs and the classic Breton stripe. A firm hand that softens with every wash. Regular cut, slightly longer at the back.',
    ),
    brand: 'Puerto Sur',
    template: 'long_sleeve',
    fit: 'regular',
    fabricId: 'cotton-jersey-200',
    table: {
      system: 'alpha',
      body: TOP_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.long('chestCm');
        return {
          chestCm: chest,
          waistCm: chest - 4,
          hemCm: chest - 1,
          shoulderWidthCm: c.shoulder + e.long('shoulderWidthCm'),
          lengthCm: 70 + 1.6 * c.s,
          sleeveLengthCm: c.arm + e.long('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.46,
      neckDropCm: 5,
      neckDropBackCm: 2,
      armholeDepthRatio: 0.205,
      sleeveTaper: 0.82,
      hemFoldCm: 1.5,
      sideVentCm: 0,
    },
    variants: [
      patterned('navy-breton', t('Marinera azul marino', 'Navy Breton'), P.ecru.hex, stripes(P.navy.hex, 10, 10, 0)),
      patterned(
        'burgundy-breton',
        t('Marinera burdeos', 'Burgundy Breton'),
        P.ecru.hex,
        stripes(P.burgundy.hex, 8, 12, 0),
      ),
      patterned('forest-breton', t('Marinera verde bosque', 'Forest Breton'), P.ecru.hex, stripes(P.forest.hex, 12, 12, 0)),
      solid(P.ink),
      solid(P.camel),
    ],
    tags: ['casual', 'all-season', 'classic', 'weekend'],
    priceEur: 34,
  },
  {
    id: 'tank-rib',
    name: t('Camiseta de tirantes de canalé', 'Ribbed Cotton Tank'),
    description: t(
      'Canalé de algodón 1×1 elástico que abraza sin apretar. Escote redondo amplio y sisas profundas para el verano o como capa interior. Corte entallado.',
      'Stretchy 1×1 cotton rib that hugs without squeezing. Wide scoop neck and deep armholes for summer wear or as an inner layer. Slim cut.',
    ),
    brand: 'Atelier Norte',
    template: 'tank',
    fit: 'slim',
    fabricId: 'cotton-rib-220',
    table: {
      system: 'alpha',
      body: TOP_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.tank('chestCm');
        return {
          chestCm: chest,
          waistCm: chest - 6,
          hemCm: chest - 4,
          // En una camiseta de tirantes: ancho exterior entre tirantes (no es un hombro de costura).
          shoulderWidthCm: 0.8 * c.shoulder,
          lengthCm: 64 + 1.5 * c.s,
          sleeveLengthCm: 0,
        };
      },
    },
    params: {
      neckWidthRatio: 0.5,
      neckDropCm: 11,
      neckDropBackCm: 7,
      armholeDepthRatio: 0.24,
      strapWidthCm: 3,
      hemFoldCm: 1,
      sideVentCm: 0,
    },
    variants: [solid(P.optic), solid(P.ink), solid(P.sand), solid(P.terracotta), solid(P.sage)],
    tags: ['casual', 'summer', 'essential', 'beach'],
    priceEur: 18,
  },
  {
    id: 'polo-pique',
    name: t('Polo de piqué con cuello de canalé', 'Piqué Polo with Ribbed Collar'),
    description: t(
      'Piqué de algodón de 210 g/m² con textura de panal, cuello y puños de canalé y tapeta de tres botones. Aberturas laterales y bajo algo más largo por detrás.',
      '210 gsm cotton piqué with a honeycomb texture, ribbed collar and cuffs and a three-button placket. Side vents and a slightly longer back hem.',
    ),
    brand: 'Puerto Sur',
    template: 'polo',
    fit: 'regular',
    fabricId: 'cotton-pique-210',
    trimFabricId: 'cotton-rib-220',
    table: {
      system: 'alpha',
      body: TOP_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.polo('chestCm');
        return {
          chestCm: chest,
          waistCm: chest - 3,
          hemCm: chest - 1,
          shoulderWidthCm: c.shoulder + e.polo('shoulderWidthCm'),
          lengthCm: 70 + 1.6 * c.s,
          sleeveLengthCm: 23 + 0.8 * c.s,
        };
      },
    },
    params: {
      neckWidthRatio: 0.38,
      neckDropCm: 3,
      neckDropBackCm: 2,
      armholeDepthRatio: 0.205,
      sleeveTaper: 0.88,
      hemFoldCm: 2,
      sideVentCm: 6,
      collarHeightCm: 7,
      placketLengthCm: 15,
      placketWidthCm: 3,
      buttonCount: 3,
    },
    variants: [
      solid(P.navy),
      solid(P.optic),
      solid(P.forest),
      solid(P.burgundy),
      patterned('navy-stripe', t('Rayas azul marino y blanco', 'Navy and white stripe'), P.optic.hex, stripes(P.navy.hex, 14, 14, 0)),
    ],
    tags: ['casual', 'smart-casual', 'summer', 'classic', 'weekend'],
    priceEur: 49,
  },
  {
    id: 'shirt-oxford',
    name: t('Camisa Oxford clásica', 'Classic Oxford Shirt'),
    description: t(
      'Algodón Oxford de 135 g/m² con cuello button-down, canesú y un bolsillo en el pecho. Tejido de trama visible, resistente y cómodo. Corte regular con pinza trasera.',
      '135 gsm cotton Oxford with a button-down collar, back yoke and a chest pocket. A textured, durable weave that stays comfortable. Regular cut with a back pleat.',
    ),
    brand: 'Atelier Norte',
    template: 'shirt',
    fit: 'regular',
    fabricId: 'oxford-cotton-135',
    table: {
      system: 'alpha',
      labels: ['35/36', '37/38', '39/40', '41/42', '43/44', '45/46', '47/48', '49/50'],
      body: TOP_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.shirt('chestCm');
        return {
          chestCm: chest,
          waistCm: chest - 8,
          hemCm: chest - 2,
          shoulderWidthCm: c.shoulder + e.shirt('shoulderWidthCm'),
          lengthCm: 76 + 1.8 * c.s,
          sleeveLengthCm: c.arm + e.shirt('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.38,
      neckDropCm: 3,
      neckDropBackCm: 2,
      armholeDepthRatio: 0.21,
      sleeveTaper: 0.6,
      hemFoldCm: 0.8,
      sideVentCm: 7,
      collarHeightCm: 4.5,
      placketLengthCm: 62,
      placketWidthCm: 3,
      buttonCount: 7,
    },
    variants: [
      solid(P.optic),
      solid(P.sky),
      solid(P.rose),
      patterned('blue-stripe', t('Rayas azules', 'Blue stripe'), P.optic.hex, stripes('#7C9CC0', 3, 9, 90)),
      patterned('blue-gingham', t('Cuadro vichy azul', 'Blue gingham'), P.optic.hex, {
        type: 'plaid',
        color2: P.denimMid.hex,
        sizeMm: 20,
      }),
    ],
    tags: ['smart-casual', 'office', 'all-season', 'classic'],
    priceEur: 69,
  },
  {
    id: 'shirt-linen-costa',
    name: t('Camisa de lino lavado', 'Washed Linen Shirt'),
    description: t(
      'Lino lavado a la piedra, ligero y fresco, con arrugas naturales que forman parte de su carácter. Cuello clásico, mangas enrollables y bajo recto. Corte holgado para los días de calor.',
      'Stone-washed linen that stays light and cool, with natural creasing that is part of its charm. Classic collar, roll-up sleeves and a straight hem. Relaxed cut for warm days.',
    ),
    brand: 'Costa Lino',
    template: 'shirt',
    fit: 'relaxed',
    fabricId: 'linen-washed-170',
    table: {
      system: 'alpha',
      body: TOP_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.linen('chestCm');
        return {
          chestCm: chest,
          waistCm: chest - 6,
          hemCm: chest - 2,
          shoulderWidthCm: c.shoulder + e.linen('shoulderWidthCm'),
          lengthCm: 78 + 1.8 * c.s,
          sleeveLengthCm: c.arm + e.linen('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.4,
      neckDropCm: 3.5,
      neckDropBackCm: 2,
      armholeDepthRatio: 0.22,
      sleeveTaper: 0.66,
      hemFoldCm: 1,
      sideVentCm: 8,
      collarHeightCm: 4,
      placketLengthCm: 64,
      placketWidthCm: 3,
      buttonCount: 6,
    },
    variants: [
      solid(P.sand),
      solid(P.optic),
      solid(P.sage),
      solid(P.indigo),
      patterned('fine-blue-stripe', t('Rayas finas azules', 'Fine blue stripe'), P.ecru.hex, stripes(P.denimLight.hex, 5, 14, 90)),
    ],
    tags: ['casual', 'smart-casual', 'summer', 'beach'],
    priceEur: 79,
  },
  {
    id: 'sweater-chunky-crew',
    name: t('Jersey de punto grueso con cuello redondo', 'Chunky Crew-Neck Sweater'),
    description: t(
      'Punto de lana de galga gruesa con canalé de lana en cuello, puños y bajo. Cálido, voluminoso y de hombro caído. Corte holgado pensado para superponer sobre una camisa.',
      'Chunky-gauge wool knit with wool rib at neck, cuffs and hem. Warm, voluminous and drop-shouldered. Relaxed cut made for layering over a shirt.',
    ),
    brand: 'Lana Bruma',
    template: 'sweater',
    fit: 'relaxed',
    fabricId: 'wool-knit-chunky',
    trimFabricId: 'wool-rib-300',
    table: {
      system: 'alpha',
      body: TOP_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.chunky('chestCm');
        return {
          chestCm: chest,
          waistCm: chest - 2,
          hemCm: chest - 8,
          shoulderWidthCm: c.shoulder + e.chunky('shoulderWidthCm'),
          lengthCm: 66 + 1.5 * c.s,
          sleeveLengthCm: c.arm + e.chunky('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.38,
      neckDropCm: 8,
      neckDropBackCm: 2.5,
      armholeDepthRatio: 0.23,
      sleeveTaper: 0.7,
      hemFoldCm: 0,
      sideVentCm: 0,
      ribHeightCm: 6,
    },
    variants: [
      solid(P.oatmeal),
      solid(P.charcoal),
      solid(P.forest),
      solid(P.burgundy),
      patterned('oat-navy-stripe', t('Rayas avena y marino', 'Oat and navy stripe'), P.oatmeal.hex, stripes(P.navy.hex, 25, 25, 0)),
    ],
    tags: ['casual', 'winter', 'layering', 'weekend', 'outdoor'],
    priceEur: 119,
  },
  {
    id: 'sweater-merino-crew',
    name: t('Jersey de merino de cuello redondo', 'Merino Crew-Neck Sweater'),
    description: t(
      'Merino extrafino de galga 12: ligero, transpirable y suave sobre la piel. Costuras totalmente rematadas y canalé discreto. Corte entallado que luce solo o bajo una americana.',
      'Extra-fine 12-gauge merino: light, breathable and soft on the skin. Fully fashioned seams and subtle ribbing. Slim cut that works alone or under a blazer.',
    ),
    brand: 'Atelier Norte',
    template: 'sweater',
    fit: 'slim',
    fabricId: 'merino-fine-gg12',
    table: {
      system: 'alpha',
      body: TOP_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.merino('chestCm');
        return {
          chestCm: chest,
          waistCm: chest - 4,
          hemCm: chest - 6,
          shoulderWidthCm: c.shoulder + e.merino('shoulderWidthCm'),
          lengthCm: 66 + 1.5 * c.s,
          sleeveLengthCm: c.arm + e.merino('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.36,
      neckDropCm: 7,
      neckDropBackCm: 2,
      armholeDepthRatio: 0.2,
      sleeveTaper: 0.75,
      hemFoldCm: 0,
      sideVentCm: 0,
      ribHeightCm: 5,
    },
    variants: [
      solid(P.navy),
      solid(P.camel),
      solid(P.charcoal),
      solid(P.burgundy),
      patterned('grey-navy-pinstripe', t('Rayas finas gris y marino', 'Grey and navy pinstripe'), P.heather.hex, stripes(P.navy.hex, 4, 4, 0)),
    ],
    tags: ['smart-casual', 'office', 'winter', 'minimal', 'classic'],
    priceEur: 99,
  },
  {
    id: 'hoodie-brushed',
    name: t('Sudadera con capucha de muletón', 'Brushed Fleece Hoodie'),
    description: t(
      'Muletón perchado de 320 g/m² con interior suave, capucha doble con cordón y bolsillo canguro. Hombro caído y canalé reforzado en puños y bajo. Corte oversize.',
      '320 gsm brushed fleece with a soft interior, double-layer drawcord hood and kangaroo pocket. Dropped shoulders and reinforced rib at cuffs and hem. Oversized cut.',
    ),
    brand: 'Taller Arce',
    template: 'hoodie',
    fit: 'oversized',
    fabricId: 'fleece-brushed-320',
    trimFabricId: 'cotton-rib-220',
    table: {
      system: 'alpha',
      body: TOP_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.hoodie('chestCm');
        return {
          chestCm: chest,
          waistCm: chest - 2,
          hemCm: chest - 12,
          shoulderWidthCm: c.shoulder + e.hoodie('shoulderWidthCm'),
          lengthCm: 68 + 1.6 * c.s,
          sleeveLengthCm: c.arm + e.hoodie('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.45,
      neckDropCm: 10,
      neckDropBackCm: 4,
      armholeDepthRatio: 0.26,
      sleeveTaper: 0.6,
      hemFoldCm: 0,
      sideVentCm: 0,
      ribHeightCm: 8,
      hoodHeightCm: 36,
      hoodWidthCm: 27,
      pocketWidthCm: 28,
    },
    variants: [solid(P.ash), solid(P.ink), solid(P.ecru), solid(P.rust), solid(P.olive)],
    tags: ['casual', 'winter', 'weekend', 'outdoor', 'essential'],
    priceEur: 79,
  },
];
