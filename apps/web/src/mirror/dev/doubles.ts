/**
 * DOBLES DE DESARROLLO/PRUEBA de MIRROR. No se importan desde código de producción (sólo tests y el
 * arnés `mirror-harness.html`). Sustituyen a body/garments mientras los paquetes reales no existen y
 * sirven como fixtures deterministas para las pruebas del espejo:
 *   - doubleBody: cuerpo de tubos elípticos skinneado al esqueleto canónico (+ colisionadores);
 *   - doubleTee: camiseta de tubos con UV en metros, AO y skinning copiado del cuerpo más cercano;
 *   - SpringSolver: «tela» de muelle amortiguado con la interfaz de ClothSolver;
 *   - doubleTextures: textura de tejido de sarga procedural;
 *   - scriptedPose: guion A-pose → brazos arriba → giro → sentado.
 */
import {
  BODY_REGIONS,
  J,
  JOINT_COUNT,
  buildRestSkeleton,
  cmToM,
  computeVertexNormals,
  q,
  restPose,
  type BodyModel,
  type CapsuleCollider,
  type ClothSolver,
  type FabricDef,
  type FabricTextureSet,
  type GarmentDefinition,
  type GarmentGeometry,
  type Measurements,
  type Quat,
  type RestSkeleton,
  type SkeletonPose,
  type SwatchVariant,
  type Vec3,
  type WorldCapsule,
} from '@fitroom/shared';
import type { EquippedItem, LoadedGarment } from '../../contracts';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- malla de tubos

interface Ring {
  /** centro (m) */
  c: Vec3;
  /** eje del tubo (unitario) en este anillo */
  axis: Vec3;
  /** semiejes de la elipse: ax a lo largo de +X del cuerpo, az a lo largo de +Z */
  ax: number;
  az: number;
  /** influencias de skinning (joint, peso) */
  skin: readonly (readonly [number, number])[];
}

interface Builder {
  positions: number[];
  indices: number[];
  skinIdx: number[];
  skinW: number[];
  regions: number[];
}

function newBuilder(): Builder {
  return { positions: [], indices: [], skinIdx: [], skinW: [], regions: [] };
}

/** Añade un tubo de anillos (abierto o con tapas) y devuelve el índice del primer vértice. */
function addTube(
  b: Builder,
  rings: readonly Ring[],
  segs: number,
  region: number,
  caps: boolean,
): number {
  const first = b.positions.length / 3;
  for (const r of rings) {
    // base ortonormal alrededor del eje: usamos X y Z del cuerpo (los tubos son casi verticales/diagonales)
    const axis = r.axis;
    let ex: Vec3 = [1, 0, 0];
    let ez: Vec3 = [0, 0, 1];
    // ortogonaliza respecto al eje (Gram-Schmidt) para tubos inclinados (brazos)
    const dx = axis[0] * ex[0] + axis[1] * ex[1] + axis[2] * ex[2];
    ex = [ex[0] - axis[0] * dx, ex[1] - axis[1] * dx, ex[2] - axis[2] * dx];
    let l = Math.hypot(ex[0], ex[1], ex[2]) || 1;
    ex = [ex[0] / l, ex[1] / l, ex[2] / l];
    ez = [
      axis[1] * ex[2] - axis[2] * ex[1],
      axis[2] * ex[0] - axis[0] * ex[2],
      axis[0] * ex[1] - axis[1] * ex[0],
    ];
    l = Math.hypot(ez[0], ez[1], ez[2]) || 1;
    ez = [ez[0] / l, ez[1] / l, ez[2] / l];
    // si ez apunta a −Z global, invierte para mantener +Z hacia delante
    if (ez[2] < 0) ez = [-ez[0], -ez[1], -ez[2]];
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * TAU;
      const cx = Math.cos(a) * r.ax;
      const cz = Math.sin(a) * r.az;
      b.positions.push(
        r.c[0] + ex[0] * cx + ez[0] * cz,
        r.c[1] + ex[1] * cx + ez[1] * cz,
        r.c[2] + ex[2] * cx + ez[2] * cz,
      );
      pushSkin(b, r.skin);
      b.regions.push(region);
    }
  }
  const n = rings.length;
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      const a = first + i * segs + s;
      const bb = first + i * segs + s1;
      const c = first + (i + 1) * segs + s;
      const d = first + (i + 1) * segs + s1;
      // CCW visto desde fuera para un tubo que avanza en +eje con el anillo recorrido de +X a +Z
      b.indices.push(a, c, bb, bb, c, d);
    }
  }
  if (caps) {
    for (const end of [0, n - 1]) {
      const r = rings[end]!;
      const ci = b.positions.length / 3;
      b.positions.push(r.c[0], r.c[1], r.c[2]);
      pushSkin(b, r.skin);
      b.regions.push(region);
      for (let s = 0; s < segs; s++) {
        const s1 = (s + 1) % segs;
        const a = first + end * segs + s;
        const bb = first + end * segs + s1;
        if (end === 0) b.indices.push(ci, bb, a);
        else b.indices.push(ci, a, bb);
      }
    }
  }
  return first;
}

