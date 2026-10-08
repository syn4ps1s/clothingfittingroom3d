import { forwardRef } from 'react';
import { NotImplementedError } from '@fitroom/shared';
import type {
  BodyScanApi,
  CameraController,
  MirrorHandle,
  MirrorStageProps,
  PoseSourceKind,
} from '../contracts';

/** STUB de la fundación — implementar en el agente MIRROR. */
export const MirrorStage = forwardRef<MirrorHandle, MirrorStageProps>(function MirrorStage() {
  throw new NotImplementedError('web.MirrorStage');
});

/** STUB de la fundación — implementar en el agente MIRROR. */
export function useBodyScan(_camera: CameraController, _source: PoseSourceKind): BodyScanApi {
  throw new NotImplementedError('web.useBodyScan');
}
