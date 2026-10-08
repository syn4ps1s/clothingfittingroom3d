/**
 * Utilidades del generador de datos del catálogo. Aquí viven los SISTEMAS DE TALLAS (tablas corporales de marca)
 * y los helpers que derivan las medidas de cada prenda con gradación coherente: la prenda de cada talla se
 * construye como «centro corporal de la talla + holgura nominal del ajuste» (las holguras vienen de
 * `src/sizing/profiles.ts`, la misma fuente que usa el clasificador de ajuste).
 */
import type {
  GarmentFit,
  GarmentSizeSpec,
  GarmentSpec,
  GarmentTemplate,
  LocalizedText,
  PatternSpec,
  SizeBodyRange,
  SwatchVariant,
} from '@fitroom/shared';
import { TEMPLATE_PROFILES, nominalEase, type EaseRule } from '../src/sizing/profiles.js';

export const round05 = (x: number): number => Math.round(x * 2) / 2;

// ---------- Sistemas de tallas ----------

export type SystemId = 'alpha' | 'inch' | 'euw';
type BodyKey = 'chest' | 'waist' | 'hip' | 'shoulder' | 'inseam';

export interface SizeSystem {
  readonly labels: readonly string[];
  /** centros corporales por talla (cm) */
  readonly chest?: readonly number[];
  readonly waist?: readonly number[];
  readonly hip?: readonly number[];
  readonly shoulder?: readonly number[];
  readonly thigh?: readonly number[];
  readonly inseam?: readonly number[];
  readonly arm?: readonly number[];
  /** rango de estatura por talla (se solapan: es una dimensión secundaria) */
  readonly height: readonly (readonly [number, number])[];
}

/**
 * XS–4XL (prendas unisex/«de calle»). Pecho con escalón de 6 cm; cintura y cadera crecen más despacio que el pecho
 * hacia las tallas grandes (como en las tablas reales). Cubre desde `small` (pecho 80) hasta `large` (pecho 126).
 */
const ALPHA: SizeSystem = {
  labels: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'],
  chest: [84, 90, 96, 102, 108, 114, 120, 126],
  waist: [66.5, 73, 80, 87, 94, 101, 108, 115],
  hip: [88, 92.5, 97, 101.5, 106, 110.5, 115, 120],
  shoulder: [36, 38.5, 41, 43.5, 46, 48.5, 51, 53.5],
  thigh: [49, 53, 57, 60.5, 64, 67.5, 71, 74.5],
  inseam: [70, 73, 76, 79, 82, 84, 86, 88],
  arm: [52, 55.5, 58.5, 61, 63, 64.5, 66, 67.5],
  height: [
    [148, 164],
    [160, 172],
    [168, 180],
    [175, 186],
    [181, 192],
    [186, 196],
    [190, 200],
    [194, 208],
  ],
};

/** Pantalones por cintura en pulgadas (24–46). 1 pulgada = 2,54 cm; cintura +5 cm por talla. */
const INCH: SizeSystem = {
  labels: ['24', '26', '28', '30', '32', '34', '36', '38', '40', '42', '44', '46'],
  waist: [61, 66, 71, 76, 81.5, 86.5, 91.5, 96.5, 101.5, 106.5, 112, 117],
  hip: [86, 90, 94, 98, 101.5, 105, 108.5, 112, 115, 118, 121, 124],
  thigh: [48, 50, 53, 55.5, 58, 60.5, 63, 65.5, 68, 70, 72, 74],
  inseam: [70, 72, 75, 77, 79.5, 81, 82.5, 84, 85, 86, 87, 88],
  height: [
    [148, 160],
    [152, 164],
    [156, 168],
    [160, 172],
    [164, 176],
    [168, 180],
    [172, 184],
    [176, 188],
    [180, 192],
    [184, 196],
    [188, 200],
    [192, 206],
  ],
};

/** Tallaje europeo numérico de vestidos/faldas (34–56): pecho/cadera +4 cm por talla; cintura crece más en tallas grandes. */
const EUW: SizeSystem = {
  labels: ['34', '36', '38', '40', '42', '44', '46', '48', '50', '52', '54', '56'],
  chest: [80, 84, 88, 92, 96, 100, 104, 109, 114, 119, 124, 129],
  waist: [62, 66, 70, 74, 78, 82, 87, 93, 99, 105, 111, 117],
  hip: [88, 92, 96, 100, 104, 108, 112, 116, 120, 124, 128, 132],
  shoulder: [34.5, 35.5, 36.5, 37.5, 38.5, 39.5, 41, 42.5, 44.5, 46.5, 48.5, 50.5],
  arm: [52, 53.5, 55, 56.5, 58, 59.5, 61, 62.5, 64, 65, 66, 67],
  height: [
    [150, 162],
    [154, 166],
    [158, 170],
    [162, 174],
    [166, 178],
    [170, 182],
    [174, 186],
    [178, 190],
    [182, 194],
    [186, 198],
    [190, 202],
    [194, 206],
  ],
};

