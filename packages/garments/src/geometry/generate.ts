import {
  JOINT_COUNT,
  type BodyModel,
  type BodyRegion,
  type GarmentDefinition,
  type GarmentGeometry,
  type GarmentSlot,
} from '@fitroom/shared';
import { getBodyField, type BodyField } from './core/bodyField.js';
import { GarmentMesh, NF } from './core/mesh.js';
import { emitMesh, type Emitted } from './core/emit.js';
import { buildAdjacency, pushOutAndSpread, smoothBand, smoothSurfaceRows, type Adjacency } from './core/relax.js';
import { computeNodeSkin } from './core/skin.js';
import { bakeNodeAo } from './core/ao.js';
import { paintCloth } from './core/cloth.js';
import { GarmentGeometryError } from './errors.js';
import { fabricHintFor, resolveSize, type FabricHint } from './plan.js';
import { buildTop, planTop } from './builders/top.js';
import { buildBottom, planBottom } from './builders/bottom.js';

/** Metadatos de construcción que acompañan a la geometría (para métricas y para el solver de tela). */
export interface GarmentBuildInfo {
  readonly template: string;
  readonly fabric: FabricHint;
  /** espesor nominal de la tela (m) */
  readonly thickness: number;
  /** holgura mínima exigida al cuerpo (m) = espesor/2 + 1 mm */
  readonly clearance: number;
  /** vértices que son el mismo punto físico (mismo valor = soldados); para el solver de tela */
  readonly weldIds: Uint32Array;
  /** puntos de referencia (índices de vértice) para medir */
  readonly landmarks: Readonly<Record<string, number>>;
  /** parámetros de ajuste del solver derivados de la tela inferida */
  readonly clothTuning: ClothTuning;
}

export interface ClothTuning {
  /** 0..1 */
  readonly stiffness: number;
  readonly damping: number;
}

export type GarmentGeometryEx = GarmentGeometry & { readonly info: GarmentBuildInfo };

const TOP_TEMPLATES = new Set(['tee', 'long_sleeve', 'tank', 'polo', 'shirt', 'sweater', 'hoodie', 'blazer', 'jacket', 'coat']);
const BOTTOM_TEMPLATES = new Set(['jeans', 'chinos', 'shorts']);

function regionsFor(def: GarmentDefinition, hasSleeves: boolean): BodyRegion[] {
  if (BOTTOM_TEMPLATES.has(def.template)) return ['pelvis', 'l_leg', 'r_leg'];
  const r: BodyRegion[] = ['torso', 'pelvis'];
  if (hasSleeves) r.push('l_arm', 'r_arm');
  return r;
}

export function slotOf(def: GarmentDefinition): GarmentSlot {
  return def.slot;
}

