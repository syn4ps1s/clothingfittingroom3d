import {
  CatalogDataSchema,
  type CatalogData,
  type GarmentCategory,
  type GarmentDefinition,
  type GarmentDimension,
  type GarmentSlot,
  type GarmentTemplate,
  type SizeBodyRange,
} from '@fitroom/shared';
import { CatalogDataError, formatPath, type CatalogIssue } from './errors.js';
import { deepFreeze, isInvisibleCodePoint } from './util.js';

/** Categoría a la que pertenece cada plantilla (el generador de geometría se apoya en esta relación). */
export const TEMPLATE_CATEGORY: Readonly<Record<GarmentTemplate, GarmentCategory>> = {
  tee: 'tops',
  long_sleeve: 'tops',
  tank: 'tops',
  polo: 'tops',
  shirt: 'tops',
  sweater: 'tops',
  hoodie: 'tops',
  jeans: 'bottoms',
  chinos: 'bottoms',
  shorts: 'bottoms',
  skirt: 'bottoms',
  dress: 'dresses',
  blazer: 'outerwear',
  jacket: 'outerwear',
  coat: 'outerwear',
};

/** Ranura que ocupa cada categoría. */
export const CATEGORY_SLOT: Readonly<Record<GarmentCategory, GarmentSlot>> = {
  tops: 'upper',
  bottoms: 'lower',
  dresses: 'full',
  outerwear: 'outer',
};

/** Límites de trabajo acotado: un JSON hostil no puede hacer que la validación consuma memoria/CPU sin tope. */
export const CATALOG_LIMITS = {
  maxNodes: 250_000,
  maxDepth: 12,
  maxFabrics: 500,
  maxGarments: 2_000,
} as const;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Pre-escaneo del JSON crudo ANTES de zod: claves peligrosas (`__proto__`…), propiedades con getters,
 * tipos no serializables, profundidad y nº de nodos acotados, tamaños de colecciones razonables.
 * Es iterativo (sin recursión) para que una estructura profunda no desborde la pila.
 */
export function scanRawCatalog(raw: unknown): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const push = (path: readonly PropertyKey[], message: string) => {
    if (issues.length < 50) issues.push({ path: formatPath(path), message });
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    push([], 'el catálogo debe ser un objeto JSON');
    return issues;
  }
  const stack: { value: unknown; path: PropertyKey[]; depth: number }[] = [
    { value: raw, path: [], depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, path, depth } = stack.pop()!;
    if (++nodes > CATALOG_LIMITS.maxNodes) {
      push([], `demasiados nodos (> ${CATALOG_LIMITS.maxNodes})`);
      break;
    }
    const t = typeof value;
    if (t === 'function' || t === 'symbol' || t === 'bigint') {
      push(path, `tipo no permitido en JSON (${t})`);
      continue;
    }
    if (value === null || t !== 'object') continue;
    if (depth > CATALOG_LIMITS.maxDepth) {
      push(path, `anidación excesiva (> ${CATALOG_LIMITS.maxDepth})`);
      continue;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (!Array.isArray(value)) {
      for (const k of keys) {
        if (FORBIDDEN_KEYS.has(k)) push([...path, k], `clave prohibida «${k}»`);
      }
    }
    for (const k of keys) {
      const desc = Object.getOwnPropertyDescriptor(obj, k);
      if (desc && (desc.get || desc.set)) {
        push([...path, k], 'propiedades con getter/setter no permitidas');
        continue;
      }
      stack.push({ value: desc?.value, path: [...path, Array.isArray(value) ? Number(k) : k], depth: depth + 1 });
    }
  }
  const top = raw as Record<string, unknown>;
  if (Array.isArray(top.fabrics) && top.fabrics.length > CATALOG_LIMITS.maxFabrics) {
    push(['fabrics'], `demasiadas telas (> ${CATALOG_LIMITS.maxFabrics})`);
  }
  if (Array.isArray(top.garments) && top.garments.length > CATALOG_LIMITS.maxGarments) {
    push(['garments'], `demasiadas prendas (> ${CATALOG_LIMITS.maxGarments})`);
  }
  return issues;
}

// ---------- Saneamiento de texto (anti-inyección al renderizar) ----------

/** Texto plano: se rechazan `<` y `>` (HTML) y todo code point invisible o de control (ver `isInvisibleCodePoint`). */
export function hasUnsafeText(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x3c || cp === 0x3e || isInvisibleCodePoint(cp)) return true;
  }
  return false;
}

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const PARAM_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
const SIZE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9/.+-]{0,7}$/;

const BODY_KEYS: readonly (keyof SizeBodyRange)[] = [
  'heightCm',
  'chestCm',
  'waistCm',
  'hipCm',
  'shoulderWidthCm',
  'inseamCm',
];
const GARMENT_DIMS: readonly GarmentDimension[] = [
  'chestCm',
  'waistCm',
  'hemCm',
  'hipCm',
  'thighCm',
  'legOpeningCm',
  'shoulderWidthCm',
  'lengthCm',
  'sleeveLengthCm',
  'inseamCm',
  'riseCm',
];

type Add = (path: readonly PropertyKey[], message: string) => void;

function checkText(value: string, path: readonly PropertyKey[], add: Add): void {
  if (hasUnsafeText(value)) {
    add(path, 'contiene caracteres no permitidos (HTML, control, bidi o ancho cero); el texto debe ser plano');
  }
}

