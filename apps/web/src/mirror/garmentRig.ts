import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Mesh,
  type Material,
  type Texture,
} from 'three';
import {
  NotImplementedError,
  skinPositions,
  triangleCount,
  type ClothSolver,
  type GarmentGeometry,
  type WorldCapsule,
} from '@fitroom/shared';
import { createClothSolver } from '@fitroom/garments';
import type { LoadedGarment } from '../contracts';
import { computeNormalsInto, offsetAlongNormals, sanitizePositions } from './meshMath';
import { createGarmentMaterials, type GarmentMaterials } from './garmentMaterial';
import type { Quality, RigTimings } from './types';
import { SIMULATE_BY_QUALITY } from './types';

export interface GarmentRigOptions {
  readonly quality: Quality;
  /** Render dentro del espejo (RenderTarget): tone mapping propio y materiales desvanecibles. */
  readonly mirror: boolean;
  readonly wrinkleMap: Texture | null;
  /** Desplazamiento (m) hacia fuera a lo largo de la normal: separa capas (exterior sobre interior). */
  readonly layerOffsetM?: number;
  readonly renderOrder?: number;
  /** Fábrica del solver (inyectable en tests; por defecto el real de @fitroom/garments). */
  readonly createSolver?: (g: GarmentGeometry) => ClothSolver;
  readonly castShadow?: boolean;
}

let defaultSolverFactory: ((g: GarmentGeometry) => ClothSolver) | null = null;