function pushSkin(b: Builder, skin: readonly (readonly [number, number])[]): void {
  for (let k = 0; k < 4; k++) {
    const e = skin[k];
    b.skinIdx.push(e ? e[0] : 0);
    b.skinW.push(e ? e[1] : 0);
  }
}

const sub = (a: Vec3, c: Vec3): Vec3 => [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
const lerp3 = (a: Vec3, c: Vec3, t: number): Vec3 => [
  a[0] + (c[0] - a[0]) * t,
  a[1] + (c[1] - a[1]) * t,
  a[2] + (c[2] - a[2]) * t,
];
const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Tubo a lo largo de una cadena de joints con radios elípticos por articulación. */
function chainRings(
  rest: RestSkeleton,
  chain: readonly number[],
  radii: readonly (readonly [number, number])[],
  extraStart?: { offset: Vec3; r: readonly [number, number] },
  subdiv = 2,
): Ring[] {
  const pos = chain.map((j) => rest.joints[j]!.position);
  const rings: Ring[] = [];
  if (extraStart) {
    rings.push({
      c: [pos[0]![0] + extraStart.offset[0], pos[0]![1] + extraStart.offset[1], pos[0]![2] + extraStart.offset[2]],
      axis: norm3(sub(pos[1]!, pos[0]!)),
      ax: extraStart.r[0],
      az: extraStart.r[1],
      skin: [[chain[0]!, 1]],
    });
  }
  for (let i = 0; i < chain.length; i++) {
    const prev = pos[Math.max(0, i - 1)]!;
    const next = pos[Math.min(chain.length - 1, i + 1)]!;
    rings.push({
      c: pos[i]!,
      axis: norm3(sub(next, prev)),
      ax: radii[i]![0],
      az: radii[i]![1],
      skin: i === 0 ? [[chain[i]!, 1]] : [[chain[i]!, 0.6], [chain[i - 1]!, 0.4]],
    });
    if (i < chain.length - 1) {
      for (let s = 1; s <= subdiv; s++) {
        const t = s / (subdiv + 1);
        rings.push({
          c: lerp3(pos[i]!, pos[i + 1]!, t),
          axis: norm3(sub(pos[i + 1]!, pos[i]!)),
          ax: radii[i]![0] + (radii[i + 1]![0] - radii[i]![0]) * t,
          az: radii[i]![1] + (radii[i + 1]![1] - radii[i]![1]) * t,
          skin: [[chain[i]!, 1 - t * 0.7], [chain[i + 1]!, t * 0.7]],
        });
      }
    }
  }
  return rings;
}

const regionIndex = (name: (typeof BODY_REGIONS)[number]): number => BODY_REGIONS.indexOf(name);

/** Circunferencia (cm) → semieje medio (m). */
const rOf = (cm: number): number => cmToM(cm) / TAU;

// ---------------------------------------------------------------- cuerpo

export function doubleBody(m: Measurements): BodyModel {
  const rest = buildRestSkeleton(m);
  const H = rest.height;
  const b = newBuilder();
  const SEG = 14;
  const rc = rOf(m.chestCm);
  const rw = rOf(m.waistCm);
  const rh = rOf(m.hipCm);
  const shoulderHalf = cmToM(m.shoulderWidthCm) / 2;

  // torso: pelvis → spine → chest → neck
  const torsoRadii: [number, number][] = [
    [rh * 1.18, rh * 0.82],
    [rw * 1.15, rw * 0.78],
    [rc * 1.12, rc * 0.82],
    [Math.max(rc * 0.62, shoulderHalf * 0.55), 0.075],
  ];
  const torso = chainRings(rest, [J.pelvis, J.spine, J.chest, J.neck], torsoRadii, {
    offset: [0, -0.09 * H, 0],
    r: [rh * 1.1, rh * 0.8],
  });
  // hombros: anillo ancho a la altura de los hombros
  const sh = rest.joints[J.l_upper_arm]!.position;
  torso.splice(torso.length - 1, 0, {
    c: [0, sh[1] - 0.01, 0],
    axis: [0, 1, 0],
    ax: shoulderHalf * 1.02,
    az: rc * 0.78,
    skin: [[J.chest, 0.8], [J.neck, 0.2]],
  });
  addTube(b, torso, SEG, regionIndex('torso'), true);

  // cuello + cabeza
  const neck = rest.joints[J.neck]!.position;
  const head = rest.joints[J.head]!.position;
  addTube(
    b,
    [
      { c: neck, axis: [0, 1, 0], ax: 0.052, az: 0.05, skin: [[J.neck, 1]] },
      { c: head, axis: [0, 1, 0], ax: 0.05, az: 0.05, skin: [[J.head, 0.8], [J.neck, 0.2]] },
    ],
    SEG,
    regionIndex('neck'),
    false,
  );
  const headTop = H;
  const headRings: Ring[] = [];
  const hc: Vec3 = [head[0], (head[1] + headTop) / 2 + 0.01, head[2] + 0.008];
  const hr = (headTop - head[1]) * 0.62;
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    headRings.push({
      c: [hc[0], hc[1] - Math.cos(a) * hr * 1.15, hc[2]],
      axis: [0, 1, 0],
      ax: Math.max(0.004, Math.sin(a) * hr * 0.92),
      az: Math.max(0.004, Math.sin(a) * hr * 1.08),
      skin: [[J.head, 1]],
    });
  }
  addTube(b, headRings, SEG, regionIndex('head'), false);

  for (const side of ['l', 'r'] as const) {
    const S = side === 'l' ? 1 : -1;
    void S;
    const ids =
      side === 'l'
        ? { cl: J.l_clavicle, ua: J.l_upper_arm, fa: J.l_forearm, h: J.l_hand, th: J.l_thigh, ca: J.l_calf, ft: J.l_foot, to: J.l_toes }
        : { cl: J.r_clavicle, ua: J.r_upper_arm, fa: J.r_forearm, h: J.r_hand, th: J.r_thigh, ca: J.r_calf, ft: J.r_foot, to: J.r_toes };
    const ru = rOf(m.chestCm) * 0.34;
    const arm = chainRings(
      rest,
      [ids.ua, ids.fa, ids.h],
      [[ru, ru], [ru * 0.78, ru * 0.78], [ru * 0.55, ru * 0.4]],
      undefined,
      3,
    );
    // extremo de la mano
    const hp = rest.joints[ids.h]!.position;
    const handDir = norm3(sub(hp, rest.joints[ids.fa]!.position));
    arm.push({
      c: [hp[0] + handDir[0] * 0.09, hp[1] + handDir[1] * 0.09, hp[2] + handDir[2] * 0.09],
      axis: handDir,
      ax: ru * 0.3,
      az: ru * 0.2,
      skin: [[ids.h, 1]],
    });
    addTube(b, arm, 10, regionIndex(side === 'l' ? 'l_arm' : 'r_arm'), true);

    const rt = rOf(m.thighCm);
    const leg = chainRings(
      rest,
      [ids.th, ids.ca, ids.ft, ids.to],
      [[rt * 1.05, rt * 1.05], [rt * 0.7, rt * 0.7], [rt * 0.5, rt * 0.55], [rt * 0.45, rt * 0.3]],
      undefined,
      3,
    );
    addTube(b, leg, 10, regionIndex(side === 'l' ? 'l_leg' : 'r_leg'), true);
  }

  const positions = new Float32Array(b.positions);
  const indices = new Uint32Array(b.indices);
  const normals = computeVertexNormals(positions, indices);
  const colliders = doubleColliders(rest, m);
  return {
    measurements: m,
    skeleton: rest,
    mesh: {
      positions,
      normals,
      indices,
      skinIndices: new Uint16Array(b.skinIdx),
      skinWeights: normalizeWeights(new Float32Array(b.skinW)),
    },
    regions: new Uint8Array(b.regions),
    colliders,
  };
}

