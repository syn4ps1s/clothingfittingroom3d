import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CameraController, CameraStatus } from '../../contracts';
import { appParams } from '../../app/params';

/**
 * Cámara simulada fiel al contrato `CameraController`. El modo se elige con `?mockcam=`
 * (denied | unavailable | insecure | error | slow) para probar cada ruta de error sin hardware.
 */
export function useMockCamera(): CameraController {
  const mode = appParams().mockCam;
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const timer = useRef<number | undefined>(undefined);
  const video = useRef<HTMLVideoElement | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const stop = useCallback(() => {
    window.clearTimeout(timer.current);
    video.current = null;
    setStatus('idle');
    setErrorMessage(undefined);
  }, []);

  const start = useCallback(async () => {
    if (status === 'requesting' || status === 'ready') return;
    setErrorMessage(undefined);
    if (mode === 'insecure-context') {
      setStatus('insecure-context');
      return;
    }
    setStatus('requesting');
    await new Promise<void>((resolve) => {
      timer.current = window.setTimeout(resolve, mode === 'slow' ? 2500 : 250);
    });
    if (!alive.current) return;
    switch (mode) {
      case 'denied':
        setStatus('denied');
        return;
      case 'unavailable':
        setStatus('unavailable');
        return;
      case 'error':
        setErrorMessage('NotReadableError: Could not start video source');
        setStatus('error');
        return;
      default:
        video.current = document.createElement('video');
        setStatus('ready');
    }
  }, [mode, status]);

  return useMemo<CameraController>(
    () => ({ status, video: status === 'ready' ? video.current : null, errorMessage, start, stop }),
    [status, errorMessage, start, stop],
  );
}
