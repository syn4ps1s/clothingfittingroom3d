/**
 * ARNÉS DE DESARROLLO del espejo (no forma parte de la app de WORLD). Se sirve con Vite en
 * `/src/mirror/dev/mirror-harness.html` y permite verificar el espejo de extremo a extremo en Chromium:
 *
 *   ?source=synthetic|camera   fuente de pose (sintética por defecto)
 *   ?quality=low|medium|high   calidad
 *   ?doubles=1                 usa los dobles de desarrollo en vez de @fitroom/garments
 *   ?garments=tee-essential,jeans-slim-stretch   ids del catálogo (por defecto una camiseta)
 *   ?size=M&variant=0          talla y muestra
 *   ?mirrored=0                sin efecto espejo
 *   ?mode=scan                 guía de escaneo
 *
 * `window.__mirror` expone el control para scripts de captura (ver shoot.mjs).
 */
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas } from '@react-three/fiber';
import { ACESFilmicToneMapping } from 'three';
import { REFERENCE_MEASUREMENTS, type GarmentDefinition, type Measurements } from '@fitroom/shared';
import { loadCatalogData } from '@fitroom/catalog';
import { useCamera } from '../../camera';
import type { EquippedItem, MirrorHandle, MirrorStats, TrackingState } from '../../contracts';
import { FittingEngine } from '../../runtime/fitting/engine';
import { acquireSyntheticFeed, type SyntheticFeed } from '../../runtime/feeds';
import { getVerticalFov } from '../../runtime/intrinsics';
import { setSharedFittingEngine, useFittingModels } from '../../runtime/useFittingModels';
import { MirrorStage } from '../MirrorStage';
import { setDefaultSolverFactory } from '../garmentRig';
import { DoublesExecutor } from './doublesExecutor';
import { SpringSolver, doubleEquipped } from './doubles';

const params = new URLSearchParams(location.search);
const useDoubles = params.get('doubles') === '1';
if (useDoubles) {
  setSharedFittingEngine(new FittingEngine(new DoublesExecutor()));
  setDefaultSolverFactory((g) => new SpringSolver(g));
}

const MEASURE_PRESETS: Record<string, Measurements> = {
  a: REFERENCE_MEASUREMENTS.adultA,
  b: REFERENCE_MEASUREMENTS.adultB,
  small: REFERENCE_MEASUREMENTS.small,
  large: REFERENCE_MEASUREMENTS.large,
};

function pickEquipped(ids: readonly string[], size: string, variantIdx: number): EquippedItem[] {
  if (useDoubles) return [doubleEquipped('upper')];
  const cat = loadCatalogData();
  const out: EquippedItem[] = [];
  for (const id of ids) {
    const garment: GarmentDefinition | undefined = cat.garments.find((g) => g.id === id);
    if (!garment) continue;
    const fabric = cat.fabrics.find((f) => f.id === garment.fabricId);
    if (!fabric) continue;
    const trimFabric = garment.trimFabricId
      ? cat.fabrics.find((f) => f.id === garment.trimFabricId)
      : undefined;
    const variant = garment.variants[Math.min(variantIdx, garment.variants.length - 1)]!;
    const sizeLabel = garment.sizes.some((s) => s.label === size) ? size : garment.sizes[0]!.label;
    out.push({ garment, fabric, ...(trimFabric ? { trimFabric } : {}), variant, sizeLabel });
  }
  return out;
}

declare global {
  interface Window {
    __mirror?: MirrorControl;
  }
}

interface MirrorControl {
  ready: boolean;
  tracking: TrackingState;
  stats: MirrorStats | null;
  models: { status: string; garments: number; errorMessage?: string };
  seek(ms: number | null): void;
  groundTruthAt(ms: number): unknown;
  capture(): Promise<string>;
  setEquipped(ids: string[], size?: string, variant?: number): void;
  setQuality(q: 'low' | 'medium' | 'high'): void;
  setMeasurements(preset: string): void;
  scriptTime(): number;
}