function normalizeWeights(w: Float32Array): Float32Array {
  for (let i = 0; i < w.length; i += 4) {
    const s = w[i]! + w[i + 1]! + w[i + 2]! + w[i + 3]!;
    if (s > 0) for (let k = 0; k < 4; k++) w[i + k] = w[i + k]! / s;
    else w[i] = 1;
  }
  return w;
}

function doubleColliders(rest: RestSkeleton, m: Measurements): CapsuleCollider[] {
  const rt = rOf(m.thighCm);
  const mk = (name: string, a: number, bj: number, radius: number): CapsuleCollider => ({
    name,
    jointA: a,
    jointB: bj,
    offsetA: [0, 0, 0],
    offsetB: [0, 0, 0],
    radius,
  });
  void rest;
  return [
    mk('torso', J.pelvis, J.chest, rOf(m.waistCm) * 1.05),
    mk('chest', J.chest, J.neck, rOf(m.chestCm) * 1.05),
    mk('l_upper_arm', J.l_upper_arm, J.l_forearm, rOf(m.chestCm) * 0.34),
    mk('l_forearm', J.l_forearm, J.l_hand, rOf(m.chestCm) * 0.27),
    mk('r_upper_arm', J.r_upper_arm, J.r_forearm, rOf(m.chestCm) * 0.34),
    mk('r_forearm', J.r_forearm, J.r_hand, rOf(m.chestCm) * 0.27),
    mk('l_thigh', J.l_thigh, J.l_calf, rt),
    mk('l_calf', J.l_calf, J.l_foot, rt * 0.65),
    mk('r_thigh', J.r_thigh, J.r_calf, rt),
    mk('r_calf', J.r_calf, J.r_foot, rt * 0.65),
  ];
}

