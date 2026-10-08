import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  FrontSide,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Material,
} from 'three';
import { skinPositions, triangleCount, type BodyModel } from '@fitroom/shared';
import { computeNormalsInto } from './meshMath';

export type BodyLook = 'mannequin' | 'ghost' | 'occluder';

/**
 * Cuerpo del usuario skinneado en CPU. Según `look`:
 *  - 'occluder': invisible, sólo escribe profundidad (oculta lo que queda "detrás" del cuerpo);
 *  - 'mannequin': maniquí mate de atelier;
 *  - 'ghost': translúcido.
 * El oclusor no necesita normales (se omiten); los otros las recalculan al cambiar de pose.
 */
export class BodyRig {
  readonly mesh: Mesh;
  readonly geometry: BufferGeometry;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly nrmAttr: BufferAttribute;
  private material: Material;
  private _look: BodyLook;
  private needsNormals: boolean;
  readonly triangles: number;

  constructor(
    private readonly body: BodyModel,
    look: BodyLook,
  ) {
    const m = body.mesh;
    this.positions = new Float32Array(m.positions);
    this.normals = new Float32Array(m.normals);
    this.geometry = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.nrmAttr = new BufferAttribute(this.normals, 3).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('normal', this.nrmAttr);
    this.geometry.setIndex(new BufferAttribute(m.indices, 1));
    this.triangles = triangleCount(m);
    this._look = look;
    this.needsNormals = look !== 'occluder';
    this.material = makeBodyMaterial(look);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = `body-${look}`;
    applyLookToMesh(this.mesh, look);
  }

  get look(): BodyLook {
    return this._look;
  }

  setLook(look: BodyLook): void {
    if (look === this._look) return;
    this._look = look;
    this.material.dispose();
    this.material = makeBodyMaterial(look);
    this.mesh.material = this.material;
    applyLookToMesh(this.mesh, look);
    this.mesh.name = `body-${look}`;
    this.needsNormals = look !== 'occluder';
  }

  /** Skinning del cuerpo con las matrices del fotograma (16 floats por joint). */
  update(skinMatrices: Float32Array): void {
    const m = this.body.mesh;
    skinPositions(m.positions, m.skinIndices, m.skinWeights, skinMatrices, this.positions);
    this.posAttr.needsUpdate = true;
    if (this.needsNormals) {
      computeNormalsInto(this.positions, m.indices, this.normals);
      this.nrmAttr.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function makeBodyMaterial(look: BodyLook): Material {
  switch (look) {
    case 'occluder': {
      const m = new MeshBasicMaterial({
        colorWrite: false,
        depthWrite: true,
        side: FrontSide,
        // empuja el oclusor ligeramente hacia atrás: donde la tela roza la piel gana la tela (sin z-fighting)
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 4,
      });
      m.name = 'body-occluder';
      return m;
    }
    case 'ghost': {
      const m = new MeshStandardMaterial({
        color: 0xa9c1ff,
        roughness: 0.4,
        metalness: 0,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: DoubleSide,
        emissive: 0x2a3866,
        emissiveIntensity: 0.6,
      });
      m.name = 'body-ghost';
      return m;
    }
    default: {
      const m = new MeshStandardMaterial({
        color: 0xd9d3c9,
        roughness: 0.82,
        metalness: 0,
        side: FrontSide,
      });
      m.name = 'body-mannequin';
      return m;
    }
  }
}

function applyLookToMesh(mesh: Mesh, look: BodyLook): void {
  if (look === 'occluder') {
    mesh.renderOrder = -10; // antes que las prendas
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  } else {
    mesh.renderOrder = 0;
    mesh.castShadow = look === 'mannequin';
    mesh.receiveShadow = look === 'mannequin';
  }
}
