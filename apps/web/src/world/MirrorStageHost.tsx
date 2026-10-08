import { useMemo } from 'react';
import type { CameraController, PoseSourceKind } from '../contracts';
import { appParams } from '../app/params';
import { useApp } from '../state/store';
import { AppMirrorStage } from './api/mirror';
import { completeMeasurementsApi } from './api/body';
import { buildEquipped, getCatalog } from './api/catalog';
import { MIRROR } from './layout';
import { mirrorHandle } from './mirrorHandle';
import { viewStore } from './viewStore';

/** Monta el espejo de MIRROR (real o simulado) en el cristal, con lo que lleva puesta la persona. */
export function MirrorStageHost({ camera }: { camera: CameraController }) {
  const measurements = useApp((s) => s.measurements);
  const heightCm = useApp((s) => s.draft.fields.heightCm.value);
  const bodyBase = useApp((s) => s.draft.bodyBase);
  const worn = useApp((s) => s.worn);
  const view = useApp((s) => s.view);
  const mirrored = useApp((s) => s.settings.mirrored);
  const quality = useApp((s) => s.settings.quality);
  const catalog = getCatalog();
  const poseSource: PoseSourceKind = appParams().synthetic ? 'synthetic' : 'camera';

  const equipped = useMemo(() => (view === 'before' ? [] : buildEquipped(worn, catalog)), [worn, view, catalog]);
  // Mientras se mide aún no hay medidas confirmadas: el espejo usa una estimación sólo con la estatura.
  const preview = useMemo(
    () => measurements ?? completeMeasurementsApi({ heightCm: heightCm ?? 170, bodyBase }),
    [measurements, heightCm, bodyBase],
  );

  return (
    <AppMirrorStage
      ref={mirrorHandle}
      width={MIRROR.width}
      height={MIRROR.height}
      measurements={preview}
      equipped={equipped}
      poseSource={poseSource}
      camera={camera}
      mirrored={mirrored}
      quality={quality}
      onTrackingChange={(s) => viewStore.getState().setTracking(s)}
      onStats={(s) => viewStore.getState().setStats(s)}
    />
  );
}
