import { useEffect, useState } from 'react';
import { computeSkinMatrices, restPose } from '@fitroom/shared';
import type { BodyMannequinProps } from '../contracts';
import { BodyRig } from './bodyRig';

/**
 * Cuerpo del usuario como maniquí mate, fantasma translúcido u oclusor invisible (sólo profundidad).
 * Barato: se skinnea UNA vez cuando cambia el cuerpo o la pose (no por fotograma) y libera sus
 * geometrías/materiales al desmontarse.
 */
export function BodyMannequin({ body, pose, look = 'mannequin' }: BodyMannequinProps) {
  const [rig, setRig] = useState<BodyRig | null>(null);

  useEffect(() => {
    const r = new BodyRig(body, look);
    setRig(r);
    return () => {
      r.dispose();
      setRig(null);
    };
    // el aspecto se cambia aparte (setLook) sin recrear la geometría
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  useEffect(() => {
    rig?.setLook(look);
  }, [rig, look]);

  useEffect(() => {
    if (!rig) return;
    rig.update(computeSkinMatrices(body.skeleton, pose ?? restPose(body.skeleton)));
  }, [rig, body, pose, look]);

  return rig ? <primitive object={rig.mesh} /> : null;
}
