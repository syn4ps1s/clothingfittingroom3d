import { describe, expect, it } from 'vitest';
import {
  J,
  JOINT_COUNT,
  JOINT_NAMES,
  JOINT_PARENT,
  buildRestSkeleton,
  computeSkinMatrices,
  forwardKinematics,
  restPose,
} from './skeleton.js';
import { REFERENCE_MEASUREMENTS } from './fixtures.js';
import { q, v3, type Quat } from './math.js';
import { skinPositions } from './mesh.js';

describe('skeleton', () => {
  it('tiene tantos padres como joints y cada padre precede a su hijo', () => {
    expect(JOINT_PARENT).toHaveLength(JOINT_COUNT);
    JOINT_PARENT.forEach((p, i) => expect(p).toBeLessThan(i));
    expect(JOINT_NAMES[0]).toBe('pelvis');
  });

  it.each(Object.entries(REFERENCE_MEASUREMENTS))('reposo coherente para %s', (_name, m) => {
    const rest = buildRestSkeleton(m);
    const H = m.heightCm / 100;
    const head = rest.joints[J.head]!;
    // la cabeza (articulación + hueso) alcanza la estatura declarada
    expect(head.position[1] + head.boneLength).toBeCloseTo(H, 2);
    // simetría izquierda/derecha
    expect(rest.joints[J.l_upper_arm]!.position[0]).toBeCloseTo(
      -rest.joints[J.r_upper_arm]!.position[0],
      6,
    );
    expect(rest.joints[J.l_thigh]!.position[0]).toBeCloseTo(
      -rest.joints[J.r_thigh]!.position[0],
      6,
    );
    // la persona mira a +Z: la punta del pie está delante del tobillo
    expect(rest.joints[J.l_toes]!.position[2]).toBeGreaterThan(rest.joints[J.l_foot]!.position[2]);
    // el ancho de hombros coincide con la medida
    expect(2 * rest.joints[J.l_upper_arm]!.position[0]).toBeCloseTo(m.shoulderWidthCm / 100, 6);
    // todas las longitudes de hueso son positivas y finitas
    for (const j of rest.joints) {
      expect(j.boneLength).toBeGreaterThan(0);
      expect(v3.isFinite(j.position)).toBe(true);
    }
  });

  it('FK en reposo reproduce las posiciones de reposo y las matrices de skinning son identidad', () => {
    const rest = buildRestSkeleton(REFERENCE_MEASUREMENTS.adultA);
    const pose = restPose(rest);
    const { positions } = forwardKinematics(rest, pose);
    rest.joints.forEach((j, i) =>
      expect(v3.distance(positions[i]!, j.position)).toBeLessThan(1e-9),
    );
    const mats = computeSkinMatrices(rest, pose);
    for (let i = 0; i < JOINT_COUNT; i++) {
      const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      id.forEach((v, k) => expect(mats[i * 16 + k]).toBeCloseTo(v, 6));
    }
  });

  it('skinning: rotar el hombro izquierdo 90° mueve la muñeca como indica la FK y deja el hombro fijo', () => {
    const rest = buildRestSkeleton(REFERENCE_MEASUREMENTS.adultA);
    const rotations: Quat[] = rest.joints.map(() => [0, 0, 0, 1] as Quat);
    rotations[J.l_upper_arm] = q.fromAxisAngle([0, 0, 1], Math.PI / 2);
    const pose = { ...restPose(rest), rotations };
    const mats = computeSkinMatrices(rest, pose);
    const { positions } = forwardKinematics(rest, pose);

    // Vértice colocado exactamente en la muñeca de reposo, 100% pesado al hueso del brazo superior
    const wrist = rest.joints[J.l_hand]!.position;
    const out = skinPositions(
      new Float32Array(wrist),
      new Uint16Array([J.l_upper_arm, 0, 0, 0]),
      new Float32Array([1, 0, 0, 0]),
      mats,
    );
    const expectedWrist = positions[J.l_hand]!;
    expect(v3.distance([out[0]!, out[1]!, out[2]!], expectedWrist)).toBeLessThan(1e-5);

    const shoulder = rest.joints[J.l_upper_arm]!.position;
    const out2 = skinPositions(
      new Float32Array(shoulder),
      new Uint16Array([J.l_upper_arm, 0, 0, 0]),
      new Float32Array([1, 0, 0, 0]),
      mats,
    );
    expect(v3.distance([out2[0]!, out2[1]!, out2[2]!], shoulder)).toBeLessThan(1e-6);
  });
});
