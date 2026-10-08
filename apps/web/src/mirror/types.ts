export type Quality = 'low' | 'medium' | 'high';

/** Tamaño de textura PBR según calidad. */
export const TEXTURE_SIZE_BY_QUALITY: Readonly<Record<Quality, 512 | 1024 | 2048>> = {
  low: 512,
  medium: 1024,
  high: 2048,
};

/** ¿Se simula tela (solver) en este nivel de calidad? low = sólo skinning. */
export const SIMULATE_BY_QUALITY: Readonly<Record<Quality, boolean>> = {
  low: false,
  medium: true,
  high: true,
};

export interface RigTimings {
  skinMs: number;
  clothMs: number;
}
