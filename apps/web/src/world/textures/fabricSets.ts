import type { FabricDef, FabricTextureSet, SwatchVariant } from '@fitroom/shared';
import { generateFabricTextures } from '@fitroom/garments';
import { READY } from 'virtual:fitroom-status';
import { appParams } from '../../app/params';
import type { Quality } from '../../state/persistence';
import { generateDevFabricTextures } from '../dev/devFabric';

const cache = new Map<string, FabricTextureSet>();
let warnedFabric = false;

const DEV_SIZE: Record<Quality, 128 | 256 | 512> = { low: 128, medium: 256, high: 512 };
const useRealFabric = () => READY.garmentsFabric && !appParams().mock;

/**
 * Texturas PBR de un par tela+muestra. Usa el generador real de @fitroom/garments cuando FABRIC está READY
 * (512 px) y, si falla o aún no existe, el generador de desarrollo. Cacheadas: la mesa 3D, las miniaturas del
 * DOM y las prendas comparten la misma generación.
 */
export function getFabricTextures(
  fabric: FabricDef,
  variant: SwatchVariant,
  quality: Quality = 'medium',
): FabricTextureSet {
  const real = useRealFabric();
  const size = real ? 512 : DEV_SIZE[quality];
  const key = `${real ? 'real' : 'dev'}|${fabric.id}|${variant.id}|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let set: FabricTextureSet | null = null;
  if (real) {
    try {
      set = generateFabricTextures(fabric, variant, 512);
    } catch (err) {
      if (!warnedFabric) {
        warnedFabric = true;
        console.warn('generateFabricTextures no disponible; uso texturas de desarrollo.', err);
      }
    }
  }
  set ??= generateDevFabricTextures(fabric, variant, DEV_SIZE[quality]);
  cache.set(key, set);
  return set;
}
