import { useEffect, useMemo } from 'react';
import { DataTexture, Float32BufferAttribute, PlaneGeometry, type Texture } from 'three';
import { RoundedBox } from '@react-three/drei';
import type { FabricDef, SwatchVariant } from '@fitroom/shared';
import { TABLE } from './layout';
import type { QualityConfig } from './quality';
import { getFabricTextures } from './textures/fabricSets';
import { toDataTexture } from './textures/fabricTextures';
import { getOakBoards, makeCuttingMat } from './textures/atelierTextures';

export interface SwatchItem {
  readonly id: string;
  readonly fabric: FabricDef;
  readonly variant: SwatchVariant;
}

const BRASS = { color: '#c8a04a', metalness: 1, roughness: 0.3, envMapIntensity: 1.4 } as const;

/** Un paño de tela doblado sobre la mesa con su textura PBR real (albedo + normal + rugosidad de la tela). */
function SwatchCloth({
  item,
  position,
  rotationY,
  selected,
  interactive,
  onPick,
  quality,
}: {
  item: SwatchItem;
  position: [number, number, number];
  rotationY: number;
  selected: boolean;
  interactive: boolean;
  onPick?: (id: string) => void;
  quality: 'low' | 'medium' | 'high';
}) {
  const set = useMemo(() => getFabricTextures(item.fabric, item.variant, quality), [item, quality]);
  const albedo = useMemo(() => toDataTexture(set, 'albedo'), [set]);
  const normal = useMemo(() => toDataTexture(set, 'normal'), [set]);
  useEffect(() => {
    // 20 cm de paño muestran media repetición de la tela como mínimo: el tejido se aprecia de cerca.
    const rep = Math.max(1, 0.2 / set.tileMeters);
    for (const t of [albedo, normal] as Texture[]) t.repeat.set(rep, rep);
    return () => {
      albedo.dispose();
      normal.dispose();
    };
  }, [albedo, normal, set]);
  const cloth = useMemo(() => {
    // Pliegue suave: la tapa del paño se ondula un poco.
    const g = new PlaneGeometry(0.2, 0.16, 14, 10);
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      p.setZ(i, 0.006 * Math.sin(x * 38) * Math.cos(y * 22) + 0.01 * Math.cos(x * 9));
    }
    g.computeVertexNormals();
    return g;
  }, []);
  useEffect(() => () => cloth.dispose(), [cloth]);
  return (
    <group
      position={position}
      rotation-y={rotationY}
      scale={selected ? 1.07 : 1}
      onClick={
        interactive
          ? (e) => {
              e.stopPropagation();
              onPick?.(item.id);
            }
          : undefined
      }
      onPointerOver={
        interactive
          ? (e) => {
              e.stopPropagation();
              document.body.style.cursor = 'pointer';
            }
          : undefined
      }
      onPointerOut={interactive ? () => (document.body.style.cursor = '') : undefined}
    >
      <RoundedBox args={[0.2, 0.026, 0.16]} radius={0.006} smoothness={3} position={[0, 0.013, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={item.variant.color} roughness={0.95} />
      </RoundedBox>
      <mesh geometry={cloth} rotation-x={-Math.PI / 2} position={[0, 0.028, 0]} castShadow receiveShadow>
        <meshStandardMaterial map={albedo} normalMap={normal} roughness={item.fabric.roughness} metalness={0} side={2} />
      </mesh>
      {selected && (
        <mesh position={[0, 0.002, 0]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[0.125, 0.14, 40]} />
          <meshBasicMaterial color="#ffd98a" toneMapped={false} transparent opacity={0.9} />
        </mesh>
      )}
    </group>
  );
}

/** Mesa de corte de roble con tapete, útiles de sastre y las muestras de tela (interactivas en el probador). */
export function CuttingTable({
  swatches,
  selectedId,
  interactive,
  onPick,
  q,
  quality,
}: {
  swatches: readonly SwatchItem[];
  selectedId: string | null;
  interactive: boolean;
  onPick: (id: string) => void;
  q: QualityConfig;
  quality: 'low' | 'medium' | 'high';
}) {
  const wood = getOakBoards(q.woodTex, 21, 4);
  const mat = useMemo(() => makeCuttingMat(), []);
  useEffect(() => () => mat.dispose(), [mat]);
  const topY = TABLE.height;
  const columns = 6;
  void DataTexture;
  void Float32BufferAttribute;
  return (
    <group position={[TABLE.x, 0, TABLE.z]} rotation-y={-0.2}>
      {/* tablero */}
      <mesh position={[0, topY - 0.03, 0]} castShadow receiveShadow>
        <boxGeometry args={[TABLE.width, 0.06, TABLE.depth]} />
        <meshStandardMaterial map={wood.map} normalMap={wood.normalMap} roughnessMap={wood.roughnessMap} roughness={1} color="#9a7a55" />
      </mesh>
      {/* faldón y patas */}
      <mesh position={[0, topY - 0.11, 0]} castShadow>
        <boxGeometry args={[TABLE.width - 0.18, 0.1, TABLE.depth - 0.18]} />
        <meshStandardMaterial color="#5a4129" roughness={0.7} />
      </mesh>
      {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => [sx, sz] as const)).map(([sx, sz]) => (
        <mesh key={`${sx}${sz}`} position={[sx * (TABLE.width / 2 - 0.1), (topY - 0.06) / 2, sz * (TABLE.depth / 2 - 0.1)]} castShadow>
          <cylinderGeometry args={[0.04, 0.03, topY - 0.06, 16]} />
          <meshStandardMaterial map={wood.map} roughness={0.75} color="#7a5b3b" />
        </mesh>
      ))}
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[TABLE.width - 0.2, 0.04, 0.05]} />
        <meshStandardMaterial color="#6a4d31" roughness={0.7} />
      </mesh>

      {/* tapete de corte */}
      <mesh position={[0.1, topY + 0.002, 0.02]} rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[1.35, 0.84]} />
        <meshStandardMaterial map={mat} roughness={0.75} />
      </mesh>

      {/* muestras */}
      {swatches.slice(0, 12).map((s, i) => {
        const row = Math.floor(i / columns);
        const col = i % columns;
        const x = 0.1 + (col - (columns - 1) / 2) * 0.215;
        const z = -0.1 + row * 0.19 + (col % 2) * 0.012;
        return (
          <SwatchCloth
            key={s.id}
            item={s}
            position={[x, topY + 0.005, z]}
            rotationY={((i * 37) % 11) * 0.012 - 0.06}
            selected={selectedId === s.id}
            interactive={interactive}
            onPick={onPick}
            quality={quality}
          />
        );
      })}

      {/* útiles */}
      <group position={[-0.74, topY, 0.22]}>
        {/* cinta métrica enrollada */}
        <mesh position={[0, 0.012, 0]} castShadow>
          <cylinderGeometry args={[0.055, 0.055, 0.024, 32]} />
          <meshStandardMaterial color="#e6d6a4" roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.026, 0]}>
          <cylinderGeometry args={[0.02, 0.02, 0.006, 24]} />
          <meshStandardMaterial {...BRASS} />
        </mesh>
        <mesh position={[0.2, 0.002, 0.05]} rotation-x={-Math.PI / 2} rotation-z={0.25}>
          <planeGeometry args={[0.4, 0.016]} />
          <meshStandardMaterial color="#e6d6a4" roughness={0.7} />
        </mesh>
      </group>
      {/* tijeras de sastre */}
      <group position={[-0.62, topY + 0.006, -0.22]} rotation-y={0.6}>
        {[1, -1].map((s) => (
          <mesh key={s} position={[0.07, 0, s * 0.006]} rotation-y={s * 0.05} castShadow>
            <boxGeometry args={[0.22, 0.004, 0.018]} />
            <meshStandardMaterial color="#b9bcc0" metalness={1} roughness={0.22} />
          </mesh>
        ))}
        {[1, -1].map((s) => (
          <mesh key={`h${s}`} position={[-0.075, 0, s * 0.026]} rotation-x={Math.PI / 2} castShadow>
            <torusGeometry args={[0.024, 0.006, 10, 24]} />
            <meshStandardMaterial color="#1b1511" roughness={0.45} metalness={0.3} />
          </mesh>
        ))}
      </group>
      {/* carretes */}
      {[
        ['#9b2d30', 0.7, 0.28],
        ['#2e4a7a', 0.77, 0.24],
        ['#e7d9b2', 0.72, 0.19],
      ].map(([c, x, z]) => (
        <group key={String(c)} position={[Number(x), topY + 0.03, Number(z)]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.022, 0.022, 0.06, 16]} />
            <meshStandardMaterial color={String(c)} roughness={0.85} />
          </mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[0, s * 0.032, 0]}>
              <cylinderGeometry args={[0.028, 0.028, 0.004, 16]} />
              <meshStandardMaterial {...BRASS} />
            </mesh>
          ))}
        </group>
      ))}
      {/* alfiletero */}
      <mesh position={[0.62, topY + 0.02, -0.3]} scale={[1, 0.55, 1]} castShadow>
        <sphereGeometry args={[0.04, 20, 14]} />
        <meshStandardMaterial color="#8c2a2a" roughness={0.95} />
      </mesh>
      {/* rollo de papel de patrones */}
      <mesh position={[0.2, topY + 0.045, -0.37]} rotation-z={Math.PI / 2} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 0.55, 24]} />
        <meshStandardMaterial color="#e9dfc7" roughness={0.9} />
      </mesh>
    </group>
  );
}
