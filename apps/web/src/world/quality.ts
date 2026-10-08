import type { Quality } from '../state/persistence';

/** Presupuesto gráfico por calidad (equipos modestos → «low»). */
export interface QualityConfig {
  readonly floorTex: number;
  readonly plasterTex: number;
  readonly woodTex: number;
  readonly shadows: boolean;
  readonly shadowMap: number;
  readonly envRes: number;
  readonly dust: number;
  readonly post: boolean;
  readonly dpr: number | [number, number];
  readonly antialias: boolean;
  readonly props: 'minimal' | 'full';
  readonly swatchTex: 128 | 256;
}

const CONFIG: Record<Quality, QualityConfig> = {
  low: {
    floorTex: 512, plasterTex: 256, woodTex: 256, shadows: false, shadowMap: 512, envRes: 64, dust: 0,
    post: false, dpr: 1, antialias: false, props: 'minimal', swatchTex: 128,
  },
  medium: {
    floorTex: 1024, plasterTex: 512, woodTex: 512, shadows: true, shadowMap: 1024, envRes: 128, dust: 36,
    post: true, dpr: [1, 1.5], antialias: true, props: 'full', swatchTex: 256,
  },
  high: {
    floorTex: 2048, plasterTex: 512, woodTex: 1024, shadows: true, shadowMap: 2048, envRes: 256, dust: 70,
    post: true, dpr: [1, 2], antialias: true, props: 'full', swatchTex: 256,
  },
};

export const qualityConfig = (q: Quality): QualityConfig => CONFIG[q];
