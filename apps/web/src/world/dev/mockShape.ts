import type { Measurements } from '@fitroom/shared';

/** Proporciones del maniquí de desarrollo (m), derivadas de las medidas. Y hacia arriba, pies en y=0. */
export interface MockShape {
  readonly H: number;
  readonly chestA: number;
  readonly waistA: number;
  readonly hipA: number;
  readonly shoulderHalf: number;
  readonly neckR: number;
  readonly thighR: number;
  readonly armLen: number;
  readonly legLen: number;
  /** Relación profundidad/anchura del torso. */
  readonly depth: number;
}

/** Semieje X de una elipse de contorno C (m) con relación de ejes `depth`. */
const semiAxis = (circumferenceCm: number, depth: number): number =>
  circumferenceCm / 100 / (2 * Math.PI * Math.sqrt((1 + depth * depth) / 2));

export function mockShape(m: Measurements): MockShape {
  const depth = 0.72;
  return {
    H: m.heightCm / 100,
    chestA: semiAxis(m.chestCm, depth),
    waistA: semiAxis(m.waistCm, depth),
    hipA: semiAxis(m.hipCm, depth),
    shoulderHalf: m.shoulderWidthCm / 200,
    neckR: m.neckCm / 100 / (2 * Math.PI),
    thighR: m.thighCm / 100 / (2 * Math.PI),
    armLen: m.armLengthCm / 100,
    legLen: m.inseamCm / 100,
    depth,
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Semieje X del torso a una altura (fracción de H), con holgura `inflate` (m). */
export function torsoRadius(s: MockShape, yFrac: number, inflate = 0): number {
  const anchors: [number, number][] = [
    [0.4, s.hipA * 0.86],
    [0.47, s.hipA * 0.94],
    [0.52, s.hipA],
    [0.57, lerp(s.hipA, s.waistA, 0.7)],
    [0.62, s.waistA],
    [0.67, lerp(s.waistA, s.chestA, 0.6)],
    [0.72, s.chestA],
    [0.78, Math.max(s.chestA, s.shoulderHalf * 0.86)],
    [0.81, s.shoulderHalf * 0.62],
    [0.835, s.neckR * 1.5],
    [0.85, s.neckR * 1.05],
  ];
  const y = Math.min(0.85, Math.max(0.4, yFrac));
  for (let i = 0; i < anchors.length - 1; i++) {
    const [y0, r0] = anchors[i]!;
    const [y1, r1] = anchors[i + 1]!;
    if (y <= y1) return lerp(r0, r1, (y - y0) / (y1 - y0)) + inflate;
  }
  return anchors[anchors.length - 1]![1] + inflate;
}