/** Colisionadores en mundo (sustituye a `worldColliders` de @fitroom/body en las pruebas). */
export function doubleWorldColliders(
  body: BodyModel,
  skin: Float32Array,
  out: WorldCapsule[] = [],
): WorldCapsule[] {
  out.length = 0;
  const apply = (j: number, off: readonly [number, number, number]): [number, number, number] => {
    const rp = body.skeleton.joints[j]!.position;
    const x = rp[0] + off[0],
      y = rp[1] + off[1],
      z = rp[2] + off[2];
    const o = j * 16;
    return [
      skin[o]! * x + skin[o + 4]! * y + skin[o + 8]! * z + skin[o + 12]!,
      skin[o + 1]! * x + skin[o + 5]! * y + skin[o + 9]! * z + skin[o + 13]!,
      skin[o + 2]! * x + skin[o + 6]! * y + skin[o + 10]! * z + skin[o + 14]!,
    ];
  };
  for (const c of body.colliders) {
    out.push({ a: apply(c.jointA, c.offsetA), b: apply(c.jointB, c.offsetB), radius: c.radius });
  }
  return out;
}

// ---------------------------------------------------------------- prenda (camiseta de tubos)

export const DOUBLE_FABRIC: FabricDef = {
  id: 'double-cotton',
  name: { es: 'Algodón (doble)', en: 'Cotton (double)' },
  family: 'cotton-jersey',
  weightGsm: 180,
  stretch: 0.3,
  stiffness: 0.3,
  roughness: 0.7,
  sheen: 0.3,
  threadsPerCm: 20,
  tileCm: 12,
  thicknessMm: 0.6,
};

export const DOUBLE_VARIANT: SwatchVariant = {
  id: 'double-teal',
  name: { es: 'Verde azulado', en: 'Teal' },
  color: '#2f7f86',
  pattern: { type: 'solid' },
};

export function doubleGarmentDef(slot: GarmentDefinition['slot'] = 'upper'): GarmentDefinition {
  return {
    id: `double-${slot}`,
    name: { es: 'Camiseta doble', en: 'Double tee' },
    description: { es: 'Camiseta de pruebas', en: 'Test tee' },
    brand: 'Dev',
    category: 'tops',
    template: 'tee',
    slot,
    fit: 'regular',
    fabricId: DOUBLE_FABRIC.id,
    variants: [DOUBLE_VARIANT],
    sizes: [{ label: 'M', body: {}, garment: {} }],
    tags: [],
  };
}

export function doubleEquipped(slot: GarmentDefinition['slot'] = 'upper'): EquippedItem {
  return {
    garment: doubleGarmentDef(slot),
    fabric: DOUBLE_FABRIC,
    variant: DOUBLE_VARIANT,
    sizeLabel: 'M',
  };
}

