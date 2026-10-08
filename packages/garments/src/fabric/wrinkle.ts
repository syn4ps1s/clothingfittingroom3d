import { hashU32, normalizeSeed, hash01 } from './prng.js';
import { LowResField, PeriodicFbm, PeriodicNoise2D, sinTurns, smooth01 } from './noise.js';
import { FabricInputError, isValidTextureSize } from './textures.js';
import type { Step } from './types.js';

/**
 * Normal map TILEABLE de pliegues/arrugas (RGBA8, tangent-space OpenGL) para mezclar por vértice con el
 * atributo `wrinkle` del solver. Direccionalidad suave: los pliegues dominantes corren a lo largo de +u
 * (horizontales) con ondulación orgánica, más un juego secundario oblicuo más tenue; aparecen en cúmulos
 * (modulados por ruido de baja frecuencia) y no en una trama uniforme.
 *
 * Construcción: suma de ondas |sin| con vectores de onda ENTEROS (periódicas por construcción) cuyo
 * dominio se deforma con ruido periódico; el |sin| da valles agudos (pliegue) y crestas redondeadas.
 */

interface Wave {
  readonly kx: number;
  readonly ky: number;
  readonly amp: number;
  readonly phase: number;
}

function buildWaves(seed: number): Wave[] {
  const mk = (kx: number, ky: number, amp: number, stream: number): Wave => ({
    kx,
    ky,
    amp,
    phase: hash01(seed, stream, 0, 91),
  });
  return [
    // pliegues principales (casi horizontales)
    mk(1, 7, 1.0, 1),
    mk(-1, 11, 0.8, 2),
    mk(2, 17, 0.55, 3),
    mk(0, 27, 0.32, 4),
    // juego oblicuo más tenue
    mk(6, 5, 0.45, 5),
    mk(-7, 6, 0.35, 6),
    mk(10, -9, 0.2, 7),
  ];
}

export function planWrinkleNormalMap(
  size: number,
  seedIn?: number,
): { steps: Step[]; result: () => Uint8Array } {
  if (!isValidTextureSize(size)) {
    throw new FabricInputError(`size inválido: ${size} (potencia de 2 entre 16 y 4096)`);
  }
  const S = size;
  const seed = normalizeSeed(seedIn, 0x57121e);
  const waves = buildWaves(seed);
  const H = new Float32Array(S * S);
  const out = new Uint8Array(S * S * 4);
  const steps: Step[] = [];
  const band = Math.max(1, Math.min(S, Math.floor(16384 / S)));
  const bands = (fn: (y0: number, y1: number) => void): void => {
    for (let y0 = 0; y0 < S; y0 += band) {
      const y1 = Math.min(S, y0 + band);
      steps.push(() => fn(y0, y1));
    }
  };

  const warpA = new PeriodicNoise2D(4, hashU32(seed, 1));
  const warpB = new PeriodicNoise2D(4, hashU32(seed, 2));
  const fbm = new PeriodicFbm(3, 3, hashU32(seed, 3), 0.55);
  const cluster = new LowResField(96, (u, v) => {
    const n = fbm.sample(u * 3, v * 3) * 0.5 + 0.5;
    return smooth01(0.18, 0.7, n);
  });
  const fine = new PeriodicNoise2D(48, hashU32(seed, 4));
  const fine2 = new PeriodicNoise2D(96, hashU32(seed, 5));
  let ampSum = 0;
  for (const w of waves) ampSum += w.amp;
  const inv = 1 / ampSum;

  bands((y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const v = (y + 0.5) / S;
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S;
        // ondulación orgánica de los pliegues (deformación del dominio, periódica)
        const wu = 0.045 * warpA.sample(u * 4, v * 4);
        const wv = 0.045 * warpB.sample(u * 4 + 1.7, v * 4 + 2.3);
        let s = 0;
        for (let k = 0; k < waves.length; k++) {
          const w = waves[k]!;
          const a = sinTurns(w.kx * (u + wu) + w.ky * (v + wv) + w.phase);
          s += w.amp * (a < 0 ? -a : a);
        }
        s *= inv;
        const m = 0.3 + 0.7 * cluster.sample(u, v);
        const f = 0.5 * fine.sample(u * 48, v * 48) + 0.25 * fine2.sample(u * 96, v * 96);
        H[y * S + x] = s * m + 0.05 * f;
      }
    }
  });

  // normal por Sobel; escala fijada para pendientes máximas ~35° y media plana (0,0,1)
  const bump = S / 10; // un pliegue típico ≈ S/10 píxeles
  const strength = 2.2;
  bands((y0, y1) => {
    for (let y = y0; y < y1; y++) {
      const o = y * S;
      const om = (y === 0 ? S - 1 : y - 1) * S;
      const op = (y === S - 1 ? 0 : y + 1) * S;
      for (let x = 0; x < S; x++) {
        const xm = x === 0 ? S - 1 : x - 1;
        const xp = x === S - 1 ? 0 : x + 1;
        const a = H[om + xm]!;
        const b = H[om + x]!;
        const c = H[om + xp]!;
        const d = H[o + xm]!;
        const f = H[o + xp]!;
        const g = H[op + xm]!;
        const h = H[op + x]!;
        const i = H[op + xp]!;
        const dx = (c + 2 * f + i - (a + 2 * d + g)) * 0.125;
        const dy = (g + 2 * h + i - (a + 2 * b + c)) * 0.125;
        const nx = -dx * bump * strength;
        const ny = -dy * bump * strength;
        const il = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        const q = (o + x) * 4;
        out[q] = (nx * il * 0.5 + 0.5) * 255 + 0.5;
        out[q + 1] = (ny * il * 0.5 + 0.5) * 255 + 0.5;
        out[q + 2] = (il * 0.5 + 0.5) * 255 + 0.5;
        out[q + 3] = 255;
      }
    }
  });
  return { steps, result: () => out };
}

/** Normal map tileable de pliegues/arrugas (RGBA8). Determinista para una `seed` dada. */
export function generateWrinkleNormalMap(size: 512 | 1024, seed?: number): Uint8Array {
  const plan = planWrinkleNormalMap(size, seed);
  for (const s of plan.steps) s();
  return plan.result();
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Igual que {@link generateWrinkleNormalMap} pero cediendo al event loop entre bandas. */
export async function generateWrinkleNormalMapAsync(
  size: 512 | 1024,
  seed?: number,
  sliceMs = 6,
): Promise<Uint8Array> {
  const plan = planWrinkleNormalMap(size, seed);
  let t0 = performance.now();
  for (const s of plan.steps) {
    s();
    if (performance.now() - t0 >= sliceMs) {
      await yieldToEventLoop();
      t0 = performance.now();
    }
  }
  return plan.result();
}
