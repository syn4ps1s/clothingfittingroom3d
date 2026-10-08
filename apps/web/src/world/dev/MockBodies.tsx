import { useEffect, useMemo } from 'react';
import { DoubleSide, Vector2 } from 'three';
import type { BodyMannequinProps, GarmentViewProps } from '../../contracts';
import { toDataTexture } from '../textures/fabricTextures';
import { mockShape, torsoRadius, type MockShape } from './mockShape';

/** Perfil (radio, altura) para LatheGeometry entre dos alturas relativas (de arriba a abajo). */
function torsoProfile(s: MockShape, fromFrac: number, toFrac: number, inflate: number, flare = 0): Vector2[] {
  const pts: Vector2[] = [];
  const steps = 18;
  for (let i = 0; i <= steps; i++) {
    const f = fromFrac + ((toFrac - fromFrac) * i) / steps;
    let r = torsoRadius(s, f, inflate);
    if (flare > 0 && f < 0.52) r += flare * (0.52 - f) * s.H * 0.5;
    pts.push(new Vector2(Math.max(0.001, r), f * s.H));
  }
  return pts.reverse(); // de abajo a arriba: normales hacia fuera
}

const ARM_ANGLE = 0.2;
const LEG_ANGLE = 0.05;

/** Maniquí de taller: elegante, mate y sin cara. Misma firma que el real (`BodyMannequin`). */
export function MockBodyMannequin({ body, look = 'mannequin' }: BodyMannequinProps) {
  const s = useMemo(() => mockShape(body.measurements), [body.measurements]);
  const torso = useMemo(() => torsoProfile(s, 0.85, 0.45, 0), [s]);
  const armR = 0.036 * (s.H / 1.75);
  const legTop = s.thighR * 1.08;
  const material =
    look === 'occluder' ? (
      <meshBasicMaterial colorWrite={false} />
    ) : look === 'ghost' ? (
      <meshStandardMaterial color="#cfc3ad" roughness={0.9} transparent opacity={0.28} />
    ) : (
      <meshStandardMaterial color="#d9ceb9" roughness={0.88} metalness={0} />
    );
  const hipX = s.hipA * 0.52;
  const shoulderY = s.H * 0.805;
  const legLen = s.H * 0.49 - s.H * 0.035;
  return (
    <group>
      <mesh scale={[1, 1, s.depth]} castShadow receiveShadow>
        <latheGeometry args={[torso, 28]} />
        {material}
      </mesh>
      <mesh position={[0, s.H * 0.865, 0]} castShadow>
        <cylinderGeometry args={[s.neckR * 0.92, s.neckR * 1.05, s.H * 0.05, 18]} />
        {material}
      </mesh>
      <mesh position={[0, s.H * 0.93, s.H * 0.006]} scale={[0.82, 1, 0.95]} castShadow>
        <sphereGeometry args={[s.H * 0.063, 24, 18]} />
        {material}
      </mesh>
      {[1, -1].map((side) => (
        <group key={`arm${side}`} position={[side * s.shoulderHalf * 0.98, shoulderY, 0]} rotation={[0, 0, side * ARM_ANGLE]}>
          <mesh position={[0, -s.armLen * 0.5, 0]} castShadow>
            <cylinderGeometry args={[armR * 1.15, armR * 0.78, s.armLen * 0.98, 14]} />
            {material}
          </mesh>
          <mesh castShadow>
            <sphereGeometry args={[armR * 1.2, 14, 10]} />
            {material}
          </mesh>
        </group>
      ))}
      {[1, -1].map((side) => (
        <group key={`leg${side}`} position={[side * hipX, s.H * 0.49, 0]} rotation={[0, 0, -side * LEG_ANGLE]}>
          <mesh position={[0, -legLen / 2, 0]} castShadow>
            <cylinderGeometry args={[legTop, s.thighR * 0.46, legLen, 18]} />
            {material}
          </mesh>
        </group>
      ))}
    </group>
  );
}

interface Plan {
  readonly torso?: { from: number; to: number; inflate: number; flare?: number };
  readonly sleeves?: 'short' | 'long';
  readonly legs?: { to: number; inflate: number };
  readonly pelvis?: { from: number; to: number; inflate: number };
}