export function doubleTee(body: BodyModel, slot: GarmentDefinition['slot'] = 'upper'): GarmentGeometry {
  const rest = body.skeleton;
  const m = body.measurements;
  const ease = slot === 'outer' ? 0.05 : 0.03;
  const b = newBuilder();
  const SEG = 36;
  const rc = rOf(m.chestCm) + ease;
  const rw = rOf(m.waistCm) + ease + 0.01;
  const rh = rOf(m.hipCm) + ease;
  const shoulderY = rest.joints[J.l_upper_arm]!.position[1];
  const neckY = rest.joints[J.neck]!.position[1];
  const hemY = rest.joints[J.pelvis]!.position[1] - 0.08;
  const shoulderHalf = cmToM(m.shoulderWidthCm) / 2;
  const ringsY = [neckY + 0.025, shoulderY + 0.012, shoulderY - 0.1, (shoulderY + hemY) / 2, hemY + 0.12, hemY];
  const radii: [number, number][] = [
    [0.095, 0.085],
    [shoulderHalf * 1.02, rc * 0.82],
    [rc * 1.14, rc * 0.84],
    [rw * 1.12, rw * 0.8],
    [rh * 1.14, rh * 0.82],
    [rh * 1.14, rh * 0.82],
  ];
  const torsoRings: Ring[] = ringsY.map((y, i) => ({
    c: [0, y, 0],
    axis: [0, 1, 0],
    ax: radii[i]![0],
    az: radii[i]![1],
    skin: [],
  }));
  // más resolución vertical
  const dense: Ring[] = [];
  for (let i = 0; i < torsoRings.length - 1; i++) {
    const a = torsoRings[i]!,
      c = torsoRings[i + 1]!;
    for (let s = 0; s < 8; s++) {
      const t = s / 8;
      dense.push({
        c: lerp3(a.c, c.c, t),
        axis: [0, 1, 0],
        ax: a.ax + (c.ax - a.ax) * t,
        az: a.az + (c.az - a.az) * t,
        skin: [],
      });
    }
  }
  dense.push(torsoRings[torsoRings.length - 1]!);
  // el anillo del torso va de cuello (arriba) a bajo; invertimos para que el eje apunte hacia arriba (+Y)
  dense.reverse();
  const torsoFirst = addTube(b, dense, SEG, 0, false);
  const torsoCount = dense.length * SEG;

  // mangas cortas
  const sleeveRings: Ring[] = [];
  const sleeveVerts: { start: number; count: number }[] = [];
  for (const side of ['l', 'r'] as const) {
    const ua = rest.joints[side === 'l' ? J.l_upper_arm : J.r_upper_arm]!.position;
    const fa = rest.joints[side === 'l' ? J.l_forearm : J.r_forearm]!.position;
    const dir = norm3(sub(fa, ua));
    const ru = rOf(m.chestCm) * 0.34 + ease * 0.7;
    const rings: Ring[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = (i / 8) * 0.55;
      const c = lerp3(ua, fa, t);
      const sx = side === 'l' ? 1 : -1;
      const pos: Vec3 = [c[0] - sx * 0.015 * (1 - t), c[1] + 0.012 * (1 - t), c[2]];
      rings.push({ c: pos, axis: dir, ax: ru * (1.05 - 0.15 * t), az: ru * (1.05 - 0.15 * t), skin: [] });
    }
    const first = addTube(b, rings, 20, 0, false);
    sleeveVerts.push({ start: first, count: rings.length * 20 });
    sleeveRings.push(...rings);
  }

  const n = b.positions.length / 3;
  const positions = new Float32Array(b.positions);
  const indices = new Uint32Array(b.indices);

  // skinning: copia del vértice más cercano del cuerpo
  const bm = body.mesh;
  const skinIndices = new Uint16Array(n * 4);
  const skinWeights = new Float32Array(n * 4);
  const bn = bm.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!,
      y = positions[i * 3 + 1]!,
      z = positions[i * 3 + 2]!;
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < bn; k++) {
      const dx = bm.positions[k * 3]! - x,
        dy = bm.positions[k * 3 + 1]! - y,
        dz = bm.positions[k * 3 + 2]! - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    for (let k = 0; k < 4; k++) {
      skinIndices[i * 4 + k] = bm.skinIndices[best * 4 + k]!;
      skinWeights[i * 4 + k] = bm.skinWeights[best * 4 + k]!;
    }
  }

  const normals = computeVertexNormals(positions, indices);
  // UV en metros: u = ángulo·perímetro, v = altura
  const uvMetersPerTile = 1;
  const uvs = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!,
      y = positions[i * 3 + 1]!,
      z = positions[i * 3 + 2]!;
    uvs[i * 2] = (Math.atan2(z, x) / TAU) * 1.2 + x * 0.3;
    uvs[i * 2 + 1] = y + z * 0.25;
  }
  void torsoFirst;
  void torsoCount;
  const ao = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = positions[i * 3 + 1]!;
    const tNeck = Math.max(0, 1 - Math.abs(y - (neckY + 0.025)) / 0.08);
    ao[i] = 1 - 0.45 * tNeck;
  }
  const cloth = {
    maxDistance: new Float32Array(n).fill(0.035),
    invMass: new Float32Array(n).fill(1),
    stiffness: 0.3,
    damping: 0.15,
  };
  return {
    garmentId: `double-${slot}`,
    sizeLabel: 'M',
    slot,
    mesh: { positions, normals, uvs, indices, skinIndices, skinWeights },
    groups: [{ start: 0, count: indices.length, slot: 'main' }],
    cloth,
    ao,
    coversRegions: ['torso', 'l_arm', 'r_arm'],
    uvMetersPerTile,
  };
}

