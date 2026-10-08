/**
 * API pública del espejo (contrato con WORLD, ver `apps/web/src/contracts.ts`).
 * Estado de la entrega: `apps/web/src/mirror/STATUS.md`.
 */
export { MirrorStage } from './MirrorStage';
export type { MirrorStageExtras, MirrorStageAllProps } from './MirrorStage';
export { GarmentView } from './GarmentView';
export { BodyMannequin } from './BodyMannequin';
export { useBodyScan } from '../runtime/bodyScan';
export { useFittingModels } from '../runtime/useFittingModels';
export type { UseFittingModelsOptions } from '../runtime/useFittingModels';
export type { FittingSnapshot, FittingTimings } from '../runtime/fitting/engine';
