import {
  BODY_REGIONS,
  J,
  JOINT_COUNT,
  validateMesh,
  MEASUREMENT_KEYS,
  MeasurementsSchema,
  REST_BONE_DIRECTIONS,
  computeVertexNormals,
  type BodyModel,
  type Measurements,
  type SkinnedMeshData,
} from '@fitroom/shared';
import { BodyInputError } from './errors.js';
import { deriveDims, type BodyDims } from './dims.js';
import { calibrateField } from './calibrate.js';
import { buildField, type BodyField } from './field.js';
import { fitColliders } from './colliders.js';
import { correctGirths } from './refine.js';
import { computeSkin } from './skin.js';
import { sampleFieldSteps, surfaceNets, type GridSpec } from './surface.js';
import {
  adjacencyIsClosed,
  buildAdjacency,
  type Adjacency,
  keepLargestComponent,
  repairLabeling,
  taubinSmooth,
} from './meshops.js';

/** Relación máxima/mínima entrepierna/estatura para la que el esqueleto canónico es físicamente posible. */
export const INSEAM_RATIO_RANGE: readonly [number, number] = [0.3, 0.52];

/** Nº de vértices objetivo de la malla (≈ 10 mm de paso para un adulto medio). */
const TARGET_VERTICES = 24000;
const GRID_MARGIN = 3;
/** Factores del paso de rejilla en los reintentos de seguridad (el primero es el normal). */
const RETRY_SCALES: readonly number[] = [1, 1.0173, 0.9831, 1.0411];

