import { READY } from 'virtual:fitroom-status';
import { useCamera } from '../../camera';
import { appParams } from '../../app/params';
import { useMockCamera } from '../dev/MockCamera';

/** ¿Se usa la cámara real? Sólo cuando MIRROR está READY y no se pidió `?mock=1`. */
export const USE_REAL_CAMERA = READY.mirror && !appParams().mock;

/** Un único punto de entrada para la cámara de la app (real o simulada). */
export const useAppCamera = USE_REAL_CAMERA ? useCamera : useMockCamera;