export const SYSTEMS: Readonly<Record<SystemId, SizeSystem>> = {
  alpha: ALPHA,
  inch: INCH,
  euw: EUW,
};

/** Cuánto se «abre hacia fuera» el rango de la primera/última talla para cubrir cuerpos extremos. */
const OPEN_CM: Readonly<Record<BodyKey, number>> = {
  chest: 2,
  waist: 2,
  hip: 1.5,
  shoulder: 1,
  inseam: 1,
};

/** Centros corporales de UNA talla (cm) + posición relativa `s` (escalones de 6 cm de pecho respecto a M). */
export interface Center {
  readonly index: number;
  readonly chest: number;
  readonly waist: number;
  readonly hip: number;
  readonly shoulder: number;
  readonly thigh: number;
  readonly inseam: number;
  readonly arm: number;
  /** (pecho − 96) / 6 — se usa para graduar largos y mangas */
  readonly s: number;
}

export interface SizeTableSource {
  readonly system: SystemId;
  /** etiquetas propias (misma longitud que la tabla seleccionada) */
  readonly labels?: readonly string[];
  /** subconjunto contiguo de tallas del sistema [primera, última] */
  readonly range?: readonly [string, string];
  /** rangos corporales que se publican */
  readonly body: readonly (BodyKey | 'height')[];
  /** medidas de la prenda a partir de los centros corporales de la talla */
  readonly garment: (c: Center) => GarmentSpec;
}

function missing(key: string, system: string): never {
  throw new Error(`El sistema de tallas «${system}» no define «${key}»`);
}

/** Rangos contiguos alrededor de los centros: el límite entre tallas es el punto medio de sus centros. */
function contiguousRanges(centers: readonly number[], open: number): [number, number][] {
  const n = centers.length;
  const bounds: number[] = [];
  for (let i = 0; i < n - 1; i++) bounds.push(round05((centers[i]! + centers[i + 1]!) / 2));
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const lo = i === 0 ? round05(centers[0]! - (bounds[0]! - centers[0]!) - open) : bounds[i - 1]!;
    const hi =
      i === n - 1
        ? round05(centers[n - 1]! + (centers[n - 1]! - bounds[n - 2]!) + open)
        : bounds[i]!;
    out.push([lo, hi]);
  }
  if (n === 1) out[0] = [round05(centers[0]! - 3 - open), round05(centers[0]! + 3 + open)];
  return out;
}

const PLAIN_KEYS: Readonly<Record<BodyKey, keyof SizeBodyRange>> = {
  chest: 'chestCm',
  waist: 'waistCm',
  hip: 'hipCm',
  shoulder: 'shoulderWidthCm',
  inseam: 'inseamCm',
};

/** Construye la tabla de tallas (`sizes`) de una prenda. */
export function buildSizes(src: SizeTableSource): GarmentSizeSpec[] {
  const sys = SYSTEMS[src.system];
  const labelsAll = sys.labels;
  const from = src.range ? labelsAll.indexOf(src.range[0]) : 0;
  const to = src.range ? labelsAll.indexOf(src.range[1]) : labelsAll.length - 1;
  if (from < 0 || to < from) throw new Error(`Rango de tallas inválido para ${src.system}`);
  const slice = <T>(arr: readonly T[]): T[] => arr.slice(from, to + 1);
  const labels = src.labels ?? slice(labelsAll);
  if (labels.length !== to - from + 1) throw new Error('labels no coincide con el rango de tallas');

  const centersOf = (
    key: 'chest' | 'waist' | 'hip' | 'shoulder' | 'thigh' | 'inseam' | 'arm',
  ): number[] => {
    const arr = sys[key];
    if (!arr) return missing(key, src.system);
    return slice(arr);
  };
  const ranges: Partial<Record<BodyKey, [number, number][]>> = {};
  for (const key of src.body) {
    if (key === 'height') continue;
    ranges[key] = contiguousRanges(centersOf(key), OPEN_CM[key]);
  }
  const heights = slice(sys.height);

  const get = (
    key: 'chest' | 'waist' | 'hip' | 'shoulder' | 'thigh' | 'inseam' | 'arm',
  ): number[] | null => (sys[key] ? slice(sys[key]!) : null);
  const chest = get('chest');
  const waist = get('waist');
  const hip = get('hip');
  const shoulder = get('shoulder');
  const thigh = get('thigh');
  const inseam = get('inseam');
  const arm = get('arm');

  return labels.map((label, i) => {
    const center: Center = {
      index: i,
      chest: chest?.[i] ?? Number.NaN,
      waist: waist?.[i] ?? Number.NaN,
      hip: hip?.[i] ?? Number.NaN,
      shoulder: shoulder?.[i] ?? Number.NaN,
      thigh: thigh?.[i] ?? Number.NaN,
      inseam: inseam?.[i] ?? Number.NaN,
      arm: arm?.[i] ?? Number.NaN,
      s: ((chest?.[i] ?? 96) - 96) / 6,
    };
    const body: SizeBodyRange = {};
    for (const key of src.body) {
      if (key === 'height') body.heightCm = [...heights[i]!];
      else body[PLAIN_KEYS[key]] = [...ranges[key]![i]!];
    }
    const spec = src.garment(center);
    const garment: GarmentSpec = {};
    for (const [k, v] of Object.entries(spec)) {
      if (v === undefined) continue;
      if (!Number.isFinite(v)) throw new Error(`Medida no finita «${k}» en la talla ${label}`);
      (garment as Record<string, number>)[k] = round05(v);
    }
    return { label, body, garment };
  });
}

