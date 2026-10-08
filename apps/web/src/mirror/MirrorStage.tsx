import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { Material, MeshBasicMaterial, Texture } from 'three';
import type { ScanProgress } from '@fitroom/shared';
import type {
  MirrorHandle,
  MirrorStageProps,
  MirrorStats,
  TrackingState,
} from '../contracts';
import { PoseRuntime } from '../runtime/poseRuntime';
import type { TrackingConfig } from '../runtime/trackingMachine';
import {
  acquireCameraFeed,
  acquireSyntheticFeed,
  type CameraFeedHandle,
  type SyntheticHandle,
} from '../runtime/feeds';
import { getVerticalFov, intrinsicsFor } from '../runtime/intrinsics';
import { bodyKeyOf } from '../runtime/fitting/tasks';
import { useFittingModels } from '../runtime/useFittingModels';
import { MirrorCompositor } from './compositor';
import { TEXTURE_SIZE_BY_QUALITY } from './types';

/**
 * Ampliaciones ADITIVAS de las props del contrato (todas opcionales; WORLD puede ignorarlas):
 */
export interface MirrorStageExtras {
  /** FOV vertical asumido de la cámara (grados). Por defecto el calibrado/típico (≈55°). */
  readonly fovDeg?: number;
  /** 'scan' dibuja la guía de escaneo (silueta + esqueleto) y oculta las prendas. Por defecto 'fit'. */
  readonly mode?: 'fit' | 'scan';
  /** Progreso del escaneo para colorear la guía (verde/ámbar). */
  readonly scanProgress?: ScanProgress;
  /** Se invoca cuando cambia la relación de aspecto REAL del vídeo (para que el mundo ajuste el plano). */
  readonly onVideoAspect?: (aspect: number) => void;
  /** Depuración del cuerpo-oclusor: 'off' lo desactiva, 'visible' lo muestra como maniquí translúcido. */
  readonly debugOccluder?: 'on' | 'off' | 'visible';
  /** Umbrales de seguimiento (histéresis, tiempo hasta «perdido», fundidos). Para equipos lentos o pruebas. */
  readonly trackingConfig?: Partial<TrackingConfig>;
}

export type MirrorStageAllProps = MirrorStageProps & MirrorStageExtras;

/** Texture transform del plano: recorte «cover» + volteo espejo horizontal FINAL (vídeo y prendas juntos). */
export function applyDisplayTransform(
  tex: Texture,
  planeAspect: number,
  videoAspect: number,
  mirrored: boolean,
): void {
  let sx = 1;
  let sy = 1;
  if (planeAspect > videoAspect) sy = videoAspect / planeAspect;
  else sx = planeAspect / videoAspect;
  tex.repeat.set(mirrored ? -sx : sx, sy);
  tex.offset.set(mirrored ? 0.5 + sx / 2 : 0.5 - sx / 2, 0.5 - sy / 2);
}

