import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
  type ColorSpace,
} from 'three';
import type { FabricTextureSet } from '@fitroom/shared';

/**
 * Texturas GPU de un FabricTextureSet. Los tres mapas se crean UNA vez por set (base) y cada
 * consumidor recibe clones que comparten la subida a la GPU (`Source`) pero tienen su propia
 * repetición (`repeat`), porque la escala física depende de cada prenda (`uvMetersPerTile`).
 */
export interface FabricGpuTextures {
  readonly albedo: DataTexture;
  readonly normal: DataTexture;
  /** R = oclusión, G = rugosidad, B = metalicidad */
  readonly orm: DataTexture;
  /** Libera los clones del consumidor (los datos del set pertenecen a la caché de modelos). */
  dispose(): void;
}

interface Base {
  albedo: DataTexture;
  normal: DataTexture;
  orm: DataTexture;
}

const bases = new WeakMap<FabricTextureSet, Base>();

function makeBase(data: Uint8Array, size: number, colorSpace: ColorSpace): DataTexture {
  const t = new DataTexture(data as Uint8Array<ArrayBuffer>, size, size, RGBAFormat, UnsignedByteType);
  t.colorSpace = colorSpace;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export interface AcquireOptions {
  /** Repeticiones de la textura por unidad UV (= uvMetersPerTile / tileMeters). */
  readonly repeat: number;
  readonly anisotropy?: number;
}

export function acquireFabricTextures(
  set: FabricTextureSet,
  opts: AcquireOptions,
): FabricGpuTextures {
  let base = bases.get(set);
  if (!base) {
    base = {
      albedo: makeBase(set.albedo, set.size, SRGBColorSpace),
      normal: makeBase(set.normal, set.size, NoColorSpace),
      orm: makeBase(set.orm, set.size, NoColorSpace),
    };
    bases.set(set, base);
  }
  const rep = Number.isFinite(opts.repeat) && opts.repeat > 0 ? opts.repeat : 1;
  const aniso = opts.anisotropy ?? 8;
  const clone = (t: DataTexture): DataTexture => {
    const c = t.clone();
    c.repeat.set(rep, rep);
    c.anisotropy = aniso;
    return c;
  };
  const albedo = clone(base.albedo);
  const normal = clone(base.normal);
  const orm = clone(base.orm);
  let disposed = false;
  return {
    albedo,
    normal,
    orm,
    dispose() {
      if (disposed) return;
      disposed = true;
      albedo.dispose();
      normal.dispose();
      orm.dispose();
    },
  };
}

/** Textura RGBA8 suelta (p. ej. normal map de arrugas), con repetición y filtrado de tejido. */
export function makeDataTexture(
  data: Uint8Array,
  size: number,
  colorSpace: ColorSpace = NoColorSpace,
): DataTexture {
  return makeBase(data, size, colorSpace);
}