/** Holgura nominal de una dimensión para una plantilla y un ajuste (misma tabla que el clasificador). */
export function ease(
  template: GarmentTemplate,
  fit: GarmentFit,
  dimension: EaseRule['dimension'],
): number {
  const rule = TEMPLATE_PROFILES[template].ease.find((r) => r.dimension === dimension);
  if (!rule)
    throw new Error(`La plantilla ${template} no tiene regla de holgura para ${dimension}`);
  return nominalEase(rule, fit);
}

// ---------- Paleta y muestras ----------

export interface PaletteColor {
  readonly id: string;
  readonly es: string;
  readonly en: string;
  readonly hex: string;
}

const c = (id: string, es: string, en: string, hex: string): PaletteColor => ({ id, es, en, hex });

/** Paleta cerrada del catálogo: tonos apagados y armónicos (nada de saturaciones estridentes). */
export const PALETTE = {
  optic: c('optic', 'Blanco roto', 'Off white', '#F4F1EA'),
  ecru: c('ecru', 'Crudo', 'Ecru', '#EDE6D6'),
  ink: c('ink', 'Negro tinta', 'Ink black', '#1C1D21'),
  charcoal: c('charcoal', 'Gris marengo', 'Charcoal', '#3C4048'),
  smoke: c('smoke', 'Gris humo', 'Smoke grey', '#5B6068'),
  heather: c('heather', 'Gris jaspeado', 'Heather grey', '#B3B5B8'),
  ash: c('ash', 'Gris ceniza', 'Ash grey', '#A9ABAE'),
  navy: c('navy', 'Azul marino', 'Navy', '#22304A'),
  indigo: c('indigo', 'Índigo', 'Indigo', '#3B4D6B'),
  midnight: c('midnight', 'Azul medianoche', 'Midnight blue', '#171F3A'),
  inkblue: c('ink-blue', 'Azul tinta', 'Ink blue', '#34455F'),
  denimRaw: c('raw-indigo', 'Índigo crudo', 'Raw indigo', '#2B3A55'),
  denimMid: c('mid-wash', 'Lavado medio', 'Mid wash', '#4F6E93'),
  denimLight: c('light-wash', 'Lavado claro', 'Light wash', '#8FA9C4'),
  denimBlack: c('washed-black', 'Negro lavado', 'Washed black', '#26282D'),
  sky: c('sky', 'Azul cielo', 'Sky blue', '#A9C4DB'),
  sage: c('sage', 'Verde salvia', 'Sage', '#8E9F86'),
  olive: c('olive', 'Verde oliva', 'Olive', '#6A6A3F'),
  forest: c('forest', 'Verde bosque', 'Forest green', '#2F4A3B'),
  emerald: c('emerald', 'Esmeralda', 'Emerald', '#1F6B53'),
  rust: c('rust', 'Óxido', 'Rust', '#9C4A2B'),
  terracotta: c('terracotta', 'Terracota', 'Terracotta', '#B4624A'),
  burgundy: c('burgundy', 'Burdeos', 'Burgundy', '#6B2737'),
  rose: c('dusty-rose', 'Rosa empolvado', 'Dusty rose', '#D5A9A0'),
  camel: c('camel', 'Camel', 'Camel', '#B38A5B'),
  sand: c('sand', 'Arena', 'Sand', '#D6C4A3'),
  stone: c('stone', 'Piedra', 'Stone', '#BDB5A6'),
  oatmeal: c('oatmeal', 'Avena', 'Oatmeal', '#D9CDB8'),
  chocolate: c('chocolate', 'Chocolate', 'Chocolate', '#4A3428'),
  cognac: c('cognac', 'Coñac', 'Cognac', '#8B4F2A'),
  champagne: c('champagne', 'Champán', 'Champagne', '#E3CDB0'),
  taupe: c('taupe', 'Topo', 'Taupe', '#6B5B4B'),
} as const satisfies Record<string, PaletteColor>;

export const solid = (p: PaletteColor): SwatchVariant => ({
  id: p.id,
  name: { es: p.es, en: p.en },
  color: p.hex,
  pattern: { type: 'solid' },
});

export const patterned = (
  id: string,
  name: LocalizedText,
  color: string,
  pattern: PatternSpec,
): SwatchVariant => ({ id, name, color, pattern });

/** Texto localizado (azúcar para legibilidad de los datos fuente). */
export const t = (es: string, en: string): LocalizedText => ({ es, en });
