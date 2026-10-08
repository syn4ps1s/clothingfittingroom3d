import { forwardRef } from 'react';
import { NotImplementedError } from '@fitroom/shared';
import type { Measurements } from '@fitroom/shared';
import type {
  BodyMannequinProps,
  BodyScanApi,
  CameraController,
  EquippedItem,
  FittingModels,
  GarmentViewProps,
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

/** STUB — implementar en el agente MIRROR. */
export function useFittingModels(
  _measurements: Measurements | null,
  _equipped: readonly EquippedItem[],
): FittingModels {
  throw new NotImplementedError('web.useFittingModels');
}

/** STUB — implementar en el agente MIRROR. */
export function GarmentView(_props: GarmentViewProps): never {
  throw new NotImplementedError('web.GarmentView');
}

/** STUB — implementar en el agente MIRROR. */
export function BodyMannequin(_props: BodyMannequinProps): never {
  throw new NotImplementedError('web.BodyMannequin');
}