/** Sólo para pruebas/arnés: sustituye la fábrica de solver por defecto (null = la real de @fitroom/garments). */
export function setDefaultSolverFactory(f: ((g: GarmentGeometry) => ClothSolver) | null): void {
  defaultSolverFactory = f;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Prenda skinneada en CPU + (opcional) solver de tela + normales, volcada a un BufferGeometry.
 * Todos los buffers se reservan en el constructor: `update()` no asigna memoria.
 */
export class GarmentRig {
  readonly mesh: Mesh;
  readonly geometry: BufferGeometry;
  materials: GarmentMaterials;
  garment: LoadedGarment;
  readonly triangles: number;
  readonly vertexCount: number;
  readonly timings: RigTimings = { skinMs: 0, clothMs: 0 };

  private readonly src: GarmentGeometry;
  private readonly skinned: Float32Array;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly wrinkle: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly nrmAttr: BufferAttribute;
  private readonly wrAttr: BufferAttribute;
  private solver: ClothSolver | null = null;
  private solverTried = false;
  private wasSimulating = false;
  private readonly layerOffset: number;
  private readonly createSolver: (g: GarmentGeometry) => ClothSolver;
  private disposed = false;
  private opacity = 1;

  constructor(
    garment: LoadedGarment,
    private readonly opts: GarmentRigOptions,
  ) {
    this.garment = garment;
    const g = garment.geometry;
    this.src = g;
    const m = g.mesh;
    const n = m.positions.length / 3;
    this.vertexCount = n;
    this.triangles = triangleCount(m);
    this.skinned = new Float32Array(m.positions);
    this.positions = new Float32Array(m.positions);
    this.normals = new Float32Array(m.normals);
    this.wrinkle = new Float32Array(n);
    this.layerOffset = opts.layerOffsetM ?? 0;
    this.createSolver = opts.createSolver ?? defaultSolverFactory ?? createClothSolver;

    this.geometry = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.nrmAttr = new BufferAttribute(this.normals, 3).setUsage(DynamicDrawUsage);
    this.wrAttr = new BufferAttribute(this.wrinkle, 1).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('normal', this.nrmAttr);
    this.geometry.setAttribute('uv', new BufferAttribute(m.uvs, 2));
    this.geometry.setAttribute('aBakedAo', new BufferAttribute(g.ao, 1));
    this.geometry.setAttribute('aWrinkle', this.wrAttr);
    this.geometry.setIndex(new BufferAttribute(m.indices, 1));

    this.materials = createGarmentMaterials(garment, {
      mirrorToneMap: opts.mirror,
      fadeable: opts.mirror,
      wrinkleMap: opts.wrinkleMap,
    });
    if (g.groups.length === 0) {
      this.geometry.addGroup(0, m.indices.length, this.materials.indexOfSlot('main'));
    } else {
      for (const gr of g.groups) {
        this.geometry.addGroup(gr.start, gr.count, this.materials.indexOfSlot(gr.slot));
      }
    }
    this.mesh = new Mesh(this.geometry, this.materials.materials as Material[]);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 10;
    this.mesh.castShadow = opts.castShadow ?? false;
    this.mesh.name = `garment-${garment.item.garment.id}`;
  }

  /** ¿Hay un solver de tela real funcionando para esta prenda? */
  get hasSolver(): boolean {
    return this.solver !== null;
  }

  get simulationAvailable(): boolean {
    this.ensureSolver();
    return this.solver !== null;
  }

  private ensureSolver(): void {
    if (this.solverTried) return;
    this.solverTried = true;
    try {
      this.solver = this.createSolver(this.src);
    } catch (err) {
      this.solver = null;
      if (!(err instanceof NotImplementedError)) {
        console.warn('[mirror] solver de tela no disponible; se usa sólo skinning', err);
      }
    }
  }

  /** Descarta el estado dinámico del solver (cambio de prenda, pérdida de seguimiento, salto de pose). */
  resetSimulation(): void {
    this.solver?.reset();
  }

  /**
   * @param skinMatrices matrices de skinning del fotograma (16 floats por joint)
   * @param capsules colisionadores del cuerpo en mundo (los usa el solver)
   * @param dtSeconds tiempo real desde el fotograma anterior
   * @param simulate ¿simular tela? (si no, sólo skinning)
   */
  update(
    skinMatrices: Float32Array,
    capsules: readonly WorldCapsule[],
    dtSeconds: number,
    simulate: boolean,
  ): void {
    const m = this.src.mesh;
    const t0 = now();
    skinPositions(m.positions, m.skinIndices, m.skinWeights, skinMatrices, this.skinned);
    const t1 = now();

    const wantSim = simulate && SIMULATE_BY_QUALITY[this.opts.quality];
    if (wantSim) this.ensureSolver();
    const solver = wantSim ? this.solver : null;
    if (solver) {
      if (!this.wasSimulating) solver.reset();
      solver.step(dtSeconds, this.skinned, capsules, this.positions);
      // la tela inestable jamás debe llegar a la GPU: se reemplaza lo no finito por la pose skinneada
      sanitizePositions(this.positions, this.skinned);
      const w = solver.wrinkle;
      if (w.length === this.wrinkle.length) this.wrinkle.set(w);
      this.wrAttr.needsUpdate = true;
    } else {
      this.positions.set(this.skinned);
      if (this.wasSimulating) {
        this.wrinkle.fill(0);
        this.wrAttr.needsUpdate = true;
      }
    }
    this.wasSimulating = solver !== null;

    computeNormalsInto(this.positions, m.indices, this.normals);
    if (this.layerOffset !== 0) offsetAlongNormals(this.positions, this.normals, this.layerOffset);
    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
    const t2 = now();
    this.timings.skinMs = t1 - t0;
    this.timings.clothMs = t2 - t1;
  }

  /**
   * Cambia sólo las texturas/materiales (otra muestra de color, otra resolución) conservando la
   * geometría, los buffers y el solver. La geometría de `garment` debe ser la misma.
   */
  retexture(garment: LoadedGarment): void {
    if (this.disposed || garment.geometry !== this.src) {
      throw new Error('retexture: la geometría debe ser la misma');
    }
    const old = this.materials;
    const next = createGarmentMaterials(garment, {
      mirrorToneMap: this.opts.mirror,
      fadeable: this.opts.mirror,
      wrinkleMap: this.opts.wrinkleMap,
    });
    next.uniforms.uExposure.value = old.uniforms.uExposure.value;
    next.uniforms.uLightTint.value.copy(old.uniforms.uLightTint.value);
    next.setOpacity(this.opacity);
    this.materials = next;
    this.mesh.material = next.materials as Material[];
    this.garment = garment;
    old.dispose();
  }

  setOpacity(opacity: number): void {
    this.opacity = Math.min(1, Math.max(0, opacity));
    this.materials.setOpacity(opacity);
    this.mesh.visible = opacity > 0.002;
  }

  /** Environment de respaldo (vitrinas fuera del espejo cuando la escena no tiene el suyo). */
  setEnvMap(env: Texture | null): void {
    for (const m of this.materials.materials) {
      const mm = m as Material & { envMap?: Texture | null; envMapIntensity?: number };
      mm.envMap = env;
      mm.envMapIntensity = 1;
      mm.needsUpdate = true;
    }
  }

  setLight(exposure: number, tint: readonly [number, number, number]): void {
    const u = this.materials.uniforms;
    u.uExposure.value = exposure;
    u.uLightTint.value.set(tint[0], tint[1], tint[2]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.materials.dispose();
  }
}
