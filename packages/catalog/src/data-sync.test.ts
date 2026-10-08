import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCatalogParts, type CatalogParts } from '../tools/build-data.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
const FILES: Record<keyof CatalogParts, string> = {
  fabrics: 'fabrics.json',
  tops: 'tops.json',
  bottoms: 'bottoms.json',
  dresses: 'dresses.json',
  outerwear: 'outerwear.json',
};

describe('datos generados', () => {
  const parts = buildCatalogParts();
  for (const key of Object.keys(FILES) as (keyof CatalogParts)[]) {
    it(`${FILES[key]} coincide con el generador (ejecuta «pnpm --filter @fitroom/catalog build:data»)`, () => {
      const onDisk = JSON.parse(readFileSync(join(dataDir, FILES[key]), 'utf8')) as unknown;
      expect(onDisk).toEqual(JSON.parse(JSON.stringify(parts[key])));
    });
  }

  it('el generador es determinista', () => {
    expect(JSON.stringify(buildCatalogParts())).toBe(JSON.stringify(parts));
  });
});
