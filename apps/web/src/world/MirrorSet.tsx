import { useEffect, useMemo, type ReactNode } from 'react';
import { AdditiveBlending, ExtrudeGeometry, Path, Shape } from 'three';
import { MIRROR } from './layout';
import { frameRing, mergeBoxes } from './geometryUtils';
import { getOakBoards, makeMirrorSheen } from './textures/atelierTextures';

const BRASS = { color: '#c8a04a', metalness: 1, roughness: 0.27, envMapIntensity: 1.7 } as const;
const OUT_W = MIRROR.width + MIRROR.frame * 2;
const OUT_H = MIRROR.height + MIRROR.frame * 2;
const POST_X = OUT_W / 2 + 0.085;

/**
 * Espejo de pie («cheval»): cristal grande, marco de latón pulido, dos montantes de roble con remates y
 * pies. `children` (el MirrorStage o un cristal apagado) se montan en el plano del cristal.
 */
export function MirrorSet({ active, children, woodTex }: { active: boolean; children?: ReactNode; woodTex: number }) {
  const sheen = useMemo(() => makeMirrorSheen(), []);
  const wood = useMemo(() => getOakBoards(woodTex, 33, 2), [woodTex]);
  useEffect(() => {
    return () => sheen.dispose();
  }, [sheen]);

  const outer = useMemo(() => frameRing(OUT_W, OUT_H, MIRROR.width + 0.01, MIRROR.height + 0.01, 0.045, 0.014), []);
  const lip = useMemo(() => frameRing(MIRROR.width + 0.07, MIRROR.height + 0.07, MIRROR.width, MIRROR.height, 0.02, 0.006), []);
  const crest = useMemo(() => {
    const s = new Shape();
    s.moveTo(-0.24, 0);
    s.absarc(0, 0, 0.24, Math.PI, 0, true);
    s.lineTo(-0.24, 0);
    const hole = new Path();
    hole.absarc(0, 0, 0.085, 0, Math.PI * 2, false);
    s.holes.push(hole);
    return new ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 3, curveSegments: 24 });
  }, []);
  const feet = useMemo(
    () =>
      mergeBoxes([
        { pos: [-POST_X, 0.035, 0.18], size: [0.075, 0.07, 0.72] },
        { pos: [POST_X, 0.035, 0.18], size: [0.075, 0.07, 0.72] },
        { pos: [0, 0.2, -0.16], size: [POST_X * 2, 0.05, 0.05] },
      ]),
    [],
  );
  useEffect(() => () => [outer, lip, feet, crest].forEach((g) => g.dispose()), [outer, lip, feet, crest]);

  const tilt = -0.05;
  return (
    <group position={[MIRROR.x, 0, MIRROR.z]}>
      {/* Montantes de roble con remate de latón */}
      {[-1, 1].map((s) => (
        <group key={s} position={[s * POST_X, 0, 0]}>
          <mesh position={[0, 1.17, -0.02]} castShadow receiveShadow>
            <boxGeometry args={[0.075, 2.34, 0.075]} />
            <meshStandardMaterial map={wood.map} normalMap={wood.normalMap} roughnessMap={wood.roughnessMap} roughness={1} color="#9b7a54" />
          </mesh>
          <mesh position={[0, 2.38, -0.02]} castShadow>
            <sphereGeometry args={[0.052, 24, 16]} />
            <meshStandardMaterial {...BRASS} />
          </mesh>
          <mesh position={[0, 2.325, -0.02]} castShadow>
            <cylinderGeometry args={[0.04, 0.05, 0.05, 20]} />
            <meshStandardMaterial {...BRASS} />
          </mesh>
          {/* pivote */}
          <mesh position={[-s * 0.05, MIRROR.centerY, 0.01]} rotation-z={Math.PI / 2} castShadow>
            <cylinderGeometry args={[0.032, 0.032, 0.09, 24]} />
            <meshStandardMaterial {...BRASS} />
          </mesh>
        </group>
      ))}
      <mesh geometry={feet} castShadow receiveShadow>
        <meshStandardMaterial map={wood.map} normalMap={wood.normalMap} roughnessMap={wood.roughnessMap} roughness={1} color="#8a6a48" />
      </mesh>

      {/* Marco basculante + cristal */}
      <group position={[0, MIRROR.centerY, 0]} rotation-x={tilt}>
        <mesh geometry={outer} position={[0, 0, -0.02]} castShadow receiveShadow>
          <meshStandardMaterial {...BRASS} />
        </mesh>
        <mesh geometry={lip} position={[0, 0, 0.012]} castShadow>
          <meshStandardMaterial {...BRASS} color="#a98138" roughness={0.34} />
        </mesh>
        {/* remate superior: cresta de latón (medio disco calado) */}
        <mesh geometry={crest} position={[0, OUT_H / 2 - 0.01, -0.02]} castShadow>
          <meshStandardMaterial {...BRASS} />
        </mesh>

        {/* cristal */}
        <mesh position={[0, 0, 0.008]}>
          <planeGeometry args={[MIRROR.width, MIRROR.height]} />
          <meshPhysicalMaterial color="#17110c" metalness={0.9} roughness={0.07} envMapIntensity={1.5} clearcoat={1} clearcoatRoughness={0.04} />
        </mesh>
        {!active && (
          <mesh position={[0, 0, 0.011]}>
            <planeGeometry args={[MIRROR.width, MIRROR.height]} />
            <meshBasicMaterial map={sheen} transparent depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
          </mesh>
        )}
        <group position={[0, 0, 0.014]}>{children}</group>
      </group>
    </group>
  );
}
