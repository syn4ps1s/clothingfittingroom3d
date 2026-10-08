import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import type { FabricTextureSet } from '@fitroom/shared';

export type TextureKind = 'albedo' | 'normal' | 'orm';

/** DataTexture tileable (mipmaps + anisotropía) a partir de un canal del set. */
export function toDataTexture(set: FabricTextureSet, kind: TextureKind, anisotropy = 4): DataTexture {
  const tex = new DataTexture(
    // Copia: el set puede estar cacheado y compartido entre texturas.
    new Uint8Array(set[kind]),
    set.size,
    set.size,
    RGBAFormat,
    UnsignedByteType,
  );
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = anisotropy;
  if (kind === 'albedo') tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