/** Valida con zod y comprueba la viabilidad del esqueleto. Lanza `BodyInputError`; nunca sanea en silencio. */
export function validateBuildInput(input: unknown): Measurements {
  const parsed = MeasurementsSchema.safeParse(input);
  if (!parsed.success) {
    throw new BodyInputError(
      'invalid-measurements',
      'las medidas no cumplen MeasurementsSchema',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const m = parsed.data;
  const ratio = m.inseamCm / m.heightCm;
  if (!(ratio >= INSEAM_RATIO_RANGE[0] && ratio <= INSEAM_RATIO_RANGE[1])) {
    throw new BodyInputError(
      'skeleton-infeasible',
      `entrepierna/estatura = ${ratio.toFixed(3)} fuera de [${INSEAM_RATIO_RANGE[0]}, ${INSEAM_RATIO_RANGE[1]}]: el esqueleto canónico no cabe en esa estatura`,
      [{ path: 'inseamCm', message: 'entrepierna incompatible con la estatura' }],
      ['inseamCm', 'heightCm'],
    );
  }
  return m;
}

/** Clave canónica de caché de unas medidas (determinista). */
export function measurementsKey(m: Measurements): string {
  return MEASUREMENT_KEYS.map((k) => String(m[k])).join('|') + '|' + m.bodyBase;
}

/**
 * Paso de la rejilla (m): se elige para que la malla tenga ≈ TARGET_VERTICES vértices con cualquier talla y
 * complexión (la superficie crece con la estatura y el perímetro medio del tronco).
 */
export function gridStep(dims: BodyDims): number {
  const area = 1.12 * dims.H * ((dims.chestC + dims.waistC + dims.hipC) / 3);
  const h = Math.sqrt((1.42 * area) / TARGET_VERTICES);
  return Math.min(Math.max(h, dims.H / 230), dims.H / 140);
}

export function gridSpecFor(field: BodyField, h: number): GridSpec {
  const b = field.bounds;
  const pad = 0.12 - 0.035;
  const minX = b[0]! + pad;
  const maxX = b[3]! - pad;
  const maxY = b[4]! - pad;
  const minZ = b[2]! + pad;
  const maxZ = b[5]! - pad;
  const nxHalf = Math.ceil(Math.max(Math.abs(minX), Math.abs(maxX)) / h) + GRID_MARGIN;
  const oy = (-GRID_MARGIN - 0.5) * h;
  return {
    ox: -nxHalf * h,
    oy,
    oz: minZ - GRID_MARGIN * h,
    h,
    nx: 2 * nxHalf + 1,
    ny: Math.ceil((maxY - oy) / h) + GRID_MARGIN,
    nz: Math.ceil((maxZ - minZ) / h) + 2 * GRID_MARGIN,
  };
}

const REGION_INDEX: Readonly<Record<(typeof BODY_REGIONS)[number], number>> = Object.fromEntries(
  BODY_REGIONS.map((r, i) => [r, i]),
) as Record<(typeof BODY_REGIONS)[number], number>;

/** Región anatómica de un vértice a partir del joint dominante y de su altura. */
export function regionOf(joint: number, y: number, crotchY: number): number {
  switch (joint) {
    case J.head:
      return REGION_INDEX.head;
    case J.neck:
      return REGION_INDEX.neck;
    case J.pelvis:
      return REGION_INDEX.pelvis;
    case J.spine:
    case J.chest:
    case J.l_clavicle:
    case J.r_clavicle:
      return REGION_INDEX.torso;
    case J.l_upper_arm:
    case J.l_forearm:
      return REGION_INDEX.l_arm;
    case J.r_upper_arm:
    case J.r_forearm:
      return REGION_INDEX.r_arm;
    case J.l_hand:
      return REGION_INDEX.l_hand;
    case J.r_hand:
      return REGION_INDEX.r_hand;
    case J.l_thigh:
      return y > crotchY ? REGION_INDEX.pelvis : REGION_INDEX.l_leg;
    case J.r_thigh:
      return y > crotchY ? REGION_INDEX.pelvis : REGION_INDEX.r_leg;
    case J.l_calf:
      return REGION_INDEX.l_leg;
    case J.r_calf:
      return REGION_INDEX.r_leg;
    case J.l_foot:
    case J.l_toes:
      return REGION_INDEX.l_foot;
    case J.r_foot:
    case J.r_toes:
      return REGION_INDEX.r_foot;
    default:
      return REGION_INDEX.torso;
  }
}

/**
 * Constructor por pasos: cada `yield` es un punto donde `buildBodyAsync` cede el control al bucle de eventos.
 * `buildBodyUncached` lo ejecuta de un tirón. Determinista: sin aleatoriedad ni dependencia del reloj.
 */
export function* buildSteps(
  input: unknown,
  onPhase?: (name: string, ms: number) => void,
): Generator<void, BodyModel, void> {
  let t0 = onPhase ? performance.now() : 0;
  const tick = (name: string): void => {
    if (!onPhase) return;
    const t = performance.now();
    onPhase(name, t - t0);
    t0 = t;
  };
  const m = validateBuildInput(input);
  const dims: BodyDims = deriveDims(m);
  const { cal } = calibrateField(dims);
  tick('calibrate');
  yield;
  const field = buildField(dims, cal);
  const spec = gridSpecFor(field, gridStep(dims));
  // La rejilla se genera con reintentos de seguridad: si (muy improbable) el resultado no fuese una malla cerrada
  // 2-manifold, se vuelve a mallar con un paso ligeramente distinto en lugar de entregar geometría defectuosa.
  const h0 = gridStep(dims);
  let positions!: Float32Array;
  let indices!: Uint32Array;
  let adj!: Adjacency;
  let ok = false;
  for (let attempt = 0; attempt < RETRY_SCALES.length && !ok; attempt++) {
    const spec = gridSpecFor(field, h0 * RETRY_SCALES[attempt]!);
    const grid = yield* sampleFieldSteps(spec, field);
    tick('sample');
    repairLabeling(spec, grid);
    tick('repair');
    yield;
    const raw = surfaceNets(spec, grid);
    tick('nets');
    const comp = keepLargestComponent(raw.positions, raw.indices);
    positions = comp.positions;
    indices = comp.indices;
    adj = buildAdjacency(positions.length / 3, indices);
    tick('component+adjacency');
    ok = adjacencyIsClosed(positions.length / 3, adj);
  }
  if (!ok) throw new BodyInputError('internal', 'la malla generada no es cerrada/manifold');
  const nv = positions.length / 3;
  taubinSmooth(positions, adj, 5);
  tick('smooth');
  yield;
  // suelo exacto, y coronilla = estatura
  let maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    if (positions[i]! < 0) positions[i] = 0;
    if (positions[i]! > maxY) maxY = positions[i]!;
  }
  const dTop = dims.H - maxY;
  const y0 = 0.86 * dims.H;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i]!;
    if (y > y0) {
      const t = Math.min((y - y0) / (dims.H - y0), 1);
      positions[i] = y + dTop * t * t * (3 - 2 * t);
    }
  }
  const skin = computeSkin(field, positions, adj);
  tick('skin');
  yield;
  const dominant = new Uint8Array(nv);
  const regions = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) dominant[v] = skin.indices[v * 4]!;
  correctGirths(dims, positions, indices, dominant);
  tick('girth-correction');
  const normals = computeVertexNormals(positions, indices);
  tick('normals');
  for (let v = 0; v < nv; v++) regions[v] = regionOf(dominant[v]!, positions[v * 3 + 1]!, dims.lm.crotch);
  const handLen = dims.rest.joints[J.l_hand]!.boneLength;
  const colliders = fitColliders(
    dims.P,
    dims.H,
    handLen,
    (side) => REST_BONE_DIRECTIONS[side === 1 ? J.l_hand : J.r_hand]!,
    positions,
    dominant,
  );
  const mesh: SkinnedMeshData = {
    positions,
    normals,
    indices,
    skinIndices: skin.indices,
    skinWeights: skin.weights,
  };
  tick('colliders');
  const issues = validateMesh(mesh, JOINT_COUNT);
  tick('topology');
  if (issues.length > 0) {
    throw new BodyInputError(
      'internal',
      `validateMesh: ${issues.map((i) => `${i.code} ${i.detail}`).join('; ')}`,
    );
  }
  return {
    measurements: m,
    skeleton: dims.rest,
    mesh,
    regions,
    colliders,
  };
}

export function buildBodyUncached(input: unknown): BodyModel {
  const g = buildSteps(input);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}
