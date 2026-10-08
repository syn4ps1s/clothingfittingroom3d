import {
  Color,
  DoubleSide,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  ShaderChunk,
  Vector3,
  type IUniform,
  type Material,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { MATERIAL_SLOTS, type GarmentGeometry, type MaterialSlot } from '@fitroom/shared';
import type { LoadedGarment } from '../contracts';
import { lookFor } from './fabricLook';
import { acquireFabricTextures, makeDataTexture, type FabricGpuTextures } from './textureCache';

/** Uniformes compartidos por todos los materiales de una prenda (se actualizan sin recompilar). */
export interface GarmentShaderUniforms {
  [key: string]: IUniform;
  uExposure: IUniform<number>;
  uLightTint: IUniform<Vector3>;
  uBakedAoStrength: IUniform<number>;
  uWrinkleMap: IUniform<Texture | null>;
  uWrinkleStrength: IUniform<number>;
  uWrinkleUvScale: IUniform<number>;
}

export interface GarmentMaterialOptions {
  /** true: el tone mapping se hace dentro del shader (render a RenderTarget, donde three no lo aplica). */
  readonly mirrorToneMap: boolean;
  /** Los materiales son transparentes para poder desvanecer la prenda (sólo en el espejo). */
  readonly fadeable: boolean;
  /** Normal map tileable de arrugas (null = sin arrugas dependientes de la pose). */
  readonly wrinkleMap: Texture | null;
  /** Metros que cubre una repetición del mapa de arrugas. */
  readonly wrinkleTileMeters?: number;
  readonly anisotropy?: number;
}

export interface GarmentMaterials {
  /** Índice = `materialIndex` del grupo de la geometría. */
  readonly materials: readonly Material[];
  readonly uniforms: GarmentShaderUniforms;
  indexOfSlot(slot: MaterialSlot): number;
  setOpacity(opacity: number): void;
  dispose(): void;
}

/** Tone mapping "PBR Neutral" de Khronos (preserva el color del producto; MIT). Copia de three. */
const NEUTRAL_TONEMAP_GLSL = /* glsl */ `
vec3 garmentNeutralTone( vec3 color ) {
	const float startCompression = 0.8 - 0.04;
	const float desaturation = 0.15;
	float x = min( color.r, min( color.g, color.b ) );
	float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	color -= offset;
	float peak = max( color.r, max( color.g, color.b ) );
	if ( peak < startCompression ) return color;
	const float d = 1.0 - startCompression;
	float newPeak = 1.0 - d * d / ( peak + d - startCompression );
	color *= newPeak / peak;
	float g = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );
	return mix( color, vec3( newPeak ), g );
}
`;

const WRINKLE_NORMAL_INSERT = /* glsl */ `
	vec3 wrN = texture2D( uWrinkleMap, vWrinkleUv ).xyz * 2.0 - 1.0;
	float wrAmt = uWrinkleStrength * smoothstep( 0.04, 0.9, vWrinkle );
	mapN.xy += wrN.xy * wrAmt;
	wrinkleFold = wrAmt * clamp( length( wrN.xy ), 0.0, 1.0 );
`;

const AO_CODE = /* glsl */ `
	float bakedAo = mix( 1.0, clamp( vBakedAo, 0.0, 1.0 ), uBakedAoStrength );
	reflectedLight.indirectDiffuse *= bakedAo * ( 1.0 - 0.45 * wrinkleFold );
	reflectedLight.indirectSpecular *= bakedAo;
	reflectedLight.directDiffuse *= mix( 1.0, bakedAo, 0.35 ) * ( 1.0 - 0.25 * wrinkleFold );
`;

export interface PatchFlags {
  readonly mirrorToneMap: boolean;
  readonly wrinkles: boolean;
}

/**
 * Parchea el shader físico de three: AO por vértice horneado, arrugas dependientes de la pose
 * (mezcla de un normal map por el atributo `wrinkle`) y tone mapping propio para el render al espejo.
 * Devuelve false (y deja el shader intacto en lo que no pudo parchear) si alguna ancla no existe.
 */
export function patchGarmentShader(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, IUniform> },
  uniforms: GarmentShaderUniforms,
  flags: PatchFlags,
): boolean {
  let ok = true;
  const rep = (src: string, anchor: string, withText: string): string => {
    if (!src.includes(anchor)) {
      ok = false;
      return src;
    }
    return src.replace(anchor, withText);
  };
  Object.assign(shader.uniforms, uniforms);

  let vs = shader.vertexShader;
  vs = rep(
    vs,
    '#include <common>',
    `#include <common>
attribute float aBakedAo;
attribute float aWrinkle;
varying float vBakedAo;
varying float vWrinkle;
varying vec2 vWrinkleUv;
uniform float uWrinkleUvScale;`,
  );
  vs = rep(
    vs,
    '#include <begin_vertex>',
    `#include <begin_vertex>
vBakedAo = aBakedAo;
vWrinkle = aWrinkle;
vWrinkleUv = uv * uWrinkleUvScale;`,
  );

  let fs = shader.fragmentShader;
  fs = rep(
    fs,
    '#include <common>',
    `#include <common>
varying float vBakedAo;
varying float vWrinkle;
varying vec2 vWrinkleUv;
uniform sampler2D uWrinkleMap;
uniform float uWrinkleStrength;
uniform float uBakedAoStrength;
uniform float uExposure;
uniform vec3 uLightTint;
${NEUTRAL_TONEMAP_GLSL}`,
  );
  const mapsChunk: string = ShaderChunk.normal_fragment_maps;
  const insertAfter = 'mapN.xy *= normalScale;';
  let normalChunk = '#include <normal_fragment_maps>';
  if (flags.wrinkles) {
    if (mapsChunk.includes(insertAfter)) {
      normalChunk = mapsChunk.replace(insertAfter, `${insertAfter}\n${WRINKLE_NORMAL_INSERT}`);
    } else {
      ok = false;
    }
  }
  fs = rep(fs, '#include <normal_fragment_maps>', `float wrinkleFold = 0.0;\n${normalChunk}`);
  fs = rep(fs, '#include <aomap_fragment>', `#include <aomap_fragment>\n${AO_CODE}`);
  if (flags.mirrorToneMap) {
    fs = rep(
      fs,
      '#include <tonemapping_fragment>',
      'gl_FragColor.rgb = garmentNeutralTone( gl_FragColor.rgb * uLightTint * uExposure );',
    );
  }
  shader.vertexShader = vs;
  shader.fragmentShader = fs;
  return ok;
}