function planFor(template: string, slot: string): Plan {
  switch (template) {
    case 'tee':
    case 'polo':
      return { torso: { from: 0.835, to: 0.55, inflate: 0.012 }, sleeves: 'short' };
    case 'tank':
      return { torso: { from: 0.82, to: 0.55, inflate: 0.01 } };
    case 'shirt':
    case 'long_sleeve':
      return { torso: { from: 0.835, to: 0.52, inflate: 0.016 }, sleeves: 'long' };
    case 'sweater':
      return { torso: { from: 0.84, to: 0.53, inflate: 0.022 }, sleeves: 'long' };
    case 'hoodie':
      return { torso: { from: 0.845, to: 0.5, inflate: 0.04 }, sleeves: 'long' };
    case 'blazer':
    case 'jacket':
      return { torso: { from: 0.84, to: 0.47, inflate: 0.03 }, sleeves: 'long' };
    case 'coat':
      return { torso: { from: 0.84, to: 0.27, inflate: 0.04, flare: 0.5 }, sleeves: 'long' };
    case 'jeans':
    case 'chinos':
      return { pelvis: { from: 0.6, to: 0.46, inflate: 0.012 }, legs: { to: 0.045, inflate: 0.014 } };
    case 'shorts':
      return { pelvis: { from: 0.6, to: 0.46, inflate: 0.012 }, legs: { to: 0.3, inflate: 0.016 } };
    case 'skirt':
      return { torso: { from: 0.62, to: 0.3, inflate: 0.012, flare: 0.9 } };
    case 'dress':
      return { torso: { from: 0.835, to: 0.24, inflate: 0.014, flare: 1.1 }, sleeves: 'short' };
    default:
      return slot === 'lower'
        ? { pelvis: { from: 0.6, to: 0.46, inflate: 0.012 }, legs: { to: 0.1, inflate: 0.014 } }
        : { torso: { from: 0.835, to: 0.55, inflate: 0.014 }, sleeves: 'short' };
  }
}

/**
 * Prenda de desarrollo: cascarones inflados sobre las proporciones del maniquí, con la textura de la muestra.
 * Misma firma que el real (`GarmentView`).
 */
export function MockGarmentView({ garment, body }: GarmentViewProps) {
  const s = useMemo(() => mockShape(body.measurements), [body.measurements]);
  const { template, slot } = garment.item.garment;
  const plan = useMemo(() => planFor(template, slot), [template, slot]);
  const albedo = useMemo(() => toDataTexture(garment.textures.main, 'albedo'), [garment.textures.main]);
  const normal = useMemo(() => toDataTexture(garment.textures.main, 'normal'), [garment.textures.main]);
  const tile = garment.item.fabric.tileCm / 100;

  useEffect(() => {
    // Repetición común a todas las piezas (el mock no pretende escala física exacta por pieza).
    const u = Math.max(1, Math.round((s.chestA * 2 * Math.PI) / tile));
    const v = Math.max(1, Math.round(0.8 / tile));
    albedo.repeat.set(u, v);
    normal.repeat.set(u, v);
  }, [albedo, normal, s.chestA, tile]);
  useEffect(
    () => () => {
      albedo.dispose();
      normal.dispose();
    },
    [albedo, normal],
  );

  const torso = useMemo(
    () => (plan.torso ? torsoProfile(s, plan.torso.from, plan.torso.to, plan.torso.inflate, plan.torso.flare ?? 0) : null),
    [plan, s],
  );
  const pelvis = useMemo(
    () => (plan.pelvis ? torsoProfile(s, plan.pelvis.from, plan.pelvis.to, plan.pelvis.inflate) : null),
    [plan, s],
  );
  const sleeveLen = (plan.sleeves === 'short' ? 0.3 : 0.97) * s.armLen;
  const armR = 0.036 * (s.H / 1.75);
  const legTop = s.thighR * 1.08;
  const hipX = s.hipA * 0.52;
  const legLen = plan.legs ? s.H * 0.49 - plan.legs.to * s.H : 0;
  const material = (
    <meshStandardMaterial
      side={DoubleSide}
      roughness={garment.item.fabric.roughness}
      metalness={0}
      map={albedo}
      normalMap={normal}
    />
  );

  return (
    <group>
      {torso && (
        <mesh scale={[1, 1, s.depth]} castShadow receiveShadow>
          <latheGeometry args={[torso, 36]} />
          {material}
        </mesh>
      )}
      {pelvis && (
        <mesh scale={[1, 1, s.depth]} castShadow receiveShadow>
          <latheGeometry args={[pelvis, 36]} />
          {material}
        </mesh>
      )}
      {plan.sleeves &&
        [1, -1].map((side) => (
          <group key={`sl${side}`} position={[side * s.shoulderHalf * 0.98, s.H * 0.805, 0]} rotation={[0, 0, side * 0.2]}>
            <mesh position={[0, -sleeveLen / 2, 0]} castShadow>
              <cylinderGeometry args={[armR * 1.5, armR * (plan.sleeves === 'short' ? 1.5 : 1.12), sleeveLen, 18, 1, true]} />
              {material}
            </mesh>
          </group>
        ))}
      {plan.legs &&
        [1, -1].map((side) => (
          <group key={`lg${side}`} position={[side * hipX, s.H * 0.49, 0]} rotation={[0, 0, -side * 0.05]}>
            <mesh position={[0, -legLen / 2, 0]} castShadow>
              <cylinderGeometry args={[legTop + plan.legs!.inflate, s.thighR * 0.5 + plan.legs!.inflate, legLen, 20, 1, true]} />
              {material}
            </mesh>
          </group>
        ))}
    </group>
  );
}
