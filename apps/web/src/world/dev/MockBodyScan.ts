import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScanHint } from '@fitroom/shared';
import type { BodyScanApi, CameraController, PoseSourceKind, ScanProgress } from '../../contracts';
import { appParams } from '../../app/params';
import { mockEstimate } from './devBody';

const IDLE: ScanProgress = { phase: 'idle', hint: 'ok', progress: 0, framesUsed: 0 };

interface Step {
  readonly at: number;
  readonly progress: ScanProgress;
}

/** Guion del escaneo simulado (ms a velocidad 1): recorre las fases y varias pistas reales. */
function script(): readonly Step[] {
  const p = (phase: ScanProgress['phase'], hint: ScanHint, progress: number, frames: number): ScanProgress => ({
    phase,
    hint,
    progress,
    framesUsed: frames,
  });
  return [
    { at: 0, progress: p('searching', 'no-person', 0.02, 0) },
    { at: 700, progress: p('adjusting', 'step-back', 0.1, 0) },
    { at: 1500, progress: p('adjusting', 'raise-arms-a-pose', 0.2, 0) },
    { at: 2300, progress: p('hold', 'hold-still', 0.35, 12) },
    { at: 3000, progress: p('hold', 'hold-still', 0.55, 40) },
    { at: 3700, progress: p('hold', 'ok', 0.75, 70) },
    { at: 4400, progress: p('capturing', 'ok', 0.92, 96) },
  ];
}

/**
 * Escaneo simulado fiel a `BodyScanApi`. `?mockspeed=N` lo acelera N veces (pruebas e2e).
 * La estimación es proporcional a la estatura, con incertidumbres plausibles.
 */
export function useMockBodyScan(_camera: CameraController, _source: PoseSourceKind): BodyScanApi {
  const speed = appParams().mockSpeed;
  const [progress, setProgress] = useState<ScanProgress>(IDLE);
  const [estimate, setEstimate] = useState<BodyScanApi['estimate']>(null);
  const timers = useRef<number[]>([]);

  const clear = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);
  useEffect(() => clear, [clear]);

  const cancel = useCallback(() => {
    clear();
    setProgress(IDLE);
    setEstimate(null);
  }, [clear]);

  const start = useCallback(
    (heightCm: number) => {
      clear();
      setEstimate(null);
      const steps = script();
      for (const step of steps) {
        timers.current.push(window.setTimeout(() => setProgress(step.progress), step.at / speed));
      }
      timers.current.push(
        window.setTimeout(() => {
          setEstimate(mockEstimate(heightCm));
          setProgress({ phase: 'complete', hint: 'ok', progress: 1, framesUsed: 120 });
        }, 5000 / speed),
      );
    },
    [clear, speed],
  );

  return useMemo(() => ({ progress, estimate, start, cancel }), [progress, estimate, start, cancel]);
}