/** Textura de sarga procedural (RGBA8) para el albedo/normal/ORM del doble. */
export function doubleTextures(variant: SwatchVariant = DOUBLE_VARIANT, size: 256 | 512 = 256): FabricTextureSet {
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const col = variant.color;
  const r0 = parseInt(col.slice(1, 3), 16),
    g0 = parseInt(col.slice(3, 5), 16),
    b0 = parseInt(col.slice(5, 7), 16);
  const threads = 24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * threads;
      const v = (y / size) * threads;
      const diag = Math.sin((u + v) * Math.PI) * 0.5 + 0.5;
      const weave = 0.82 + 0.18 * diag;
      const i = (y * size + x) * 4;
      albedo[i] = Math.min(255, r0 * weave);
      albedo[i + 1] = Math.min(255, g0 * weave);
      albedo[i + 2] = Math.min(255, b0 * weave);
      albedo[i + 3] = 255;
      const dx = Math.cos((u + v) * Math.PI) * 0.35;
      normal[i] = Math.round((dx * 0.5 + 0.5) * 255);
      normal[i + 1] = Math.round((dx * 0.5 + 0.5) * 255);
      normal[i + 2] = 255;
      normal[i + 3] = 255;
      orm[i] = Math.round((0.85 + 0.15 * diag) * 255);
      orm[i + 1] = Math.round((0.72 + 0.1 * diag) * 255);
      orm[i + 2] = 0;
      orm[i + 3] = 255;
    }
  }
  return { size, albedo, normal, orm, tileMeters: 0.12 };
}

export function doubleLoadedGarment(
  body: BodyModel,
  slot: GarmentDefinition['slot'] = 'upper',
): LoadedGarment {
  return {
    item: doubleEquipped(slot),
    geometry: doubleTee(body, slot),
    textures: { main: doubleTextures() },
  };
}

// ---------------------------------------------------------------- tela de muelle

/** Solver de tela falso: sigue al objetivo con retardo (muelle amortiguado) y genera «arrugas» por movimiento. */
export class SpringSolver implements ClothSolver {
  readonly vertexCount: number;
  readonly wrinkle: Float32Array;
  private readonly prev: Float32Array;
  private initialised = false;
  steps = 0;
  resets = 0;

  constructor(private readonly geometry: GarmentGeometry) {
    this.vertexCount = geometry.mesh.positions.length / 3;
    this.wrinkle = new Float32Array(this.vertexCount);
    this.prev = new Float32Array(this.vertexCount * 3);
  }

