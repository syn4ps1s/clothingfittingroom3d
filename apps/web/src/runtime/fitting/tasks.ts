import { buildBody, completeMeasurements } from '@fitroom/body';
import { generateFabricTextures, generateGarment } from '@fitroom/garments';
import type {
  BodyModel,
  FabricDef,
  FabricTextureSet,
  GarmentDefinition,
  GarmentGeometry,
  Measurements,
  SwatchVariant,
} from '@fitroom/shared';

/** Trabajos de generación que se pueden ejecutar en un Web Worker (todo es estructuralmente clonable). */
export type TaskSpec =
  | { readonly kind: 'body'; readonly measurements: Measurements }
  | {
      readonly kind: 'garment';
      readonly def: GarmentDefinition;
      readonly sizeLabel: string;
      readonly measurements: Measurements;
    }
  | {
      readonly kind: 'textures';
      readonly fabric: FabricDef;
      readonly variant: SwatchVariant;
      readonly size: 512 | 1024 | 2048;
      readonly seed: number;
    };

export type TaskValue = BodyModel | GarmentGeometry | FabricTextureSet;

export interface TaskOutput<T = TaskValue> {
  readonly value: T;
  /** Tiempo de generación (ms) medido dentro del ejecutor (hilo donde corrió). */
  readonly ms: number;
}

/** Caché de cuerpos del ejecutor (las prendas necesitan el cuerpo; evita recibirlo/enviarlo cada vez). */
export class BodyStore {
  private readonly map = new Map<string, BodyModel>();
  constructor(private readonly capacity = 4) {}

  get(m: Measurements): BodyModel {
    const key = bodyKeyOf(m);
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const body = buildBody(completeMeasurements(m));
    this.map.set(key, body);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return body;
  }
}

/** Ejecuta un trabajo de forma síncrona en el hilo actual. Compartido por el worker y el ejecutor inline. */
export function runTask(spec: TaskSpec, bodies: BodyStore): TaskOutput {
  const t0 = performance.now();
  let value: TaskValue;
  switch (spec.kind) {
    case 'body':
      value = bodies.get(spec.measurements);
      break;
    case 'garment': {
      const body = bodies.get(spec.measurements);
      value = generateGarment(spec.def, spec.sizeLabel, body);
      break;
    }
    case 'textures':
      value = generateFabricTextures(spec.fabric, spec.variant, spec.size, spec.seed);
      break;
  }
  return { value, ms: performance.now() - t0 };
}

// ---------------------------------------------------------------- claves de caché

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Clave estable de unas medidas completas (mismos números → misma clave). */
export function bodyKeyOf(m: Measurements): string {
  return [
    m.heightCm,
    m.weightKg,
    m.chestCm,
    m.waistCm,
    m.hipCm,
    m.shoulderWidthCm,
    m.armLengthCm,
    m.inseamCm,
    m.neckCm,
    m.thighCm,
  ]
    .map(r3)
    .join(',')
    .concat('|', m.bodyBase);
}

/** Hash FNV-1a de 32 bits de un texto (para claves de contenido; no criptográfico). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Sólo lo que afecta a la GEOMETRÍA de la prenda (no el color/estampado de la muestra). */
export function garmentGeometryKey(
  def: GarmentDefinition,
  sizeLabel: string,
  bodyKey: string,
): string {
  const size = def.sizes.find((s) => s.label === sizeLabel);
  const content = JSON.stringify([
    def.template,
    def.slot,
    def.fit,
    def.params ?? null,
    size?.garment ?? null,
  ]);
  return `garment|${def.id}|${sizeLabel}|${hashString(content)}|${bodyKey}`;
}

export function textureKey(
  fabric: FabricDef,
  variant: SwatchVariant,
  size: number,
  seed: number,
): string {
  return `tex|${fabric.id}|${variant.id}|${hashString(JSON.stringify([fabric, variant]))}|${size}|${seed}`;
}

/** Semilla estable por (tela, muestra): la misma muestra se ve igual siempre. */
export function textureSeed(fabric: FabricDef, variant: SwatchVariant): number {
  return parseInt(hashString(`${fabric.id}/${variant.id}`), 16) >>> 0;
}

// ---------------------------------------------------------------- tamaño y transferibles

/** Bytes aproximados de un valor (suma de los buffers tipados alcanzables). */
export function approxBytes(value: unknown, seen = new Set<object>(), depth = 0): number {
  if (value === null || typeof value !== 'object' || depth > 6) return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) {
    // los arrays de números pequeños (tuplas) cuentan poco; muestreamos el primer elemento si es objeto
    let n = 0;
    for (const v of value) n += approxBytes(v, seen, depth + 1);
    return n;
  }
  let n = 0;
  for (const v of Object.values(value as Record<string, unknown>)) {
    n += approxBytes(v, seen, depth + 1);
  }
  return n;
}

/** Buffers transferibles (sin duplicados) de todos los arrays tipados alcanzables en `value`. */
export function collectTransferables(value: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== 'object' || depth > 6 || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(value, 0);
  return [...out];
}
