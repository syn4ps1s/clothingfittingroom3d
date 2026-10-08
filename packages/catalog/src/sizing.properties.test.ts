import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MEASUREMENT_LIMITS,
  REFERENCE_MEASUREMENTS,
  type GarmentDefinition,
  type MeasurementKey,
  type Measurements,
  type SizeNote,
} from '@fitroom/shared';
import { SizingInputError, recommendSize } from './index.js';
import { FC, arbBody, arbGarmentId, arbProportionedBody, bodyForSize, catalog, garmentOf, growBody, idxOf, stretchOf } from './test-helpers.js';

const NOTES: readonly SizeNote[] = [
  'between-sizes',
  'below-smallest-size',
  'above-largest-size',
  'low-measurement-confidence',
  'height-out-of-range',
];
const VERDICTS = ['too-tight', 'snug', 'good', 'roomy', 'too-loose'];
const arbPref = fc.constantFrom('snug' as const, 'regular' as const, 'roomy' as const, undefined);
const sigmaKeys = ['heightCm', 'chestCm', 'waistCm', 'hipCm', 'shoulderWidthCm', 'inseamCm'] as const;

const run = (g: GarmentDefinition, m: Measurements, extra: Record<string, unknown> = {}) =>
  recommendSize({ garment: g, measurements: m, fabric: stretchOf(g), ...extra });

const delta = fc.integer({ min: 0, max: 60 }).map((n) => n / 10);
const arbGrow = fc.record({
  heightCm: delta,
  chestCm: delta,
  waistCm: delta,
  hipCm: delta,
  shoulderWidthCm: delta,
  armLengthCm: delta,
  inseamCm: delta,
  thighCm: delta,
});

