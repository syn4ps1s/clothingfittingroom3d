import { useEffect, useMemo } from 'react';
import { DoubleSide, InstancedMesh, Matrix4, Quaternion, Vector3, Euler, Color } from 'three';
import { Sparkles } from '@react-three/drei';
import { ROOM, WINDOW } from './layout';
import { makePatternArt } from './textures/atelierTextures';
import { mulberry32 } from './textures/rng';

const BRASS = { color: '#c8a04a', metalness: 1, roughness: 0.28, envMapIntensity: 1.5 } as const;

/** Planta de hoja grande en maceta (hojas instanciadas). */
export function Plant({ position, height = 2, seed = 1 }: { position: [number, number, number]; height?: number; seed?: number }) {
  const count = 46;
  const leaves = useMemo(() => {
    const r = mulberry32(seed);
    const items: { m: Matrix4; c: Color }[] = [];
    for (let i = 0; i < count; i++) {
      const t = r();
      const y = height * (0.45 + 0.55 * t);
      const radius = 0.08 + (1 - Math.abs(t - 0.6)) * 0.42 * r();
      const a = r() * Math.PI * 2;
      const q = new Quaternion().setFromEuler(new Euler((r() - 0.5) * 1.2 + 0.5, a, (r() - 0.5) * 0.8));
      const m = new Matrix4().compose(
        new Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius),
        q,
        new Vector3(0.1 + r() * 0.05, 0.24 + r() * 0.1, 0.012),
      );
      items.push({ m, c: new Color().setHSL(0.27 + r() * 0.05, 0.42, 0.2 + r() * 0.1) });
    }
    return items;
  }, [seed, height]);
  const ref = useMemo(() => ({ current: null as InstancedMesh | null }), []);
  const setRef = (mesh: InstancedMesh | null) => {
    ref.current = mesh;
    if (!mesh) return;
    leaves.forEach((l, i) => {
      mesh.setMatrixAt(i, l.m);
      mesh.setColorAt(i, l.c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };
  return (
    <group position={position}>
      <mesh position={[0, 0.2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.2, 0.15, 0.4, 28]} />
        <meshStandardMaterial color="#8a5a3c" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.405, 0]}>
        <cylinderGeometry args={[0.185, 0.185, 0.02, 28]} />
        <meshStandardMaterial color="#2b1d12" roughness={1} />
      </mesh>
      <mesh position={[0, height * 0.35 + 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.012, 0.022, height * 0.7, 10]} />
        <meshStandardMaterial color="#5a4630" roughness={0.9} />
      </mesh>
      <instancedMesh ref={setRef} args={[undefined, undefined, count]} castShadow>
        <sphereGeometry args={[1, 10, 8]} />
        <meshStandardMaterial roughness={0.55} side={DoubleSide} />
      </instancedMesh>
    </group>
  );
}

/** Lámina enmarcada con un patrón de sastrería (marco de latón y paspartú). */
export function FramedArt({ position, size = [0.62, 0.78] as const }: { position: [number, number, number]; size?: readonly [number, number] }) {
  const art = useMemo(() => makePatternArt(), []);
  useEffect(() => () => art.dispose(), [art]);
  const [w, h] = size;
  return (
    <group position={position}>
      <mesh castShadow>
        <boxGeometry args={[w + 0.08, h + 0.08, 0.035]} />
        <meshStandardMaterial {...BRASS} roughness={0.38} />
      </mesh>
      <mesh position={[0, 0, 0.019]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial map={art} roughness={0.95} />
      </mesh>
    </group>
  );
}

/** Lámpara colgante: cable, pantalla de latón y bombilla emisiva (el bloom la hace brillar). */
export function Pendant({ position, drop = 1.2 }: { position: [number, number, number]; drop?: number }) {
  return (
    <group position={position}>
      <mesh position={[0, drop / 2, 0]}>
        <cylinderGeometry args={[0.005, 0.005, drop, 6]} />
        <meshStandardMaterial color="#1b1511" />
      </mesh>
      <mesh castShadow>
        <sphereGeometry args={[0.17, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial {...BRASS} side={DoubleSide} />
      </mesh>
      <mesh position={[0, -0.03, 0]}>
        <sphereGeometry args={[0.055, 20, 14]} />
        <meshBasicMaterial color={new Color(3.2, 2.4, 1.4)} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Rollos de tela apoyados junto a la mesa. */
export function FabricBolts({ position }: { position: [number, number, number] }) {
  const colors = ['#6b2a2a', '#2f4a36', '#c9b48a', '#24325a'];
  return (
    <group position={position}>
      {colors.map((c, i) => (
        <group key={c} position={[i * 0.17, 0, i % 2 ? 0.05 : 0]} rotation={[0.07, 0, (i - 1.5) * 0.04]}>
          <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[0.075, 0.075, 1.0, 20]} />
            <meshStandardMaterial color={c} roughness={0.92} />
          </mesh>
          <mesh position={[0, 1.003, 0]}>
            <cylinderGeometry args={[0.04, 0.04, 0.004, 16]} />
            <meshStandardMaterial color="#d9c9a0" roughness={0.9} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Motas de polvo flotando en los haces de luz (apagadas con «reducir movimiento» o calidad baja). */
export function Dust({ count, animate }: { count: number; animate: boolean }) {
  if (count <= 0) return null;
  return (
    <Sparkles
      count={count}
      scale={[4.2, 2.6, 5]}
      position={[WINDOW.x - 1.6, 1.7, ROOM.backZ + 2.8]}
      size={2.2}
      speed={animate ? 0.18 : 0}
      opacity={0.55}
      color="#ffd9a0"
      noise={0.4}
    />
  );
}