  step(dtSeconds: number, skinned: Float32Array, _caps: readonly WorldCapsule[], out: Float32Array): void {
    this.steps++;
    const k = 1 - Math.exp(-Math.min(0.1, Math.max(0, dtSeconds)) / 0.045);
    const max = this.geometry.cloth.maxDistance;
    if (!this.initialised) {
      this.prev.set(skinned);
      this.initialised = true;
    }
    const n = this.vertexCount;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let x = this.prev[o]! + (skinned[o]! - this.prev[o]!) * k;
      let y = this.prev[o + 1]! + (skinned[o + 1]! - this.prev[o + 1]!) * k;
      let z = this.prev[o + 2]! + (skinned[o + 2]! - this.prev[o + 2]!) * k;
      const dx = x - skinned[o]!,
        dy = y - skinned[o + 1]!,
        dz = z - skinned[o + 2]!;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const m = max[i]!;
      if (d > m && d > 0) {
        const s = m / d;
        x = skinned[o]! + dx * s;
        y = skinned[o + 1]! + dy * s;
        z = skinned[o + 2]! + dz * s;
      }
      out[o] = x;
      out[o + 1] = y;
      out[o + 2] = z;
      this.prev[o] = x;
      this.prev[o + 1] = y;
      this.prev[o + 2] = z;
      this.wrinkle[i] = Math.min(1, Math.min(d, m) * 18);
    }
  }

  reset(): void {
    this.initialised = false;
    this.resets++;
    this.wrinkle.fill(0);
  }
}

// ---------------------------------------------------------------- guion de poses

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ss = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * Pose animada determinista (en espacio cámara): 0–2 s A-pose, 2–4 s brazos arriba, 4–7 s giro de 360°
 * (los brazos vuelven a A), 7–10 s sentado; después vuelve a empezar. `t` en ms.
 */
export function scriptedPose(rest: RestSkeleton, tMs: number, distanceM = 2.7): SkeletonPose {
  const t = (tMs / 1000) % 10;
  const base = restPose(rest, tMs);
  const rot: Quat[] = base.rotations.map(() => [0, 0, 0, 1] as Quat);
  const H = rest.height;
  let rootY = rest.joints[J.pelvis]!.position[1] - H * 0.52;
  let rootZ = -distanceM;
  let rootX = 0;

  const up = ss((t - 2) / 0.8) * (1 - ss((t - 3.6) / 0.6));
  const raise = (joint: number, dirRest: Vec3, amount: number): void => {
    const target: Vec3 = [Math.sign(dirRest[0]) * 0.12, 1, 0.05];
    const full = q.fromUnitVectors(norm3(dirRest), norm3(target));
    rot[joint] = q.slerp([0, 0, 0, 1], full, amount);
  };
  const lDir = (j: number): Vec3 => rest.joints[j + 1] ? sub(rest.joints[j + 1]!.position, rest.joints[j]!.position) : [1, 0, 0];
  raise(J.l_upper_arm, lDir(J.l_upper_arm), up);
  raise(J.r_upper_arm, lDir(J.r_upper_arm), up);
  // codos algo flexionados al caminar/girar
  const bend = 0.25 * (1 - up);
  rot[J.l_forearm] = q.fromAxisAngle([0, 0, 1], bend);
  rot[J.r_forearm] = q.fromAxisAngle([0, 0, 1], -bend);

  // giro completo con ease
  if (t >= 4 && t < 7) {
    const yaw = ss((t - 4) / 3) * TAU;
    rot[J.pelvis] = q.fromAxisAngle([0, 1, 0], yaw);
  }
  // sentado
  const sit = ss((t - 7) / 0.8) * (1 - ss((t - 9.3) / 0.6));
  if (sit > 0) {
    rot[J.l_thigh] = q.fromAxisAngle([1, 0, 0], -Math.PI / 2 * sit);
    rot[J.r_thigh] = q.fromAxisAngle([1, 0, 0], -Math.PI / 2 * sit);
    rot[J.l_calf] = q.fromAxisAngle([1, 0, 0], (Math.PI / 2) * sit);
    rot[J.r_calf] = q.fromAxisAngle([1, 0, 0], (Math.PI / 2) * sit);
    rot[J.spine] = q.fromAxisAngle([1, 0, 0], -0.08 * sit);
    rootY -= lerp(0, H * 0.25, sit);
  }
  // ligero balanceo para que el seguimiento no sea trivial
  rootX += Math.sin(tMs / 1300) * 0.04;
  void rootZ;
  rootZ = -distanceM + Math.sin(tMs / 1900) * 0.05;
  return {
    timestampMs: tMs,
    rootPosition: [rootX, rootY, rootZ],
    rotations: rot,
    confidence: 1,
    jointConfidence: Array.from({ length: JOINT_COUNT }, () => 1),
  };
}