/** Genera la geometría de una prenda (sin caché). Lanza `GarmentGeometryError` si los datos no son válidos. */
export function generateGarmentUncached(
  def: GarmentDefinition,
  sizeLabel: string,
  body: BodyModel,
): GarmentGeometryEx {
  const { spec } = resolveSize(def, sizeLabel);
  if (!body || !body.mesh || body.mesh.positions.length < 300) {
    throw new GarmentGeometryError('invalid-body', 'el cuerpo no tiene malla');
  }
  const field = getBodyField(body);
  const mesh = new GarmentMesh();
  const hint = fabricHintFor(def.fabricId);
  let hasSleeves = false;
  let anchorRows: () => void = () => undefined;
  let preSmooth: () => void = () => undefined;
  let clothCap = 0.1;
  let clothRamp = 0.25;
  let smoothSeeds: number[] = [];
  const landmarks: Record<string, number> = {};

  if (TOP_TEMPLATES.has(def.template)) {
    const plan = planTop(def, spec, body, field);
    const tb = buildTop(def, spec, body, field, mesh, plan);
    hasSleeves = tb.sleeves.length > 0;
    smoothSeeds = tb.loops.flat();
    preSmooth = () => {
      const fixed = new Set<number>(tb.loops.flat());
      smoothSurfaceRows(mesh, tb.torso, 0, tb.rowA, 10, 0.5, fixed);
    };
    anchorRows = () => {
      const s = tb.torso;
      for (let r = tb.rowB + 1; r < s.rows; r++)
        for (let c = 0; c < s.cols; c++) {
          const n = s.node[r * s.cols + c]!;
          if (n >= 0) mesh.flags[n] = mesh.flags[n]! | NF.anchor;
        }
    };
    clothCap = def.template === 'coat' ? 0.2 : 0.11;
  } else if (BOTTOM_TEMPLATES.has(def.template)) {
    const plan = planBottom(def, spec, body, field);
    const bb = buildBottom(def, spec, body, field, mesh, plan);
    preSmooth = () => {
      const fixed = new Set<number>();
      smoothSurfaceRows(mesh, bb.hip, 0, bb.rowSplit, 10, 0.5, fixed);
      for (const l of bb.legs) smoothSurfaceRows(mesh, l, 0, l.rows - 1, 8, 0.5, fixed);
    };
    anchorRows = () => {
      const s = bb.hip;
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < s.cols; c++) {
          const n = s.node[r * s.cols + c]!;
          if (n >= 0) mesh.flags[n] = mesh.flags[n]! | NF.anchor;
        }
    };
    clothCap = 0.09;
    clothRamp = 0.3;
  } else {
    throw new GarmentGeometryError('unsupported-template', `plantilla «${def.template}» sin generador todavía`);
  }

  preSmooth();
  const adj: Adjacency = buildAdjacency(mesh);
  if (smoothSeeds.length) smoothBand(mesh, adj, smoothSeeds, 8, 6, 0.6);
  pushOutAndSpread(mesh, field, adj);
  anchorRows();

  const em: Emitted = emitMesh(mesh, field);
  const nV = em.positions.length / 3;
  // atributos por nodo → por vértice
  const nodeNormals = new Float32Array(mesh.nodeCount * 3);
  for (let v = 0; v < nV; v++) {
    const n = em.vertNode[v]!;
    nodeNormals[n * 3] = em.normals[v * 3]!;
    nodeNormals[n * 3 + 1] = em.normals[v * 3 + 1]!;
    nodeNormals[n * 3 + 2] = em.normals[v * 3 + 2]!;
  }
  const skin = computeNodeSkin(field, mesh, adj);
  const aoNode = bakeNodeAo(field, mesh, adj, nodeNormals);
  const cloth = paintCloth(field, mesh, adj, { cap: clothCap, ramp: clothRamp });
  const skinIndices = new Uint16Array(nV * 4);
  const skinWeights = new Float32Array(nV * 4);
  const ao = new Float32Array(nV);
  const maxDistance = new Float32Array(nV);
  const invMass = new Float32Array(nV);
  for (let v = 0; v < nV; v++) {
    const n = em.vertNode[v]!;
    for (let k = 0; k < 4; k++) {
      skinIndices[v * 4 + k] = skin.indices[n * 4 + k]!;
      skinWeights[v * 4 + k] = skin.weights[n * 4 + k]!;
    }
    ao[v] = aoNode[n]!;
    maxDistance[v] = cloth.maxDistance[n]!;
    invMass[v] = cloth.invMass[n]!;
  }
  void JOINT_COUNT;
  const geometry: GarmentGeometry = {
    garmentId: def.id,
    sizeLabel,
    slot: slotOf(def),
    mesh: {
      positions: em.positions,
      normals: em.normals,
      uvs: em.uvs,
      indices: em.indices,
      skinIndices,
      skinWeights,
    },
    groups: em.groups,
    cloth: { maxDistance, invMass, stiffness: hint.stiffness, damping: 0.05 + 0.1 * (1 - hint.drape) },
    ao,
    coversRegions: regionsFor(def, hasSleeves),
    uvMetersPerTile: 1,
  };
  const info: GarmentBuildInfo = {
    template: def.template,
    fabric: hint,
    thickness: hint.thickness,
    clearance: hint.thickness / 2 + 0.001,
    weldIds: em.vertNode,
    landmarks,
    clothTuning: { stiffness: hint.stiffness, damping: 0.05 + 0.1 * (1 - hint.drape) },
  };
  return Object.assign(geometry, { info });
}

export type { BodyField };
