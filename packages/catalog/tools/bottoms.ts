import type { GarmentFit, GarmentTemplate } from '@fitroom/shared';
import { PALETTE as P, ease, patterned, solid, t, type Center } from './lib.js';
import type { GarmentSource } from './garment-source.js';

const PANTS_BODY = ['height', 'waist', 'hip', 'inseam'] as const;
const WAIST_HIP_BODY = ['height', 'waist', 'hip'] as const;

const easer =
  (template: GarmentTemplate, fit: GarmentFit) =>
  (dim: Parameters<typeof ease>[2]): number =>
    ease(template, fit, dim);

const e = {
  jeans: easer('jeans', 'regular'),
  slim: easer('jeans', 'slim'),
  chino: easer('chinos', 'slim'),
  cord: easer('chinos', 'relaxed'),
  shorts: easer('shorts', 'regular'),
  skirt: easer('skirt', 'regular'),
};

/** Tiro medio que sube suavemente con el contorno de cintura. */
const rise = (base: number, waist: number): number => base + 0.1 * (waist - 81.5);

export const BOTTOMS: readonly GarmentSource[] = [
  {
    id: 'jeans-straight-raw',
    name: t('Vaqueros rectos de denim crudo', 'Straight Raw-Denim Jeans'),
    description: t(
      'Denim de 12 oz en ligamento de sarga con cinco bolsillos y botonadura metálica. Tiro medio y pierna recta de caída limpia; se adapta al cuerpo con el uso.',
      '12 oz twill-weave denim with five pockets and metal buttons. Mid rise and a straight leg with a clean drop that moulds to you over time.',
    ),
    brand: 'Rumbo Denim Co.',
    template: 'jeans',
    fit: 'regular',
    fabricId: 'denim-12oz',
    table: {
      system: 'inch',
      body: PANTS_BODY,
      garment: (c: Center) => ({
        waistCm: c.waist + e.jeans('waistCm'),
        hipCm: c.hip + e.jeans('hipCm'),
        thighCm: c.thigh + e.jeans('thighCm'),
        legOpeningCm: 40 + 0.35 * (c.index - 4),
        inseamCm: c.inseam + e.jeans('inseamCm'),
        riseCm: rise(26, c.waist),
      }),
    },
    params: {
      kneeRatio: 0.86,
      waistbandHeightCm: 4,
      cuffFoldCm: 0,
      flyLengthCm: 14,
      backRiseExtraCm: 4.5,
    },
    variants: [
      solid(P.denimRaw),
      solid(P.denimMid),
      solid(P.denimLight),
      solid(P.denimBlack),
      solid(P.ecru),
    ],
    tags: ['casual', 'all-season', 'essential', 'weekend', 'classic'],
    priceEur: 89,
  },
  {
    id: 'jeans-slim-stretch',
    name: t('Vaqueros slim de denim elástico', 'Slim Stretch Jeans'),
    description: t(
      'Denim de 9 oz con un 2 % de elastano para moverte con comodidad. Tiro medio-bajo, pierna entallada y bajo estrecho. Mantiene la forma sin abolsarse.',
      '9 oz denim with 2% elastane for easy movement. Mid-low rise, slim leg and a narrow hem. Keeps its shape without bagging out.',
    ),
    brand: 'Rumbo Denim Co.',
    template: 'jeans',
    fit: 'slim',
    fabricId: 'denim-stretch-9oz',
    table: {
      system: 'inch',
      body: PANTS_BODY,
      garment: (c: Center) => ({
        waistCm: c.waist + e.slim('waistCm'),
        hipCm: c.hip + e.slim('hipCm'),
        thighCm: c.thigh + e.slim('thighCm'),
        legOpeningCm: 31 + 0.35 * (c.index - 4),
        inseamCm: c.inseam + e.slim('inseamCm'),
        riseCm: rise(23.5, c.waist),
      }),
    },
    params: {
      kneeRatio: 0.74,
      waistbandHeightCm: 3.5,
      cuffFoldCm: 0,
      flyLengthCm: 13,
      backRiseExtraCm: 4,
    },
    variants: [solid(P.denimBlack), solid(P.smoke), solid(P.denimMid), solid(P.inkblue)],
    tags: ['casual', 'smart-casual', 'all-season', 'essential', 'evening'],
    priceEur: 99,
  },
  {
    id: 'chino-slim-twill',
    name: t('Chinos slim de sarga de algodón', 'Slim Cotton-Twill Chinos'),
    description: t(
      'Sarga de algodón de 240 g/m² teñida en prenda para un color profundo. Tiro medio, pierna entallada y bajo al tobillo. Bolsillos de ojal en la espalda y cintura con pasadores.',
      '240 gsm garment-dyed cotton twill for a deep colour. Mid rise, slim leg and an ankle-length hem. Jetted back pockets and a belt-loop waistband.',
    ),
    brand: 'Atelier Norte',
    template: 'chinos',
    fit: 'slim',
    fabricId: 'twill-chino-240',
    table: {
      system: 'inch',
      body: PANTS_BODY,
      garment: (c: Center) => ({
        waistCm: c.waist + e.chino('waistCm'),
        hipCm: c.hip + e.chino('hipCm'),
        thighCm: c.thigh + e.chino('thighCm'),
        legOpeningCm: 33 + 0.4 * (c.index - 4),
        inseamCm: c.inseam + e.chino('inseamCm'),
        riseCm: rise(25.5, c.waist),
      }),
    },
    params: {
      kneeRatio: 0.8,
      waistbandHeightCm: 4,
      cuffFoldCm: 0,
      flyLengthCm: 13.5,
      backRiseExtraCm: 4,
    },
    variants: [
      solid(P.sand),
      solid(P.navy),
      solid(P.olive),
      solid(P.stone),
      patterned('taupe-herringbone', t('Espiga topo', 'Taupe herringbone'), P.taupe.hex, {
        type: 'herringbone',
        color2: '#CFC4B1',
        sizeMm: 6,
      }),
    ],
    tags: ['smart-casual', 'office', 'all-season', 'classic'],
    priceEur: 79,
  },
  {
    id: 'trouser-corduroy',
    name: t('Pantalón de pana de 14 canalés', '14-Wale Corduroy Trousers'),
    description: t(
      'Pana de algodón de canalé fino con pelo denso y tacto suave. Tiro alto, pierna holgada con vuelta en el bajo y pinzas delanteras. Pensado para otoño e invierno.',
      'Fine-wale cotton corduroy with a dense, soft pile. High rise, relaxed leg with a turn-up hem and front pleats. Made for autumn and winter.',
    ),
    brand: 'Taller Arce',
    template: 'chinos',
    fit: 'relaxed',
    fabricId: 'corduroy-14w',
    table: {
      system: 'alpha',
      body: PANTS_BODY,
      garment: (c: Center) => ({
        waistCm: c.waist + e.cord('waistCm'),
        hipCm: c.hip + e.cord('hipCm'),
        thighCm: c.thigh + e.cord('thighCm'),
        legOpeningCm: 46 + 0.8 * c.s,
        inseamCm: c.inseam + e.cord('inseamCm'),
        riseCm: rise(28, c.waist),
      }),
    },
    params: {
      kneeRatio: 0.93,
      waistbandHeightCm: 4,
      cuffFoldCm: 3.5,
      flyLengthCm: 15,
      backRiseExtraCm: 5,
    },
    variants: [solid(P.camel), solid(P.rust), solid(P.forest), solid(P.chocolate), solid(P.navy)],
    tags: ['smart-casual', 'winter', 'weekend', 'classic'],
    priceEur: 85,
  },
  {
    id: 'shorts-linen',
    name: t('Bermudas de lino', 'Linen Shorts'),
    description: t(
      'Lino de gramaje medio con cintura elástica interior y cordón. Dos bolsillos laterales y uno trasero, largo sobre la rodilla. Corte regular, fresco y ligero.',
      'Mid-weight linen with an inner elastic waist and drawcord. Two side pockets and one back pocket, cut just above the knee. A regular, light and breathable fit.',
    ),
    brand: 'Costa Lino',
    template: 'shorts',
    fit: 'regular',
    fabricId: 'linen-heavy-230',
    table: {
      system: 'alpha',
      body: WAIST_HIP_BODY,
      garment: (c: Center) => ({
        waistCm: c.waist + e.shorts('waistCm'),
        hipCm: c.hip + e.shorts('hipCm'),
        thighCm: c.thigh + e.shorts('thighCm'),
        legOpeningCm: 58 + 1.5 * c.s,
        inseamCm: 24 + 0.5 * c.s,
        riseCm: rise(26, c.waist),
      }),
    },
    params: {
      kneeRatio: 1,
      waistbandHeightCm: 4,
      cuffFoldCm: 2.5,
      flyLengthCm: 14,
      backRiseExtraCm: 4,
    },
    variants: [
      solid(P.sand),
      solid(P.optic),
      solid(P.sky),
      solid(P.olive),
      patterned('navy-stripe', t('Rayas marineras', 'Navy stripe'), P.ecru.hex, {
        type: 'stripes',
        color2: P.navy.hex,
        widthMm: 6,
        gapMm: 10,
        angleDeg: 90,
      }),
    ],
    tags: ['casual', 'summer', 'beach', 'weekend'],
    priceEur: 59,
  },
  {
    id: 'skirt-midi-pleated',
    name: t('Falda midi plisada de crepé de seda', 'Pleated Silk-Crepe Midi Skirt'),
    description: t(
      'Crepé de seda de 90 g/m² con plisado de cuchillo y cintura elástica cubierta. Vuelo fluido y movimiento ligero, largo midi. Combina con un jersey fino o una camisa.',
      '90 gsm silk crepe with knife pleats and a covered elastic waist. A fluid sweep with light movement, midi length. Pairs with a fine knit or a shirt.',
    ),
    brand: 'Maison Verbena',
    template: 'skirt',
    fit: 'regular',
    fabricId: 'silk-crepe-90',
    table: {
      system: 'euw',
      body: WAIST_HIP_BODY,
      garment: (c: Center) => {
        const hip = c.hip + e.skirt('hipCm');
        return {
          waistCm: c.waist + e.skirt('waistCm'),
          hipCm: hip,
          hemCm: hip + 78 + 2 * c.s,
          lengthCm: 72 + 1.2 * c.s,
        };
      },
    },
    params: {
      waistbandHeightCm: 3.5,
      pleatCount: 48,
      pleatDepthCm: 2,
      slitLengthCm: 0,
    },
    variants: [
      solid(P.ink),
      solid(P.champagne),
      solid(P.sage),
      patterned('navy-dots', t('Lunares sobre marino', 'Dots on navy'), P.navy.hex, {
        type: 'dots',
        color2: P.optic.hex,
        radiusMm: 2,
        spacingMm: 10,
      }),
      patterned('ecru-floral', t('Flores sobre crudo', 'Floral on ecru'), P.ecru.hex, {
        type: 'floral',
        color2: P.terracotta.hex,
        color3: '#6A7F5A',
        scaleMm: 55,
      }),
    ],
    tags: ['smart-casual', 'evening', 'office', 'all-season', 'minimal'],
    priceEur: 99,
  },
];
