import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { JOINT_COUNT, computeSkinMatrices, restPose, type WorldCapsule } from '@fitroom/shared';
import { worldColliders } from '@fitroom/body';
import type { GarmentViewProps } from '../contracts';
import { getRoomEnvironment } from './environment';
import { GarmentRig } from './garmentRig';
import { getWrinkleTexture } from './wrinkleMap';

const OFFSET_BY_SLOT = { lower: 0, full: 0, upper: 0.0025, outer: 0.008 } as const;

/**
 * Prenda ya cargada, fuera del espejo (perchero, vitrinas, vista previa). Sin simulación se skinnea una
 * sola vez por cambio de pose; con `simulate` corre el solver de tela en cada fotograma. Libera sus
 * geometrías, materiales y texturas al desmontarse. El tone mapping lo pone el mundo (no el shader).
 */
export function GarmentView({
  garment,
  body,
  pose,
  simulate = false,
  quality = 'medium',
}: GarmentViewProps) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const [rig, setRig] = useState<GarmentRig | null>(null);
  const skin = useRef(new Float32Array(16 * JOINT_COUNT));
  const caps = useRef<WorldCapsule[]>([]);

  useEffect(() => {
    const r = new GarmentRig(garment, {
      quality,
      mirror: false,
      wrinkleMap: quality === 'low' ? null : getWrinkleTexture(),
      layerOffsetM: OFFSET_BY_SLOT[garment.geometry.slot],
    });
    // si el mundo no tiene environment propio, usamos el procedural para que la tela no se vea plana
    if (!scene.environment) {
      try {
        r.setEnvMap(getRoomEnvironment(gl));
      } catch {
        /* sin environment: se queda con las luces del mundo */
      }
    }
    setRig(r);
    return () => {
      r.dispose();
      setRig(null);
    };
  }, [garment, quality, gl, scene]);

  const apply = (dt: number, sim: boolean): void => {
    if (!rig) return;
    const p = pose ?? restPose(body.skeleton);
    computeSkinMatrices(body.skeleton, p, skin.current);
    if (sim) {
      try {
        worldColliders(body, skin.current, caps.current);
      } catch {
        caps.current.length = 0;
      }
    }
    rig.update(skin.current, caps.current, dt, sim);
  };

  useEffect(() => {
    if (rig && !simulate) apply(1 / 60, false);
    // `apply` depende sólo de los valores listados
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rig, body, pose, simulate]);

  useFrame((_, dt) => {
    if (rig && simulate) apply(Math.min(dt, 1 / 20), true);
  });

  return rig ? <primitive object={rig.mesh} /> : null;
}