function checkGarment(g: GarmentDefinition, gi: number, fabricIds: ReadonlySet<string>, add: Add): void {
  const p = (...rest: PropertyKey[]): PropertyKey[] => ['garments', gi, ...rest];
  checkText(g.name.es, p('name', 'es'), add);
  checkText(g.name.en, p('name', 'en'), add);
  checkText(g.description.es, p('description', 'es'), add);
  checkText(g.description.en, p('description', 'en'), add);
  checkText(g.brand, p('brand'), add);

  if (TEMPLATE_CATEGORY[g.template] !== g.category) {
    add(p('category'), `la plantilla «${g.template}» pertenece a «${TEMPLATE_CATEGORY[g.template]}», no a «${g.category}»`);
  }
  if (CATEGORY_SLOT[g.category] !== g.slot) {
    add(p('slot'), `la categoría «${g.category}» ocupa la ranura «${CATEGORY_SLOT[g.category]}», no «${g.slot}»`);
  }
  if (!fabricIds.has(g.fabricId)) add(p('fabricId'), `la tela «${g.fabricId}» no existe`);
  if (g.trimFabricId !== undefined && !fabricIds.has(g.trimFabricId)) {
    add(p('trimFabricId'), `la tela «${g.trimFabricId}» no existe`);
  }

  g.tags.forEach((tag, ti) => {
    if (!TAG_RE.test(tag)) add(p('tags', ti), 'las etiquetas deben ser kebab-case en minúsculas (a-z, 0-9, «-»)');
  });
  if (new Set(g.tags).size !== g.tags.length) add(p('tags'), 'etiquetas duplicadas');

  if (g.params) {
    for (const key of Object.keys(g.params)) {
      if (!PARAM_KEY_RE.test(key)) add(p('params', key), 'clave de parámetro inválida (camelCase alfanumérico)');
    }
  }

  const variantIds = new Set<string>();
  g.variants.forEach((v, vi) => {
    if (variantIds.has(v.id)) add(p('variants', vi, 'id'), `id de muestra duplicado «${v.id}»`);
    variantIds.add(v.id);
    checkText(v.name.es, p('variants', vi, 'name', 'es'), add);
    checkText(v.name.en, p('variants', vi, 'name', 'en'), add);
  });

  // Tabla de tallas: etiquetas únicas, rangos bien formados y monotonía (la recomendación depende de ella).
  const labels = new Set<string>();
  g.sizes.forEach((s, si) => {
    if (!SIZE_LABEL_RE.test(s.label)) add(p('sizes', si, 'label'), 'etiqueta de talla inválida');
    if (labels.has(s.label)) add(p('sizes', si, 'label'), `talla duplicada «${s.label}»`);
    labels.add(s.label);
    for (const key of BODY_KEYS) {
      const r = s.body[key];
      if (r && r[0] > r[1]) add(p('sizes', si, 'body', key), 'rango invertido (mín > máx)');
    }
  });
  for (const key of BODY_KEYS) {
    const present = g.sizes.filter((s) => s.body[key] !== undefined).length;
    if (present !== 0 && present !== g.sizes.length) {
      add(p('sizes'), `body.${key} debe estar en todas las tallas o en ninguna`);
      continue;
    }
    for (let i = 1; i < g.sizes.length; i++) {
      const a = g.sizes[i - 1]!.body[key];
      const b = g.sizes[i]!.body[key];
      if (a && b && (b[0] < a[0] || b[1] < a[1])) {
        add(p('sizes', i, 'body', key), 'los rangos corporales deben crecer con la talla');
      }
    }
  }
  for (const dim of GARMENT_DIMS) {
    const present = g.sizes.filter((s) => s.garment[dim] !== undefined).length;
    if (present !== 0 && present !== g.sizes.length) {
      add(p('sizes'), `garment.${dim} debe estar en todas las tallas o en ninguna`);
      continue;
    }
    for (let i = 1; i < g.sizes.length; i++) {
      const a = g.sizes[i - 1]!.garment[dim];
      const b = g.sizes[i]!.garment[dim];
      if (a !== undefined && b !== undefined && b < a) {
        add(p('sizes', i, 'garment', dim), 'las medidas de la prenda deben crecer con la talla');
      }
    }
  }
}

/**
 * `CatalogDataSchema` (contrato de `shared`) + reglas de integridad y saneamiento propias del catálogo:
 * ids únicos, referencias a telas, texto plano, coherencia plantilla/categoría/ranura y tablas de tallas monótonas.
 */
export const CatalogDataStrictSchema = CatalogDataSchema.superRefine((data, ctx) => {
  const add: Add = (path, message) => ctx.addIssue({ code: 'custom', message, path: [...path] });

  const fabricIds = new Set<string>();
  data.fabrics.forEach((f, fi) => {
    if (fabricIds.has(f.id)) add(['fabrics', fi, 'id'], `id de tela duplicado «${f.id}»`);
    fabricIds.add(f.id);
    checkText(f.name.es, ['fabrics', fi, 'name', 'es'], add);
    checkText(f.name.en, ['fabrics', fi, 'name', 'en'], add);
  });

  const garmentIds = new Set<string>();
  data.garments.forEach((g, gi) => {
    if (garmentIds.has(g.id)) add(['garments', gi, 'id'], `id de prenda duplicado «${g.id}»`);
    garmentIds.add(g.id);
    checkGarment(g, gi, fabricIds, add);
  });
});

/**
 * Valida datos externos de catálogo y devuelve una copia profundamente inmutable.
 * Lanza `CatalogDataError` (con lista de problemas legible y acotada) ante cualquier anomalía.
 */
export function parseCatalogData(raw: unknown): CatalogData {
  const scan = scanRawCatalog(raw);
  if (scan.length > 0) throw new CatalogDataError(scan);
  const result = CatalogDataStrictSchema.safeParse(raw);
  if (!result.success) {
    throw new CatalogDataError(
      result.error.issues.slice(0, 50).map((i) => ({ path: formatPath(i.path), message: i.message })),
    );
  }
  return deepFreeze(result.data);
}