export function createGarmentUniforms(
  wrinkleMap: Texture | null,
  uvMetersPerTile: number,
  wrinkleTileMeters = 0.35,
): GarmentShaderUniforms {
  return {
    uExposure: { value: 1 },
    uLightTint: { value: new Vector3(1, 1, 1) },
    uBakedAoStrength: { value: 1 },
    uWrinkleMap: { value: wrinkleMap },
    uWrinkleStrength: { value: wrinkleMap ? 1 : 0 },
    uWrinkleUvScale: { value: uvMetersPerTile / wrinkleTileMeters },
  };
}

/** Fallback 1×1 (normal plana) para que el sampler del shader siempre esté ligado aunque no haya mapa de arrugas. */
let blankNormal: Texture | null = null;
export function blankNormalTexture(): Texture {
  blankNormal ??= makeDataTexture(new Uint8Array([128, 128, 255, 255]), 1);
  return blankNormal;
}

function fabricRepeat(g: GarmentGeometry, tileMeters: number): number {
  return tileMeters > 0 ? g.uvMetersPerTile / tileMeters : 1;
}

/**
 * Crea un material por slot presente en la geometría. Principal/ribete: MeshPhysicalMaterial con
 * albedo, normal, ORM (aoMap/roughnessMap/metalnessMap leen R/G/B del mismo mapa), sheen según la
 * familia, clearcoat en cuero, anisotropía en satén y repetición por escala física.
 */
