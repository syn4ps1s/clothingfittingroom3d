import { createContext, useContext, type ReactNode } from 'react';
import type { CameraController } from '../contracts';

const Ctx = createContext<CameraController | null>(null);

export function CameraProvider({ camera, children }: { camera: CameraController; children: ReactNode }) {
  return <Ctx.Provider value={camera}>{children}</Ctx.Provider>;
}

/** La cámara única de la aplicación (real o simulada). */
export function useCameraController(): CameraController {
  const camera = useContext(Ctx);
  if (!camera) throw new Error('useCameraController requiere <CameraProvider>');
  return camera;
}
