import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CameraController } from '../contracts';
import { CameraManager } from './cameraManager';

/**
 * Cámara del usuario (frontal, 1280×720 ideal). `start()` sólo debe llamarse desde un gesto del usuario.
 * Al desmontar el componente se detienen todas las pistas. El vídeo jamás sale del navegador.
 */
export function useCamera(): CameraController {
  const [manager] = useState(() => new CameraManager());
  useEffect(() => {
    manager.attach();
    return () => manager.detach();
  }, [manager]);
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
}