export const MirrorStage = forwardRef<MirrorHandle, MirrorStageAllProps>(function MirrorStage(
  props,
  ref,
) {
  const {
    width,
    height,
    measurements,
    equipped,
    poseSource,
    camera,
    mirrored = true,
    quality = 'medium',
    onTrackingChange,
    onStats,
    onVideoAspect,
    mode = 'fit',
    scanProgress,
  } = props;
  const gl = useThree((s) => s.gl);
  const fov = props.fovDeg ?? getVerticalFov();

  const models = useFittingModels(measurements, equipped, {
    textureSize: TEXTURE_SIZE_BY_QUALITY[quality],
  });
  const modelsRef = useRef(models);
  modelsRef.current = models;

  // ---- compositor (sub-escena + RenderTarget)
  const [compositor, setCompositor] = useState<MirrorCompositor | null>(null);
  const compositorRef = useRef<MirrorCompositor | null>(null);
  useEffect(() => {
    const c = new MirrorCompositor({ renderer: gl, quality, verticalFovDeg: fov });
    compositorRef.current = c;
    setCompositor(c);
    return () => {
      compositorRef.current = null;
      c.dispose();
      setCompositor(null);
    };
    // El compositor se crea una vez por renderer; calidad y FOV se aplican abajo sin recrearlo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl]);
  useEffect(() => compositor?.setQuality(quality), [compositor, quality]);
  useEffect(() => compositor?.setFov(fov), [compositor, fov]);
  const debugOccluder = props.debugOccluder ?? 'on';
  useEffect(() => compositor?.setOccluderMode(debugOccluder), [compositor, debugOccluder]);
  useEffect(() => compositor?.syncModels(models), [compositor, models]);

  // ---- tubería de pose
  const [runtime, setRuntime] = useState<PoseRuntime | null>(null);
  const runtimeRef = useRef<PoseRuntime | null>(null);
  const bodyKey = bodyKeyOf(measurements);
  const cameraVideo = camera.video;
  const fovRef = useRef(fov);
  fovRef.current = fov;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  videoRef.current = cameraVideo;

  const camHandleRef = useRef<CameraFeedHandle | null>(null);
  const trackingConfigRef = useRef(props.trackingConfig);
  trackingConfigRef.current = props.trackingConfig;
  useEffect(() => {
    if (!compositor) return;
    let rt: PoseRuntime;
    let synthHandle: SyntheticHandle | null = null;
    const intrinsics = () =>
      intrinsicsFor(
        poseSource === 'synthetic' ? (synthHandle?.synth.video.canvas ?? null) : videoRef.current,
        fovRef.current,
      );
    if (poseSource === 'synthetic') {
      synthHandle = acquireSyntheticFeed(mode === 'scan' ? 'scan' : 'tour', {
        heightCm: measurements.heightCm,
        measurements,
        fovDeg: fovRef.current,
      });
      const synth = synthHandle.synth;
      compositor.setSource({
        kind: 'canvas',
        element: synth.video.canvas,
        version: () => synth.video.version,
      });
      rt = new PoseRuntime({
        feed: synth.feed,
        getRest: () => modelsRef.current.body?.skeleton ?? null,
        getIntrinsics: intrinsics,
        getLightSource: () => synth.video.canvas,
        trackingConfig: trackingConfigRef.current,
      });
    } else {
      const handle = acquireCameraFeed();
      camHandleRef.current = handle;
      handle.setVideo(videoRef.current);
      compositor.setSource(
        videoRef.current ? { kind: 'video', element: videoRef.current } : null,
      );
      rt = new PoseRuntime({
        feed: handle.feed,
        getRest: () => modelsRef.current.body?.skeleton ?? null,
        getIntrinsics: intrinsics,
        getLightSource: () => videoRef.current,
        trackingConfig: trackingConfigRef.current,
      });
    }
    runtimeRef.current = rt;
    setRuntime(rt);
    return () => {
      runtimeRef.current = null;
      rt.dispose();
      camHandleRef.current?.setVideo(null);
      camHandleRef.current?.release();
      camHandleRef.current = null;
      synthHandle?.release();
      compositor.setSource(null);
      setRuntime(null);
    };
    // La tubería depende de la fuente, del cuerpo (altura/proporciones del sintético) y del modo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositor, poseSource, mode, bodyKey]);

  // cámara real: enlaza el <video> al feed de detección y al fondo del espejo cuando cambia
  useEffect(() => {
    if (poseSource !== 'camera' || !compositor) return;
    camHandleRef.current?.setVideo(cameraVideo);
    compositor.setSource(cameraVideo ? { kind: 'video', element: cameraVideo } : null);
  }, [poseSource, compositor, runtime, cameraVideo]);

  // seguimiento → callback
  const onTrackingRef = useRef(onTrackingChange);
  onTrackingRef.current = onTrackingChange;
  useEffect(() => {
    if (!runtime) return;
    onTrackingRef.current?.(runtime.tracking.state);
    return runtime.onTrackingChange((s: TrackingState) => onTrackingRef.current?.(s));
  }, [runtime]);

  // ---- métricas (≈1 Hz)
  const statsRef = useRef({
    frames: 0,
    last: performance.now(),
    skin: 0,
    cloth: 0,
    tris: 0,
  });
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const onAspectRef = useRef(onVideoAspect);
  onAspectRef.current = onVideoAspect;
  const lastAspectRef = useRef(0);

  // ---- bucle por fotograma (antes del render del mundo)
  const matRef = useRef<MeshBasicMaterial>(null);
  useFrame((state) => {
    const c = compositorRef.current;
    const rt = runtimeRef.current;
    if (!c || !rt) return;
    const now = performance.now();
    const sample = rt.sample(now);
    const scanning = mode === 'scan';
    c.overlay.setVisible(scanning);
    if (scanning) c.overlay.draw(sample.frame, scanProgress ?? null);
    c.update(sample, now, !scanning); // en modo escaneo no se dibujan prendas
    c.render();

    // textura de visualización: recorte «cover» y volteo espejo
    const mat = matRef.current;
    if (mat) {
      const tex = c.texture;
      if (mat.map !== tex) {
        mat.map = tex;
        mat.needsUpdate = true;
      }
      applyDisplayTransform(tex, width / height, c.videoAspect, mirrored);
    }
    if (Math.abs(c.videoAspect - lastAspectRef.current) > 1e-3) {
      lastAspectRef.current = c.videoAspect;
      onAspectRef.current?.(c.videoAspect);
    }

    // estadísticas
    const st = statsRef.current;
    st.frames++;
    st.skin = st.skin * 0.9 + c.report.skinMs * 0.1;
    st.cloth = st.cloth * 0.9 + c.report.clothMs * 0.1;
    st.tris = c.report.triangles;
    if (now - st.last >= 1000) {
      const fps = (st.frames * 1000) / (now - st.last);
      st.frames = 0;
      st.last = now;
      const cb = onStatsRef.current;
      if (cb) {
        const stats: MirrorStats = {
          fps,
          poseMs: rt.stats.poseMs,
          skinMs: st.skin,
          clothMs: st.cloth,
          triangles: st.tris,
        };
        cb(stats);
      }
    }
    if (state.frameloop === 'demand') state.invalidate();
  }, -5);

  useImperativeHandle(
    ref,
    () => ({
      capture: () => {
        const c = compositorRef.current;
        if (!c) return Promise.reject(new Error('El espejo aún no está listo'));
        return c.capture(mirrored);
      },
    }),
    [mirrored],
  );

  const planeGeometryArgs = useMemo<[number, number]>(() => [width, height], [width, height]);
  return (
    <mesh name="mirror-plane">
      <planeGeometry args={planeGeometryArgs} />
      <meshBasicMaterial ref={matRef} toneMapped={false} color="#ffffff" />
    </mesh>
  );
});

export type { Material };
