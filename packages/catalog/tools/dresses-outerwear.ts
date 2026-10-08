import type { GarmentFit, GarmentTemplate } from '@fitroom/shared';
import { PALETTE as P, ease, patterned, solid, t, type Center } from './lib.js';
import type { GarmentSource } from './garment-source.js';

const DRESS_BODY = ['height', 'chest', 'waist', 'hip'] as const;
const OUTER_BODY = ['height', 'chest', 'waist', 'hip', 'shoulder'] as const;

const easer =
  (template: GarmentTemplate, fit: GarmentFit) =>
  (dim: Parameters<typeof ease>[2]): number =>
    ease(template, fit, dim);

const e = {
  shirtDress: easer('dress', 'regular'),
  slip: easer('dress', 'slim'),
  knitDress: easer('dress', 'relaxed'),
  blazer: easer('blazer', 'regular'),
  leather: easer('jacket', 'slim'),
  overshirt: easer('jacket', 'relaxed'),
  coat: easer('coat', 'regular'),
};

export const DRESSES: readonly GarmentSource[] = [
  {
    id: 'dress-shirt-poplin',
    name: t('Vestido camisero de popelín', 'Poplin Shirt Dress'),
    description: t(
      'Popelín de algodón de 110 g/m² con abotonadura frontal, cuello de camisa y cinturilla con lazada. Falda con ligero vuelo, por debajo de la rodilla. Corte regular.',
      '110 gsm cotton poplin with a full button front, shirt collar and a tie waist. A gently flared skirt falling below the knee. Regular cut.',
    ),
    brand: 'Maison Verbena',
    template: 'dress',
    fit: 'regular',
    fabricId: 'poplin-cotton-110',
    table: {
      system: 'euw',
      body: DRESS_BODY,
      garment: (c: Center) => {
        const hip = c.hip + e.shirtDress('hipCm');
        return {
          chestCm: c.chest + e.shirtDress('chestCm'),
          waistCm: c.waist + e.shirtDress('waistCm'),
          hipCm: hip,
          hemCm: hip + 40,
          shoulderWidthCm: c.shoulder + 2.5,
          lengthCm: 108 + 1.8 * c.s,
          sleeveLengthCm: 24 + 0.7 * c.s,
        };
      },
    },
    params: {
      neckWidthRatio: 0.38,
      neckDropCm: 7,
      neckDropBackCm: 2.5,
      armholeDepthRatio: 0.205,
      sleeveTaper: 0.85,
      collarHeightCm: 4,
      placketLengthCm: 70,
      buttonCount: 9,
      waistLevelRatio: 0.38,
      gatherRatio: 0.15,
      slitLengthCm: 0,
    },
    variants: [
      patterned('navy-dots', t('Lunares marino sobre blanco', 'Navy dots on white'), P.optic.hex, {
        type: 'dots',
        color2: P.navy.hex,
        radiusMm: 2.5,
        spacingMm: 12,
      }),
      patterned('rose-floral', t('Floral rosa y salvia', 'Rose and sage floral'), P.ecru.hex, {
        type: 'floral',
        color2: P.rose.hex,
        color3: P.sage.hex,
        scaleMm: 60,
      }),
      solid(P.sky),
      patterned('sage-stripe', t('Rayas salvia', 'Sage stripe'), P.optic.hex, {
        type: 'stripes',
        color2: P.sage.hex,
        widthMm: 6,
        gapMm: 8,
        angleDeg: 90,
      }),
      solid(P.terracotta),
    ],
    tags: ['smart-casual', 'summer', 'office', 'weekend'],
    priceEur: 119,
  },
  {
    id: 'dress-satin-slip',
    name: t('Vestido lencero de satén', 'Satin Slip Dress'),
    description: t(
      'Satén de crepé cortado al bies para una caída líquida y brillo suave. Escote en pico, tirantes finos ajustables y abertura lateral. Largo midi, corte entallado.',
      'Bias-cut crepe-back satin for a liquid drape and soft sheen. V-neck, thin adjustable straps and a side slit. Midi length, slim cut.',
    ),
    brand: 'Maison Verbena',
    template: 'dress',
    fit: 'slim',
    fabricId: 'satin-crepe-back-130',
    table: {
      system: 'euw',
      body: DRESS_BODY,
      garment: (c: Center) => {
        const hip = c.hip + e.slip('hipCm');
        return {
          chestCm: c.chest + e.slip('chestCm'),
          waistCm: c.waist + e.slip('waistCm'),
          hipCm: hip,
          hemCm: hip + 36,
          // Ancho exterior entre tirantes (no hay hombro de costura).
          shoulderWidthCm: 0.8 * c.shoulder,
          lengthCm: 112 + 1.8 * c.s,
          sleeveLengthCm: 0,
        };
      },
    },
    params: {
      neckWidthRatio: 0.52,
      neckDropCm: 18,
      neckDropBackCm: 12,
      armholeDepthRatio: 0.24,
      strapWidthCm: 0.8,
      waistLevelRatio: 0.4,
      gatherRatio: 0,
      slitLengthCm: 28,
    },
    variants: [
      solid(P.champagne),
      solid(P.emerald),
      solid(P.burgundy),
      solid(P.midnight),
      solid(P.ink),
    ],
    tags: ['formal', 'evening', 'all-season', 'minimal'],
    priceEur: 129,
  },
  {
    id: 'dress-knit-merino',
    name: t('Vestido de punto de merino con cuello alto', 'Merino Turtleneck Knit Dress'),
    description: t(
      'Punto fino de merino con cuello alto doblado, manga larga y canalé en puños y bajo. Cálido sin peso y con algo de cuerpo. Largo por la rodilla, corte holgado ideal con botas.',
      'Fine merino knit with a folded high neck, long sleeves and ribbed cuffs and hem. Warm without weight, with a little body. Knee length, relaxed cut — made for boots.',
    ),
    brand: 'Lana Bruma',
    template: 'dress',
    fit: 'relaxed',
    fabricId: 'merino-fine-gg12',
    table: {
      system: 'alpha',
      body: DRESS_BODY,
      garment: (c: Center) => {
        const hip = c.hip + e.knitDress('hipCm');
        return {
          chestCm: c.chest + e.knitDress('chestCm'),
          waistCm: c.waist + e.knitDress('waistCm'),
          hipCm: hip,
          hemCm: hip + 4,
          shoulderWidthCm: c.shoulder + 4,
          lengthCm: 98 + 1.8 * c.s,
          sleeveLengthCm: c.arm + e.knitDress('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.34,
      neckDropCm: 0,
      neckDropBackCm: 0,
      armholeDepthRatio: 0.22,
      sleeveTaper: 0.72,
      collarHeightCm: 8,
      ribHeightCm: 6,
      waistLevelRatio: 0.4,
      gatherRatio: 0,
      slitLengthCm: 0,
    },
    variants: [
      solid(P.camel),
      solid(P.charcoal),
      solid(P.burgundy),
      solid(P.forest),
      patterned(
        'camel-ecru-stripe',
        t('Rayas camel y crudo', 'Camel and ecru stripe'),
        P.ecru.hex,
        {
          type: 'stripes',
          color2: P.camel.hex,
          widthMm: 14,
          gapMm: 14,
          angleDeg: 0,
        },
      ),
    ],
    tags: ['smart-casual', 'winter', 'office', 'minimal'],
    priceEur: 139,
  },
];

export const OUTERWEAR: readonly GarmentSource[] = [
  {
    id: 'blazer-tweed',
    name: t('Americana de tweed en espiga', 'Herringbone Tweed Blazer'),
    description: t(
      'Tweed de lana de 360 g/m² con forro completo y hombrera ligera. Solapa con ojal, dos botones, tres bolsillos y abertura trasera. Corte regular estructurado.',
      '360 gsm wool tweed with a full lining and a light shoulder pad. Notch lapel, two buttons, three pockets and a back vent. Regular, structured cut.',
    ),
    brand: 'Atelier Norte',
    template: 'blazer',
    fit: 'regular',
    fabricId: 'tweed-herringbone-360',
    table: {
      system: 'alpha',
      body: OUTER_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.blazer('chestCm');
        const hip = c.hip + 14;
        return {
          chestCm: chest,
          waistCm: chest - 8,
          hipCm: hip,
          hemCm: hip + 2,
          shoulderWidthCm: c.shoulder + e.blazer('shoulderWidthCm'),
          lengthCm: 74 + 1.8 * c.s,
          sleeveLengthCm: c.arm + e.blazer('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.36,
      armholeDepthRatio: 0.22,
      sleeveTaper: 0.72,
      lapelWidthCm: 8,
      lapelRollRatio: 0.52,
      collarHeightCm: 4.5,
      buttonCount: 2,
      buttonStanceRatio: 0.55,
      ventLengthCm: 22,
      shoulderPadCm: 1,
    },
    variants: [
      patterned(
        'brown-herringbone',
        t('Espiga marrón y crudo', 'Brown and ecru herringbone'),
        P.taupe.hex,
        {
          type: 'herringbone',
          color2: '#D9CFC0',
          sizeMm: 9,
        },
      ),
      patterned('grey-herringbone', t('Espiga gris', 'Grey herringbone'), P.smoke.hex, {
        type: 'herringbone',
        color2: '#C9CACB',
        sizeMm: 9,
      }),
      patterned(
        'navy-olive-check',
        t('Cuadro marino y oliva', 'Navy and olive check'),
        P.navy.hex,
        {
          type: 'plaid',
          color2: P.olive.hex,
          color3: '#8C2F39',
          sizeMm: 60,
        },
      ),
      solid(P.navy),
      solid(P.forest),
    ],
    tags: ['formal', 'smart-casual', 'office', 'winter', 'classic'],
    priceEur: 249,
  },
  {
    id: 'jacket-leather-biker',
    name: t('Cazadora de piel de cordero', 'Lambskin Biker Jacket'),
    description: t(
      'Piel de cordero napa curtida al vegetal, con cremallera diagonal, solapas cortas y forro de viscosa. Cuello con presilla y puños con cremallera. Corte entallado y largo corto.',
      'Vegetable-tanned napa lambskin with a diagonal zip, short lapels and a viscose lining. Snap collar and zip cuffs. Slim, cropped cut.',
    ),
    brand: 'Taller Arce',
    template: 'jacket',
    fit: 'slim',
    fabricId: 'leather-lamb-09',
    table: {
      system: 'alpha',
      body: OUTER_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.leather('chestCm');
        const waist = chest - 6;
        return {
          chestCm: chest,
          waistCm: waist,
          hipCm: c.hip + 8,
          hemCm: waist + 2,
          shoulderWidthCm: c.shoulder + e.leather('shoulderWidthCm'),
          lengthCm: 58 + 1.2 * c.s,
          sleeveLengthCm: c.arm + e.leather('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.34,
      armholeDepthRatio: 0.21,
      sleeveTaper: 0.66,
      lapelWidthCm: 6,
      lapelRollRatio: 0.4,
      collarHeightCm: 5,
      buttonCount: 1,
      buttonStanceRatio: 0.5,
      ventLengthCm: 0,
      shoulderPadCm: 0,
    },
    variants: [
      solid(P.ink),
      solid(P.cognac),
      solid(P.burgundy),
      solid(P.chocolate),
      solid(P.olive),
    ],
    tags: ['casual', 'all-season', 'evening', 'outdoor', 'classic'],
    priceEur: 349,
  },
  {
    id: 'jacket-corduroy-overshirt',
    name: t('Sobrecamisa de pana', 'Corduroy Overshirt'),
    description: t(
      'Pana de algodón de tacto mate con cinco botones, dos bolsillos de parche con solapa y costuras vistas. Ni camisa ni chaqueta: perfecta como capa intermedia. Corte holgado.',
      'Matte-finish cotton corduroy with five buttons, two flap patch pockets and topstitched seams. Neither shirt nor jacket: perfect as a mid layer. Relaxed cut.',
    ),
    brand: 'Taller Arce',
    template: 'jacket',
    fit: 'relaxed',
    fabricId: 'corduroy-14w',
    table: {
      system: 'alpha',
      body: OUTER_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.overshirt('chestCm');
        return {
          chestCm: chest,
          waistCm: chest - 2,
          hipCm: c.hip + 22,
          hemCm: chest - 2,
          shoulderWidthCm: c.shoulder + e.overshirt('shoulderWidthCm'),
          lengthCm: 74 + 1.6 * c.s,
          sleeveLengthCm: c.arm + e.overshirt('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.38,
      armholeDepthRatio: 0.23,
      sleeveTaper: 0.75,
      lapelWidthCm: 0,
      lapelRollRatio: 0.5,
      collarHeightCm: 5,
      buttonCount: 5,
      buttonStanceRatio: 0.6,
      ventLengthCm: 0,
      shoulderPadCm: 0,
    },
    variants: [solid(P.camel), solid(P.olive), solid(P.navy), solid(P.rust)],
    tags: ['casual', 'all-season', 'layering', 'outdoor', 'weekend'],
    priceEur: 119,
  },
  {
    id: 'coat-wool-long',
    name: t('Abrigo largo de paño de lana', 'Long Wool Coat'),
    description: t(
      'Paño de lana de 480 g/m² con forro de viscosa, solapa ancha y doble hilera de botones. Dos bolsillos de ojal y abertura trasera. Largo por debajo de la rodilla, corte regular.',
      '480 gsm wool coating with a viscose lining, wide lapels and a double-breasted button row. Two jetted pockets and a back vent. Below-the-knee length, regular cut.',
    ),
    brand: 'Atelier Norte',
    template: 'coat',
    fit: 'regular',
    fabricId: 'tweed-coating-480',
    table: {
      system: 'alpha',
      body: OUTER_BODY,
      garment: (c: Center) => {
        const chest = c.chest + e.coat('chestCm');
        const hip = c.hip + 16;
        return {
          chestCm: chest,
          waistCm: chest - 6,
          hipCm: hip,
          hemCm: hip + 14,
          shoulderWidthCm: c.shoulder + e.coat('shoulderWidthCm'),
          lengthCm: 104 + 2.2 * c.s,
          sleeveLengthCm: c.arm + e.coat('sleeveLengthCm'),
        };
      },
    },
    params: {
      neckWidthRatio: 0.36,
      armholeDepthRatio: 0.22,
      sleeveTaper: 0.8,
      lapelWidthCm: 9,
      lapelRollRatio: 0.5,
      collarHeightCm: 6,
      buttonCount: 6,
      buttonStanceRatio: 0.5,
      ventLengthCm: 40,
      shoulderPadCm: 1.5,
    },
    variants: [
      solid(P.camel),
      solid(P.charcoal),
      solid(P.navy),
      solid(P.ink),
      patterned('grey-herringbone', t('Espiga gris', 'Grey herringbone'), P.smoke.hex, {
        type: 'herringbone',
        color2: P.heather.hex,
        sizeMm: 10,
      }),
    ],
    tags: ['formal', 'smart-casual', 'office', 'winter', 'outdoor', 'classic'],
    priceEur: 329,
  },
];
