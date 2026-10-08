import { useEffect, useMemo, useState } from 'react';
import type { GarmentGeometry, Measurements } from '@fitroom/shared';
import type { EquippedItem, FittingModels, LoadedGarment } from '../../contracts';
import { makeMockBody } from './devBody';
import { generateDevFabricTextures } from './devFabric';

function hollowGeometry(item: EquippedItem): GarmentGeometry {
  return {
    garmentId: item.garment.id,
    sizeLabel: item.sizeLabel,
    slot: item.garment.slot,
    mesh: {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: new Uint32Array(0),
      skinIndices: new Uint16Array(0),
      skinWeights: new Float32Array(0),
    },
    groups: [],
    cloth: { maxDistance: new Float32Array(0), invMass: new Float32Array(0), stiffness: 0.3, damping: 0.1 },
    ao: new Float32Array(0),
    coversRegions: [],
    uvMetersPerTile: item.fabric.tileCm / 100,
  };
}

export function mockLoadedGarment(item: EquippedItem, textureSize = 128): LoadedGarment {
  return {
    item,
    geometry: hollowGeometry(item),
    textures: {
      main: generateDevFabricTextures(item.fabric, item.variant, textureSize),
      trim: item.trimFabric ? generateDevFabricTextures(item.trimFabric, item.variant, 64) : undefined,
    },
  };
}

/** `useFittingModels` simulado: pasa por «loading» un instante para ejercitar los estados de carga. */
export function useMockFittingModels(
  measurements: Measurements | null,
  equipped: readonly EquippedItem[],
): FittingModels {
  const key = useMemo(
    () => equipped.map((e) => `${e.garment.id}:${e.sizeLabel}:${e.variant.id}`).join('|'),
    [equipped],
  );
  const [readyKey, setReadyKey] = useState<string | null>(null);

  useEffect(() => {
    if (!measurements) return undefined;
    const t = window.setTimeout(() => setReadyKey(key), 120);
    return () => window.clearTimeout(t);
  }, [measurements, key]);

  const body = useMemo(() => (measurements ? makeMockBody(measurements) : null), [measurements]);
  const garments = useMemo(() => equipped.map((e) => mockLoadedGarment(e)), [equipped]);

  return useMemo<FittingModels>(() => {
    if (!measurements || !body) return { status: 'idle', body: null, garments: [] };
    if (readyKey !== key) return { status: 'loading', body, garments: [] };
    return { status: 'ready', body, garments };
  }, [measurements, body, readyKey, key, garments]);
}
