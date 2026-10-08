import { useEffect, useMemo } from 'react';
import { ExtrudeGeometry, Shape } from 'three';
import type { GarmentDefinition, Measurements } from '@fitroom/shared';
import { getCatalog } from './api/catalog';
import { AppBodyMannequin, AppGarmentView, useAppFittingModels } from './api/mirror';
import type { EquippedItem } from '../contracts';
import { RACK } from './layout';
import type { QualityConfig } from './quality';
import { getOakBoards } from './textures/atelierTextures';

export interface RackItem {
  readonly garment: GarmentDefinition;
  readonly size: string;
  readonly variantId: string;
}

const BRASS = { color: '#c8a04a', metalness: 1, roughness: 0.28, envMapIntensity: 1.5 } as const;

function equippedOf(item: RackItem): EquippedItem[] {
  const catalog = getCatalog();
  const fabric = catalog.fabric(item.garment.fabricId);
  if (!fabric) return [];
  const variant = item.garment.variants.find((v) => v.id === item.variantId) ?? item.garment.variants[0]!;
  const trimFabric = item.garment.trimFabricId ? catalog.fabric(item.garment.trimFabricId) : undefined;
  return [{ garment: item.garment, fabric, trimFabric, variant, sizeLabel: item.size }];
}

/** Un maniquí del perchero con su prenda. Los modelos (cuerpo + prenda) los prepara MIRROR (`useFittingModels`). */
function RackSlot({
  item,
  x,
  measurements,
  highlighted,
  onPick,
  onHover,
  woodTex,
  quality,
}: {
  item: RackItem;
  x: number;
  measurements: Measurements;
  highlighted: boolean;
  onPick: (g: GarmentDefinition) => void;
  onHover: (id: string | null) => void;
  woodTex: number;
  quality: 'low' | 'medium' | 'high';
}) {
  const key = `${item.garment.id}|${item.size}|${item.variantId}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const equipped = useMemo(() => equippedOf(item), [key]);
  const models = useAppFittingModels(measurements, equipped);
  const wood = getOakBoards(woodTex, 21, 4);
  const body = models.status === 'ready' ? models.body : null;

  return (
    <group position={[x, 0, 0.32]} rotation-y={-x * 0.12}>
      {/* peana */}
      <mesh position={[0, 0.03, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.27, 0.29, 0.06, 48]} />
        <meshStandardMaterial map={wood.map} normalMap={wood.normalMap} roughnessMap={wood.roughnessMap} roughness={1} color="#8a6a48" />
      </mesh>
      <mesh position={[0, 0.062, 0]} rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.272, 0.007, 12, 64]} />
        <meshStandardMaterial {...BRASS} emissive={highlighted ? '#ffcf80' : '#000'} emissiveIntensity={highlighted ? 0.9 : 0} />
      </mesh>
      <group position={[0, 0.06, 0]}>
        {body && (
          <>
            <AppBodyMannequin body={body} look="mannequin" />
            {models.garments.map((g) => (
              <AppGarmentView key={`${g.item.garment.id}-${g.item.sizeLabel}-${g.item.variant.id}`} garment={g} body={body} quality={quality} />
            ))}
          </>
        )}
      </group>
      {/* zona clicable invisible */}
      <mesh
        position={[0, 1, 0]}
        onClick={(e) => {
          e.stopPropagation();
          onPick(item.garment);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
          onHover(item.garment.id);
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
          onHover(null);
        }}
      >
        <cylinderGeometry args={[0.3, 0.3, 2, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Siluetas de prendas colgadas (extruidas con bisel): dan cuerpo y color al fondo del perchero. */
function hangingShape(kind: 'shirt' | 'dress' | 'coat'): Shape {
  const s = new Shape();
  const len = kind === 'shirt' ? 0.74 : kind === 'dress' ? 1.05 : 1.18;
  const hem = kind === 'shirt' ? 0.19 : kind === 'dress' ? 0.3 : 0.24;
  const sleeve = kind === 'dress' ? 0.2 : 0.3;
  s.moveTo(-0.055, -0.035);
  s.lineTo(-0.2, -0.08);
  s.lineTo(-sleeve - 0.02, -0.3);
  s.lineTo(-sleeve + 0.05, -0.33);
  s.lineTo(-0.2, -0.19);
  s.lineTo(-hem, -len);
  s.lineTo(hem, -len);
  s.lineTo(0.2, -0.19);
  s.lineTo(sleeve - 0.05, -0.33);
  s.lineTo(sleeve + 0.02, -0.3);
  s.lineTo(0.2, -0.08);
  s.lineTo(0.055, -0.035);
  s.quadraticCurveTo(0, -0.12, -0.055, -0.035);
  return s;
}

function HangingGarments({ colors }: { colors: readonly string[] }) {
  const geos = useMemo(
    () =>
      (['shirt', 'dress', 'coat'] as const).map(
        (k) => new ExtrudeGeometry(hangingShape(k), { depth: 0.035, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2 }),
      ),
    [],
  );
  useEffect(() => () => geos.forEach((g) => g.dispose()), [geos]);
  const railY = 1.86;
  return (
    <group>
      {colors.map((c, i) => {
        const kind = i % 5 === 1 ? 1 : i % 5 === 3 ? 2 : 0;
        return (
          <group key={i} position={[-0.95 + i * 0.27, railY, 0]} rotation-y={0.05 * (i % 3) - 0.05}>
            <mesh geometry={geos[kind]} position={[0, -0.04, -0.017]} castShadow receiveShadow>
              <meshStandardMaterial color={c} roughness={0.9} />
            </mesh>
            <mesh position={[0, 0.0, 0]} rotation-x={Math.PI / 2}>
              <torusGeometry args={[0.022, 0.0032, 8, 20, Math.PI * 1.5]} />
              <meshStandardMaterial {...BRASS} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/** El perchero de latón a la izquierda: riel con prendas colgadas y, delante, hasta cuatro maniquíes con prendas. */
export function Rack({
  items,
  measurements,
  hoveredId,
  onPick,
  onHover,
  q,
  quality,
  hangingColors,
}: {
  items: readonly RackItem[];
  measurements: Measurements;
  hoveredId: string | null;
  onPick: (g: GarmentDefinition) => void;
  onHover: (id: string | null) => void;
  q: QualityConfig;
  quality: 'low' | 'medium' | 'high';
  hangingColors: readonly string[];
}) {
  const railLen = 2.7;
  const wood = getOakBoards(q.woodTex, 21, 4);
  return (
    <group position={[RACK.x, 0, RACK.z]}>
      {/* riel y montantes */}
      <group position={[0, 0, -0.62]}>
        <mesh position={[0, 1.9, 0]} rotation-z={Math.PI / 2} castShadow>
          <cylinderGeometry args={[0.016, 0.016, railLen, 20]} />
          <meshStandardMaterial {...BRASS} />
        </mesh>
        {[-1, 1].map((s) => (
          <group key={s} position={[(s * railLen) / 2, 0, 0]}>
            <mesh position={[0, 0.95, 0]} castShadow>
              <cylinderGeometry args={[0.018, 0.018, 1.9, 20]} />
              <meshStandardMaterial {...BRASS} />
            </mesh>
            <mesh position={[0, 1.93, 0]} castShadow>
              <sphereGeometry args={[0.032, 20, 14]} />
              <meshStandardMaterial {...BRASS} />
            </mesh>
            <mesh position={[0, 0.03, 0.05]} castShadow receiveShadow>
              <boxGeometry args={[0.07, 0.06, 0.7]} />
              <meshStandardMaterial map={wood.map} normalMap={wood.normalMap} roughnessMap={wood.roughnessMap} roughness={1} color="#7c5f40" />
            </mesh>
          </group>
        ))}
        <HangingGarments colors={hangingColors} />
      </group>
      {items.map((item, i) => (
        <RackSlot
          key={item.garment.id}
          item={item}
          x={(i - (items.length - 1) / 2) * 0.64 - 0.0}
          measurements={measurements}
          highlighted={hoveredId === item.garment.id}
          onPick={onPick}
          onHover={onHover}
          woodTex={q.woodTex}
          quality={quality}
        />
      ))}
    </group>
  );
}
