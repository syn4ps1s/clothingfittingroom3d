import type { ComponentType, ForwardRefExoticComponent, RefAttributes } from 'react';
import * as real from '../../mirror';
import { READY } from 'virtual:fitroom-status';
import { appParams } from '../../app/params';
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
} from '../../contracts';
import type { Measurements } from '@fitroom/shared';
import { MockBodyMannequin, MockGarmentView } from '../dev/MockBodies';
import { useMockBodyScan } from '../dev/MockBodyScan';
import { useMockFittingModels } from '../dev/MockFittingModels';
import { MockMirrorStage } from '../dev/MockMirrorStage';

/**
 * Punto único donde WORLD consume a MIRROR. Se importa SÓLO desde chunks cargados de forma diferida
 * (escena y pantallas pesadas) para no inflar el JS inicial.
 */
export const USE_REAL_MIRROR = READY.mirror && !appParams().mock;

export const AppMirrorStage: ForwardRefExoticComponent<MirrorStageProps & RefAttributes<MirrorHandle>> =
  USE_REAL_MIRROR ? real.MirrorStage : MockMirrorStage;

export const useAppBodyScan: (camera: CameraController, source: PoseSourceKind) => BodyScanApi =
  USE_REAL_MIRROR ? real.useBodyScan : useMockBodyScan;

export const useAppFittingModels: (
  measurements: Measurements | null,
  equipped: readonly EquippedItem[],
) => FittingModels = USE_REAL_MIRROR ? real.useFittingModels : useMockFittingModels;

export const AppGarmentView: ComponentType<GarmentViewProps> = USE_REAL_MIRROR
  ? real.GarmentView
  : MockGarmentView;

export const AppBodyMannequin: ComponentType<BodyMannequinProps> = USE_REAL_MIRROR
  ? real.BodyMannequin
  : MockBodyMannequin;
