/**
 * Genera `src/data/*.json` a partir de las definiciones fuente de `tools/`.
 *
 *   pnpm --filter @fitroom/catalog build:data
 *
 * Los JSON son artefactos GENERADOS y versionados: se editan en `tools/*.ts` (tablas de tallas, telas, muestras,
 * textos) y se regeneran. `src/data-sync.test.ts` falla si alguien edita un JSON a mano sin regenerar.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import type { FabricDef, GarmentDefinition } from '@fitroom/shared';
import { CATALOG_VERSION } from '../src/version.js';
import { parseCatalogData } from '../src/validate.js';
import { FABRICS } from './fabrics.js';
import { toGarment } from './garment-source.js';
import { TOPS } from './tops.js';
import { BOTTOMS } from './bottoms.js';
import { DRESSES, OUTERWEAR } from './dresses-outerwear.js';

export interface CatalogParts {
  readonly fabrics: readonly FabricDef[];
  readonly tops: readonly GarmentDefinition[];
  readonly bottoms: readonly GarmentDefinition[];
  readonly dresses: readonly GarmentDefinition[];
  readonly outerwear: readonly GarmentDefinition[];
}

/** Construye las partes del catálogo (puro y determinista) y valida el conjunto con el esquema estricto. */
export function buildCatalogParts(): CatalogParts {
  const parts: CatalogParts = {
    fabrics: FABRICS,
    tops: TOPS.map(toGarment),
    bottoms: BOTTOMS.map(toGarment),
    dresses: DRESSES.map(toGarment),
    outerwear: OUTERWEAR.map(toGarment),
  };
  // Falla ruidosamente si el generador produjo algo inválido.
  parseCatalogData({
    version: CATALOG_VERSION,
    fabrics: parts.fabrics,
    garments: [...parts.tops, ...parts.bottoms, ...parts.dresses, ...parts.outerwear],
  });
  return parts;
}

const FILES: Readonly<Record<keyof CatalogParts, string>> = {
  fabrics: 'fabrics.json',
  tops: 'tops.json',
  bottoms: 'bottoms.json',
  dresses: 'dresses.json',
  outerwear: 'outerwear.json',
};

async function main(): Promise<void> {
  const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/data');
  mkdirSync(dataDir, { recursive: true });
  const parts = buildCatalogParts();
  for (const key of Object.keys(FILES) as (keyof CatalogParts)[]) {
    const file = resolve(dataDir, FILES[key]);
    const config = (await prettier.resolveConfig(file)) ?? {};
    const text = await prettier.format(JSON.stringify(parts[key]), { ...config, parser: 'json' });
    writeFileSync(file, text);
    process.stdout.write(`${FILES[key]}: ${text.length} bytes\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
