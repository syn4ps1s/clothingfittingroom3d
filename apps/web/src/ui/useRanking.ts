import { useMemo } from 'react';
import type { FitVerdict, GarmentDefinition, SizeRecommendation } from '@fitroom/shared';
import { useApp } from '../state/store';
import { getCatalog } from '../world/api/catalog';

export interface RankedGarment {
  readonly garment: GarmentDefinition;
  readonly rec: SizeRecommendation;
  /** 0..1: cuánto encaja con la persona (veredicto × confianza). */
  readonly score: number;
}

const VERDICT_SCORE: Record<FitVerdict, number> = {
  good: 1,
  snug: 0.65,
  roomy: 0.65,
  'too-tight': 0.2,
  'too-loose': 0.25,
};

export function scoreRecommendation(rec: SizeRecommendation): number {
  return VERDICT_SCORE[rec.overall] * rec.confidence;
}

/** Todas las prendas con su talla sugerida, de la que mejor te sienta a la que peor. */
export function useRanking(): readonly RankedGarment[] {
  const measurements = useApp((s) => s.measurements);
  const sigma = useApp((s) => s.sigma);
  return useMemo(() => {
    if (!measurements) return [];
    const catalog = getCatalog();
    return catalog.data.garments
      .map((garment) => {
        const rec = catalog.recommend(garment, measurements, sigma);
        return { garment, rec, score: scoreRecommendation(rec) };
      })
      .sort((a, b) => b.score - a.score);
  }, [measurements, sigma]);
}

/** Minúsculas y sin acentos, para buscar «vaquero» o «jersey» sin importar cómo se escriba. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function garmentMatches(g: GarmentDefinition, query: string): boolean {
  const q = normalizeText(query.trim());
  if (!q) return true;
  const haystack = normalizeText(
    [g.name.es, g.name.en, g.brand, g.description.es, g.description.en, ...g.tags].join(' '),
  );
  return q.split(/\s+/).every((word) => haystack.includes(word));
}
