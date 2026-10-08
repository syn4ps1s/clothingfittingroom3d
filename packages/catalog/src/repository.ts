import type {
  CatalogData,
  CatalogRepository,
  FabricDef,
  GarmentCategory,
  GarmentDefinition,
  GarmentSlot,
} from '@fitroom/shared';
import { loadCatalogData } from './loader.js';
import { normalizeText } from './util.js';
import { parseCatalogData } from './validate.js';

/** Repositorio en memoria: además del puerto asíncrono expone los datos validados para uso síncrono (p. ej. outfits). */
export interface StaticCatalog extends CatalogRepository {
  readonly data: CatalogData;
}

export interface GarmentFilter {
  readonly category?: GarmentCategory;
  readonly slot?: GarmentSlot;
  readonly text?: string;
}

const MAX_QUERY_CHARS = 200;
const MAX_TOKENS = 8;

interface IndexEntry {
  readonly garment: GarmentDefinition;
  readonly order: number;
  readonly name: string;
  readonly brand: string;
  readonly tags: string;
  readonly variants: string;
  readonly fabric: string;
  readonly description: string;
}

function buildIndex(data: CatalogData): IndexEntry[] {
  const fabrics = new Map<string, FabricDef>(data.fabrics.map((f) => [f.id, f]));
  return data.garments.map((garment, order) => {
    const fabricNames = [garment.fabricId, garment.trimFabricId]
      .map((id) => (id === undefined ? undefined : fabrics.get(id)))
      .filter((f): f is FabricDef => f !== undefined)
      .flatMap((f) => [f.name.es, f.name.en, f.family.replace(/-/g, ' ')]);
    return {
      garment,
      order,
      name: normalizeText(
        `${garment.name.es} ${garment.name.en} ${garment.template.replace(/_/g, ' ')}`,
      ),
      brand: normalizeText(garment.brand),
      tags: normalizeText(`${garment.tags.join(' ')} ${garment.category} ${garment.slot}`),
      variants: normalizeText(
        garment.variants.map((v) => `${v.name.es} ${v.name.en} ${v.pattern.type}`).join(' '),
      ),
      fabric: normalizeText(fabricNames.join(' ')),
      description: normalizeText(`${garment.description.es} ${garment.description.en}`),
    };
  });
}

/** Puntuación de relevancia (0 = no coincide). Todos los términos deben aparecer en algún campo (AND). */
function relevance(entry: IndexEntry, tokens: readonly string[]): number {
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    const consider = (field: string, weight: number) => {
      const at = field.indexOf(token);
      if (at < 0) return;
      const wordStart = at === 0 || field[at - 1] === ' ';
      best = Math.max(best, weight + (wordStart ? 1 : 0));
    };
    consider(entry.name, 5);
    consider(entry.brand, 4);
    consider(entry.tags, 3);
    consider(entry.variants, 2.5);
    consider(entry.fabric, 2.5);
    consider(entry.description, 1);
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/**
 * Catálogo estático en memoria. Valida los datos (si se pasan) y devuelve siempre estructuras inmutables:
 * filtrado por categoría/ranura/texto (insensible a mayúsculas y acentos, es/en), orden ESTABLE (el del catálogo;
 * con texto, por relevancia y luego por el orden del catálogo).
 */
export function createStaticCatalog(data?: CatalogData): StaticCatalog {
  const validated = data === undefined ? loadCatalogData() : parseCatalogData(data);
  const index = buildIndex(validated);
  const garmentsById = new Map<string, GarmentDefinition>(validated.garments.map((g) => [g.id, g]));
  const fabricsById = new Map<string, FabricDef>(validated.fabrics.map((f) => [f.id, f]));
  const fabricList: readonly FabricDef[] = Object.freeze([...validated.fabrics]);

  return {
    data: validated,
    listGarments(filter?: GarmentFilter): Promise<readonly GarmentDefinition[]> {
      let entries = index;
      if (filter !== undefined && filter !== null && typeof filter === 'object') {
        const { category, slot, text } = filter;
        if (category !== undefined)
          entries = entries.filter((e) => e.garment.category === category);
        if (slot !== undefined) entries = entries.filter((e) => e.garment.slot === slot);
        if (typeof text === 'string') {
          const tokens = normalizeText(text.slice(0, MAX_QUERY_CHARS))
            .split(' ')
            .filter((tk) => tk.length > 0)
            .slice(0, MAX_TOKENS);
          if (tokens.length > 0) {
            entries = entries
              .map((entry) => ({ entry, score: relevance(entry, tokens) }))
              .filter((r) => r.score > 0)
              .sort((a, b) => b.score - a.score || a.entry.order - b.entry.order)
              .map((r) => r.entry);
          }
        }
      }
      return Promise.resolve(Object.freeze(entries.map((e) => e.garment)));
    },
    getGarment(id: string): Promise<GarmentDefinition | undefined> {
      return Promise.resolve(typeof id === 'string' ? garmentsById.get(id) : undefined);
    },
    getFabric(id: string): Promise<FabricDef | undefined> {
      return Promise.resolve(typeof id === 'string' ? fabricsById.get(id) : undefined);
    },
    listFabrics(): Promise<readonly FabricDef[]> {
      return Promise.resolve(fabricList);
    },
  };
}