describe('recommendSize — propiedades (fast-check, semilla fija)', () => {
  it('nunca produce NaN ni valores fuera de contrato', () => {
    fc.assert(
      fc.property(
        arbGarmentId,
        arbBody,
        arbPref,
        fc.record({ chestCm: delta, waistCm: delta, hipCm: delta, heightCm: delta }),
        (gid, m, preference, sigmaCm) => {
          const g = garmentOf(gid);
          const r = run(g, m, { preference, sigmaCm });
          expect(Number.isFinite(r.confidence)).toBe(true);
          expect(r.confidence).toBeGreaterThanOrEqual(0);
          expect(r.confidence).toBeLessThanOrEqual(1);
          expect(g.sizes.map((s) => s.label)).toContain(r.size);
          expect(VERDICTS).toContain(r.overall);
          for (const d of r.dimensions) {
            expect(Number.isFinite(d.bodyCm) && Number.isFinite(d.garmentCm) && Number.isFinite(d.easeCm)).toBe(true);
            expect(VERDICTS).toContain(d.verdict);
          }
          for (const n of r.notes) expect(NOTES).toContain(n);
          expect(r.alternatives.map((a) => a.size)).not.toContain(r.size);
          expect(new Set(r.alternatives.map((a) => a.size)).size).toBe(r.alternatives.length);
          for (const a of r.alternatives) {
            expect(g.sizes.map((s) => s.label)).toContain(a.size);
            expect(VERDICTS).toContain(a.overall);
          }
        },
      ),
      FC,
    );
  });

  it('monotonía: a mayor cuerpo, talla igual o mayor', () => {
    fc.assert(
      fc.property(arbGarmentId, arbBody, arbGrow, arbPref, (gid, m, grow, preference) => {
        const g = garmentOf(gid);
        const a = run(g, m, { preference });
        const b = run(g, growBody(m, grow), { preference });
        expect(idxOf(g, b.size)).toBeGreaterThanOrEqual(idxOf(g, a.size));
      }),
      { ...FC, numRuns: 400 },
    );
  });

  it('monotonía con incrementos aislados en una sola medida', () => {
    const keys: MeasurementKey[] = ['chestCm', 'waistCm', 'hipCm', 'shoulderWidthCm', 'heightCm', 'inseamCm'];
    fc.assert(
      fc.property(arbGarmentId, arbBody, fc.constantFrom(...keys), delta, (gid, m, key, d) => {
        const g = garmentOf(gid);
        const a = run(g, m);
        const b = run(g, growBody(m, { [key]: d }));
        expect(idxOf(g, b.size)).toBeGreaterThanOrEqual(idxOf(g, a.size));
      }),
      { ...FC, numRuns: 300 },
    );
  });

  it('la preferencia ordena las tallas: ceñida ≤ regular ≤ holgada', () => {
    fc.assert(
      fc.property(arbGarmentId, arbBody, (gid, m) => {
        const g = garmentOf(gid);
        const snug = idxOf(g, run(g, m, { preference: 'snug' }).size);
        const regular = idxOf(g, run(g, m, { preference: 'regular' }).size);
        const roomy = idxOf(g, run(g, m, { preference: 'roomy' }).size);
        expect(snug).toBeLessThanOrEqual(regular);
        expect(regular).toBeLessThanOrEqual(roomy);
      }),
      { ...FC, numRuns: 300 },
    );
  });

  it('un cuerpo en el centro del rango de una talla recibe esa talla (también con preferencia)', () => {
    for (const g of catalog.garments) {
      g.sizes.forEach((size, i) => {
        const body = bodyForSize(g, i);
        for (const preference of ['regular', 'snug', 'roomy'] as const) {
          const r = run(g, body, { preference });
          expect(r.size, `${g.id} talla ${size.label} (${preference})`).toBe(size.label);
        }
      });
    }
  });

  it('un cuerpo dentro del rango de una talla (cualquier posición de la dimensión principal) no salta más de una talla', () => {
    // Dimensión principal: pecho en prendas superiores/vestidos/abrigos, cintura en pantalones y faldas.
    const primary = (g: GarmentDefinition) => (g.category === 'bottoms' ? ('waistCm' as const) : ('chestCm' as const));
    fc.assert(
      fc.property(arbGarmentId, fc.double({ min: 0.02, max: 0.98, noNaN: true }), fc.nat(), (gid, t, pick) => {
        const g = garmentOf(gid);
        const i = pick % g.sizes.length;
        const r = run(g, bodyForSize(g, i, undefined, { key: primary(g), at: t }));
        expect(Math.abs(idxOf(g, r.size) - i)).toBeLessThanOrEqual(1);
        // la mitad central del rango principal pertenece a la talla (regular)
        if (t >= 0.25 && t <= 0.75) expect(r.size).toBe(g.sizes[i]!.label);
      }),
      FC,
    );
  });

  it('estabilidad: si una perturbación pequeña cambia la talla, el caso original ya estaba «entre tallas»', () => {
    const arbJitter = fc.record(
      Object.fromEntries(
        (['heightCm', 'chestCm', 'waistCm', 'hipCm', 'shoulderWidthCm', 'armLengthCm', 'inseamCm', 'thighCm'] as const).map(
          (k) => [k, fc.integer({ min: -5, max: 5 }).map((n) => n / 10)],
        ),
      ) as Record<MeasurementKey & string, fc.Arbitrary<number>>,
    );
    fc.assert(
      fc.property(arbGarmentId, arbBody, arbJitter, arbPref, (gid, m, jitter, preference) => {
        const g = garmentOf(gid);
        const a = run(g, m, { preference });
        const perturbed: Record<string, unknown> = { ...m };
        for (const [k, d] of Object.entries(jitter)) {
          const lim = MEASUREMENT_LIMITS[k as MeasurementKey];
          perturbed[k] = Math.min(lim.max, Math.max(lim.min, (m as unknown as Record<string, number>)[k]! + d));
        }
        const b = run(g, perturbed as unknown as Measurements, { preference });
        const ia = idxOf(g, a.size);
        const ib = idxOf(g, b.size);
        expect(Math.abs(ia - ib)).toBeLessThanOrEqual(1);
        if (ia !== ib) expect(a.notes).toContain('between-sizes');
      }),
      { ...FC, numRuns: 500 },
    );
  });

  it('más incertidumbre nunca aumenta la confianza ni cambia la talla', () => {
    fc.assert(
      fc.property(
        arbGarmentId,
        arbBody,
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (gid, m, s1, s2) => {
          const g = garmentOf(gid);
          const lo = Math.min(s1, s2) / 10;
          const hi = Math.max(s1, s2) / 10;
          const sig = (s: number) => Object.fromEntries(sigmaKeys.map((k) => [k, s]));
          const a = run(g, m, { sigmaCm: sig(lo) });
          const b = run(g, m, { sigmaCm: sig(hi) });
          expect(b.size).toBe(a.size);
          expect(b.confidence).toBeLessThanOrEqual(a.confidence + 1e-9);
        },
      ),
      { ...FC, numRuns: 300 },
    );
  });

  it('es determinista, puro y no muta la entrada', () => {
    fc.assert(
      fc.property(arbGarmentId, arbBody, arbPref, (gid, m, preference) => {
        const g = garmentOf(gid);
        const frozen = Object.freeze({ ...m });
        const sigmaCm = Object.freeze({ chestCm: 1.5 });
        const a = run(g, frozen, { preference, sigmaCm });
        const b = run(g, frozen, { preference, sigmaCm });
        expect(b).toEqual(a);
      }),
      FC,
    );
  });

  it('entradas fuera de rango o no finitas → SizingInputError tipado', () => {
    const bad = fc.oneof(
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY),
      fc.double({ min: -1e6, max: -0.001, noNaN: true }),
      fc.double({ min: 1e4, max: 1e9, noNaN: true }),
    );
    const keys = ['heightCm', 'weightKg', 'chestCm', 'waistCm', 'hipCm', 'shoulderWidthCm', 'armLengthCm', 'inseamCm', 'neckCm', 'thighCm'] as const;
    fc.assert(
      fc.property(arbGarmentId, arbBody, fc.constantFrom(...keys), bad, (gid, m, key, value) => {
        const g = garmentOf(gid);
        expect(() => run(g, { ...m, [key]: value })).toThrow(SizingInputError);
        try {
          run(g, { ...m, [key]: value });
        } catch (e) {
          expect((e as SizingInputError).code).toBe('invalid-measurements');
        }
      }),
      FC,
    );
  });

  it('confianza calibrada: a mayor confianza, mayor estabilidad empírica ante el ruido de medida', () => {
    // Monte Carlo con PRNG determinista (mulberry32): fracción de veces que la talla calculada con medidas ruidosas
    // (σ = 1,5 cm por medida) coincide con la calculada sobre las medidas «verdaderas». Cuerpos proporcionados.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const sigma = 1.5;
    const sig = Object.fromEntries(sigmaKeys.map((k) => [k, sigma]));
    const points: { conf: number; agree: number }[] = [];
    const bodies = fc.sample(arbProportionedBody, { seed: FC.seed, numRuns: 40 });
    const ids = ['tee-essential', 'shirt-oxford', 'sweater-chunky-crew', 'jeans-straight-raw', 'chino-slim-twill', 'skirt-midi-pleated', 'dress-shirt-poplin', 'coat-wool-long'];
    for (const id of ids) {
      const g = garmentOf(id);
      for (const m of bodies) {
        const truth = run(g, m, { sigmaCm: sig });
        let agree = 0;
        const trials = 40;
        for (let n = 0; n < trials; n++) {
          const noisy: Record<string, unknown> = { ...m };
          for (const k of sigmaKeys) {
            const lim = MEASUREMENT_LIMITS[k];
            noisy[k] = Math.min(lim.max, Math.max(lim.min, m[k] + gauss() * sigma));
          }
          if (run(g, noisy as unknown as Measurements).size === truth.size) agree++;
        }
        points.push({ conf: truth.confidence, agree: agree / trials });
      }
    }
    points.sort((a, b) => a.conf - b.conf);
    const third = Math.floor(points.length / 3);
    const mean = (xs: { agree: number }[]) => xs.reduce((s, p) => s + p.agree, 0) / xs.length;
    const low = mean(points.slice(0, third));
    const mid = mean(points.slice(third, 2 * third));
    const high = mean(points.slice(2 * third));
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
    expect(high - low).toBeGreaterThan(0.1);
    // Los casos de confianza alta casi nunca cambian de talla con el ruido.
    const confident = points.filter((p) => p.conf >= 0.85);
    expect(confident.length).toBeGreaterThan(10);
    expect(mean(confident)).toBeGreaterThan(0.93);
  });
});
