import { NotImplementedError } from '@fitroom/shared';
import type { CameraController } from '../contracts';

/** STUB de la fundación — implementar en el agente MIRROR. */
export function useCamera(): CameraController {
  throw new NotImplementedError('web.useCamera');
}
