import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ASSET_CLASSES,
  CACHE_IMMUTABLE,
  CACHE_NO_CACHE,
  CACHE_REVALIDATE,
  SHELL_CLASS,
  classifyAsset,
  contentTypeFor,
  globToRegExp,
  shellExcludePatterns,
} from '../lib/asset-policy';

describe('clasificación de activos', () => {
  const cases: [string, string, string][] = [
    ['index.html', 'Shell', CACHE_NO_CACHE],
    ['favicon.svg', 'Shell', CACHE_NO_CACHE],
    ['assets/index-4f2a1c9e.js', 'ImmutableAssets', CACHE_IMMUTABLE],
    ['assets/fonts/inter-latin-wght-normal-ab12.woff2', 'ImmutableAssets', CACHE_IMMUTABLE],
    ['wasm/vision_wasm_internal.wasm', 'WasmBinaries', CACHE_REVALIDATE],
    ['wasm/vision_wasm_nosimd_internal.js', 'WasmLoaders', CACHE_REVALIDATE],
    ['models/pose_landmarker_full.task', 'PoseModels', CACHE_REVALIDATE],
    ['/models/pose_landmarker_lite.task', 'PoseModels', CACHE_REVALIDATE],
    ['models/readme.txt', 'Shell', CACHE_NO_CACHE],
    ['catalog/garments.json', 'Shell', CACHE_NO_CACHE],
  ];
  it.each(cases)('%s → %s', (path, id, cache) => {
    const cls = classifyAsset(path);
    expect(cls.id).toBe(id);
    expect(cls.cacheControl).toBe(cache);
  });

  it('tipos MIME exactos para lo que rompería la app si fuera otro', () => {
    expect(contentTypeFor('wasm/vision_wasm_internal.wasm')).toBe('application/wasm');
    expect(contentTypeFor('models/pose_landmarker_lite.task')).toBe('application/octet-stream');
    expect(contentTypeFor('wasm/vision_wasm_internal.js')).toMatch(/^text\/javascript/);
    expect(contentTypeFor('assets/index-1.js')).toMatch(/^text\/javascript/);
    expect(contentTypeFor('assets/index-1.css')).toMatch(/^text\/css/);
    expect(contentTypeFor('index.html')).toMatch(/^text\/html/);
    expect(contentTypeFor('x/y.unknownext')).toBe('application/octet-stream');
  });

  it('las clases con patrón propio tienen ids únicos y ninguna usa la caché de la «shell»', () => {
    const ids = [...ASSET_CLASSES.map((c) => c.id), SHELL_CLASS.id];
    expect(new Set(ids).size).toBe(ids.length);
    for (const cls of ASSET_CLASSES) {
      expect(cls.include.length).toBeGreaterThan(0);
      expect(cls.cacheControl).not.toBe(SHELL_CLASS.cacheControl);
    }
    expect(SHELL_CLASS.include).toEqual([]);
  });

  it('los excludes de la «shell» son exactamente la unión de los includes de las demás clases', () => {
    expect(shellExcludePatterns()).toEqual(ASSET_CLASSES.flatMap((c) => [...c.include]));
  });

  it('propiedad: toda ruta cae en exactamente una clase y la «shell» nunca coincide con un patrón excluido', () => {
    const segment = fc.stringMatching(/^[a-z0-9._-]{1,12}$/);
    const path = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join('/'));
    fc.assert(
      fc.property(path, (p) => {
        const cls = classifyAsset(p);
        const matching = ASSET_CLASSES.filter((c) =>
          c.include.some((g) => globToRegExp(g).test(p)),
        );
        if (cls.id === SHELL_CLASS.id) expect(matching).toHaveLength(0);
        else expect(matching[0]?.id).toBe(cls.id);
      }),
      { seed: 7, numRuns: 300 },
    );
  });

  it('globToRegExp: * casa también la barra y escapa metacaracteres', () => {
    expect(globToRegExp('assets/*').test('assets/a/b.js')).toBe(true);
    expect(globToRegExp('wasm/*.wasm').test('wasm/x.wasm')).toBe(true);
    expect(globToRegExp('wasm/*.wasm').test('wasm/xAwasm')).toBe(false);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
  });
});