export function createGarmentMaterials(
  garment: LoadedGarment,
  opts: GarmentMaterialOptions,
): GarmentMaterials {
  const { geometry, item, textures } = garment;
  const wrinkleMap = opts.wrinkleMap;
  const uniforms = createGarmentUniforms(
    wrinkleMap ?? blankNormalTexture(),
    geometry.uvMetersPerTile,
    opts.wrinkleTileMeters,
  );
  const flags: PatchFlags = { mirrorToneMap: opts.mirrorToneMap, wrinkles: wrinkleMap !== null };
  const gpu: FabricGpuTextures[] = [];
  const slotsPresent: MaterialSlot[] = MATERIAL_SLOTS.filter((s) =>
    geometry.groups.some((gr) => gr.slot === s),
  );
  if (slotsPresent.length === 0) slotsPresent.push('main');

  const makeFabricMaterial = (slot: MaterialSlot): MeshPhysicalMaterial => {
    const useTrim = slot === 'trim' && textures.trim !== undefined;
    const set = useTrim ? textures.trim! : textures.main;
    const fabric = useTrim && item.trimFabric ? item.trimFabric : item.fabric;
    const look = lookFor(fabric);
    const tex = acquireFabricTextures(set, {
      repeat: fabricRepeat(geometry, set.tileMeters),
      anisotropy: opts.anisotropy ?? 8,
    });
    gpu.push(tex);
    const m = new MeshPhysicalMaterial({
      map: tex.albedo,
      normalMap: tex.normal,
      aoMap: tex.orm,
      roughnessMap: tex.orm,
      metalnessMap: tex.orm,
      roughness: 1,
      metalness: 1,
      side: DoubleSide,
      transparent: opts.fadeable,
    });
    m.normalScale.set(look.normalScale, look.normalScale);
    m.specularIntensity = look.specularIntensity;
    m.sheen = look.sheen;
    m.sheenRoughness = look.sheenRoughness;
    m.sheenColor = new Color(item.variant.color).lerp(new Color(1, 1, 1), 1 - look.sheenTint);
    m.clearcoat = look.clearcoat;
    m.clearcoatRoughness = look.clearcoatRoughness;
    if (look.anisotropy > 0) {
      m.anisotropy = look.anisotropy;
      m.anisotropyRotation = Math.PI / 2;
    }
    if (slot === 'lining') {
      m.color.setScalar(0.75);
      m.normalScale.multiplyScalar(0.6);
    }
    m.customProgramCacheKey = () =>
      `garment|${flags.mirrorToneMap ? 1 : 0}${flags.wrinkles ? 1 : 0}|${look.anisotropy > 0 ? 'an' : ''}|${look.clearcoat > 0 ? 'cc' : ''}|${look.sheen > 0 ? 'sh' : ''}`;
    m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      const ok = patchGarmentShader(shader, uniforms, flags);
      if (!ok) console.warn('[mirror] no se pudo parchear por completo el shader de la prenda');
    };
    m.name = `garment-${slot}`;
    return m;
  };

  const materials: Material[] = slotsPresent.map((slot) => {
    if (slot === 'hardware') {
      const m = new MeshStandardMaterial({
        color: 0xb9b6ae,
        metalness: 0.9,
        roughness: 0.32,
        side: DoubleSide,
        transparent: opts.fadeable,
      });
      m.name = 'garment-hardware';
      return m;
    }
    return makeFabricMaterial(slot);
  });

  return {
    materials,
    uniforms,
    indexOfSlot(slot) {
      const i = slotsPresent.indexOf(slot);
      return i >= 0 ? i : 0;
    },
    setOpacity(opacity) {
      const o = Math.min(1, Math.max(0, opacity));
      for (const m of materials) m.opacity = o;
    },
    dispose() {
      for (const m of materials) m.dispose();
      for (const t of gpu) t.dispose();
      gpu.length = 0;
    },
  };
}