function Harness() {
  const camera = useCamera();
  const source = params.get('source') === 'camera' ? 'camera' : 'synthetic';
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>(
    (params.get('quality') as 'low' | 'medium' | 'high' | null) ?? 'medium',
  );
  const [measurements, setMeasurements] = useState<Measurements>(
    MEASURE_PRESETS[params.get('m') ?? 'a'] ?? REFERENCE_MEASUREMENTS.adultA,
  );
  const initialIds = (params.get('garments') ?? 'tee-essential').split(',').filter(Boolean);
  const [equipped, setEquipped] = useState<EquippedItem[]>(() =>
    pickEquipped(initialIds, params.get('size') ?? 'M', Number(params.get('variant') ?? 0)),
  );
  const mirrored = params.get('mirrored') !== '0';
  const mode = params.get('mode') === 'scan' ? 'scan' : 'fit';
  const [tracking, setTracking] = useState<TrackingState>('initializing');
  const [stats, setStats] = useState<MirrorStats | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const mirrorRef = useRef<MirrorHandle>(null);
  const synthRef = useRef<SyntheticFeed | null>(null);
  const models = useFittingModels(measurements, equipped, {
    textureSize: quality === 'low' ? 512 : quality === 'medium' ? 1024 : 2048,
  });

  // controla el mismo feed sintético que usa el espejo (la clave es la misma)
  useEffect(() => {
    if (source !== 'synthetic') return;
    const h = acquireSyntheticFeed(mode === 'scan' ? 'scan' : 'tour', {
      heightCm: measurements.heightCm,
      measurements,
      fovDeg: getVerticalFov(),
    });
    synthRef.current = h.synth;
    return () => {
      synthRef.current = null;
      h.release();
    };
  }, [source, measurements, mode]);

  const control = useRef<MirrorControl | null>(null);
  control.current = {
    ready: tracking === 'tracking' && models.status === 'ready',
    tracking,
    stats,
    models: {
      status: models.status,
      garments: models.garments.length,
      ...(models.errorMessage ? { errorMessage: models.errorMessage } : {}),
    },
    seek: (ms) => synthRef.current?.seek(ms),
    groundTruthAt: (ms) => synthRef.current?.groundTruth(ms),
    scriptTime: () => synthRef.current?.scriptTime() ?? 0,
    capture: async () => {
      const blob = await mirrorRef.current!.capture();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      return `data:image/png;base64,${btoa(bin)}`;
    },
    setEquipped: (ids, size = 'M', variant = 0) => setEquipped(pickEquipped(ids, size, variant)),
    setQuality,
    setMeasurements: (preset) => setMeasurements(MEASURE_PRESETS[preset] ?? measurements),
  };
  useEffect(() => {
    window.__mirror = new Proxy({} as MirrorControl, {
      get: (_t, k) => (control.current as unknown as Record<string, unknown>)[k as string],
    });
    return () => {
      window.__mirror = undefined;
    };
  }, []);

  const planeW = 1.6;
  const planeH = planeW / aspect;
  const fitDistance = useMemo(() => planeH / 2 / Math.tan((40 * Math.PI) / 360), [planeH]);

  return (
    <>
      {source === 'camera' && camera.status !== 'ready' && (
        <button id="start-camera" onClick={() => void camera.start()}>
          Encender cámara ({camera.status})
        </button>
      )}
      <Canvas
        camera={{ position: [0, 0, fitDistance], fov: 40 }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        onCreated={({ gl }) => {
          // el mundo usa tone mapping filmic; el compuesto del espejo NO debe verse afectado
          gl.toneMapping = ACESFilmicToneMapping;
        }}
      >
        <color attach="background" args={['#0b0b10']} />
        <MirrorStage
          ref={mirrorRef}
          width={planeW}
          height={planeH}
          measurements={measurements}
          equipped={equipped}
          poseSource={source}
          camera={camera}
          mirrored={mirrored}
          quality={quality}
          mode={mode}
          onTrackingChange={setTracking}
          onStats={setStats}
          onVideoAspect={setAspect}
        />
      </Canvas>
      <div id="hud">
        {tracking} · {models.status} · {models.garments.length} prendas
        {stats
          ? ` · ${stats.fps.toFixed(0)} fps · pose ${stats.poseMs.toFixed(1)} ms · skin ${stats.skinMs.toFixed(1)} · tela ${stats.clothMs.toFixed(1)} · ${stats.triangles} tris`
          : ''}
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
