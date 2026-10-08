import {
  CanvasTexture,
  Color,
  Group,
  LinearFilter,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  UnsignedByteType,
  VideoTexture,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import {
  JOINT_COUNT,
  computeSkinMatrices,
  type BodyModel,
  type SkeletonPose,
  type WorldCapsule,
} from '@fitroom/shared';
import { worldColliders } from '@fitroom/body';
import type { FittingModels, LoadedGarment } from '../contracts';
import type { RuntimeSample } from '../runtime/poseRuntime';
import { BodyRig } from './bodyRig';
import { getRoomEnvironment } from './environment';
import { GarmentRig } from './garmentRig';
import { MirrorLights } from './lights';
import { ScanOverlay } from './overlay';
import type { Quality, RigTimings } from './types';
import { SIMULATE_BY_QUALITY } from './types';
import { getWrinkleTexture } from './wrinkleMap';
import { NotImplementedError } from '@fitroom/shared';

export type VideoSourceSpec =
  | { readonly kind: 'video'; readonly element: HTMLVideoElement }
  | {
      readonly kind: 'canvas';
      readonly element: HTMLCanvasElement;
      /** Contador que sube cuando el canvas cambia (para subir la textura sólo entonces). */
      readonly version: () => number;
    };

export interface CompositorOptions {
  readonly renderer: WebGLRenderer;
  readonly quality: Quality;
  readonly verticalFovDeg: number;
  /** Función de colisionadores (inyectable en tests/doubles). Por defecto, la de @fitroom/body. */
  readonly colliders?: typeof worldColliders;
  /** Fábrica de solver (inyectable). */
  readonly createSolver?: ConstructorParameters<typeof GarmentRig>[1]['createSolver'];
}

export interface FrameReport {
  skinMs: number;
  clothMs: number;
  triangles: number;
  garmentCount: number;
}

/** Capas: orden de dibujo y separación a lo largo de la normal para que no se atraviesen. */
const LAYER = {
  lower: { order: 0, offset: 0 },
  full: { order: 0, offset: 0 },
  upper: { order: 1, offset: 0.0025 },
  outer: { order: 2, offset: 0.008 },
} as const;

const MAX_RT_WIDTH = 1280;
const MAX_RT_HEIGHT = 720;
const now = (): number => performance.now();

/**
 * Compone el espejo: una sub-escena propia (vídeo de fondo + cuerpo oclusor + prendas) con una cámara
 * virtual de FOV igual al del vídeo, renderizada a un RenderTarget a la resolución del vídeo. El mundo
 * 3D sólo muestra esa textura en un plano, así su post-proceso no altera el compuesto y `capture()` es
 * exacto. El volteo «espejo» NO se hace aquí: es del plano de visualización (vídeo+prendas juntos).
 */
export class MirrorCompositor {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly lights = new MirrorLights();
  readonly overlay = new ScanOverlay();
  private rt: WebGLRenderTarget;
  private bgTexture: Texture | null = null;
  private source: VideoSourceSpec | null = null;
  private lastCanvasVersion = -1;
  private quality: Quality;
  private fov: number;
  private aspect = 16 / 9;
  private readonly garmentGroup = new Group();
  private occluder: BodyRig | null = null;
  private body: BodyModel | null = null;
  private rigs = new Map<LoadedGarment, GarmentRig>();
  private readonly skin = new Float32Array(16 * JOINT_COUNT);
  private readonly capsules: WorldCapsule[] = [];
  private lastTeleports = 0;
  private lastTime = 0;
  private lastModels: Pick<FittingModels, 'body' | 'garments'> | null = null;
  private envReady = false;
  private disposed = false;
  private warnedColliders = false;
  readonly report: FrameReport = { skinMs: 0, clothMs: 0, triangles: 0, garmentCount: 0 };

  constructor(private readonly opts: CompositorOptions) {
    this.quality = opts.quality;
    this.fov = opts.verticalFovDeg;
    this.camera = new PerspectiveCamera(this.fov, this.aspect, 0.05, 30);
    this.camera.position.set(0, 0, 0); // cámara en el origen mirando a −Z (convención del proyecto)
    this.camera.lookAt(0, 0, -1);
    this.scene.background = new Color(0x15161b);
    this.scene.add(this.lights.group, this.garmentGroup, this.overlay.mesh);
    this.lights.setFocus(0, 0, -2.6);
    this.rt = this.makeTarget(1280, 720);
  }

  get texture(): Texture {
    return this.rt.texture;
  }
  get width(): number {
    return this.rt.width;
  }
  get height(): number {
    return this.rt.height;
  }
  get videoAspect(): number {
    return this.aspect;
  }

  private makeTarget(w: number, h: number): WebGLRenderTarget {
    const rt = new WebGLRenderTarget(w, h, {
      type: UnsignedByteType,
      colorSpace: SRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.quality === 'low' ? 0 : 4,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    rt.texture.name = 'mirror-composite';
    return rt;
  }

  // ---------------------------------------------------------------- configuración

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    const { width, height } = this.rt;
    this.rt.dispose();
    this.rt = this.makeTarget(width, height);
    // las prendas dependen de la calidad (simulación, sombras, arrugas): se reconstruyen
    for (const rig of this.rigs.values()) {
      rig.mesh.removeFromParent();
      rig.dispose();
    }
    this.rigs.clear();
    if (this.lastModels) this.syncModels(this.lastModels);
  }

  setFov(deg: number): void {
    if (!Number.isFinite(deg)) return;
    this.fov = Math.min(120, Math.max(20, deg));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  get verticalFov(): number {
    return this.fov;
  }

  setSource(src: VideoSourceSpec | null): void {
    if (this.source?.element === src?.element) return;
    this.bgTexture?.dispose();
    this.bgTexture = null;
    this.source = src;
    this.lastCanvasVersion = -1;
    if (!src) {
      this.scene.background = new Color(0x15161b);
      return;
    }
    const tex =
      src.kind === 'video' ? new VideoTexture(src.element) : new CanvasTexture(src.element);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    this.bgTexture = tex;
    this.scene.background = tex;
    this.syncSizeToSource();
  }

  /** Ajusta aspecto de la cámara virtual y tamaño del RenderTarget al vídeo (≤1280×720). */
  private syncSizeToSource(): void {
    const s = this.source;
    if (!s) return;
    const w = s.kind === 'video' ? s.element.videoWidth : s.element.width;
    const h = s.kind === 'video' ? s.element.videoHeight : s.element.height;
    if (!(w > 0 && h > 0)) return;
    const aspect = w / h;
    let tw = Math.min(w, MAX_RT_WIDTH);
    let th = Math.round(tw / aspect);
    if (th > MAX_RT_HEIGHT) {
      th = MAX_RT_HEIGHT;
      tw = Math.round(th * aspect);
    }
    if (tw !== this.rt.width || th !== this.rt.height) {
      this.rt.dispose();
      this.rt = this.makeTarget(tw, th);
    }
    if (Math.abs(aspect - this.aspect) > 1e-3) {
      this.aspect = aspect;
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Sincroniza cuerpo y prendas con los modelos listos (diferencial: no recrea lo que no cambió). */
  syncModels(models: Pick<FittingModels, 'body' | 'garments'>): void {
    if (this.disposed) return;
    this.lastModels = models;
    const bodyChanged = models.body !== this.body;
    if (bodyChanged) {
      this.occluder?.mesh.removeFromParent();
      this.occluder?.dispose();
      this.occluder = null;
      this.body = models.body;
      if (this.body) {
        this.occluder = new BodyRig(this.body, 'occluder');
        this.scene.add(this.occluder.mesh);
      }
    }
    const wanted = new Set(models.garments);
    // rigs que ya no se piden: se reaprovechan si sólo cambió la textura (misma geometría)
    const orphans = new Map<unknown, GarmentRig>();
    for (const [g, rig] of this.rigs) {
      if (wanted.has(g)) continue;
      this.rigs.delete(g);
      orphans.set(g.geometry, rig);
    }
    const wrinkle = this.quality === 'low' ? null : getWrinkleTexture();
    for (const g of models.garments) {
      if (this.rigs.has(g)) continue;
      const reuse = orphans.get(g.geometry);
      if (reuse) {
        orphans.delete(g.geometry);
        reuse.retexture(g);
        this.rigs.set(g, reuse);
        continue;
      }
      const layer = LAYER[g.geometry.slot];
      const rig = new GarmentRig(g, {
        quality: this.quality,
        mirror: true,
        wrinkleMap: wrinkle,
        layerOffsetM: layer.offset,
        renderOrder: 10 + layer.order,
        createSolver: this.opts.createSolver,
        castShadow: this.quality === 'high',
      });
      this.rigs.set(g, rig);
      this.garmentGroup.add(rig.mesh);
    }
    for (const rig of orphans.values()) {
      rig.mesh.removeFromParent();
      rig.dispose();
    }
  }

  // ---------------------------------------------------------------- fotograma

  /**
   * CPU: skinning del cuerpo oclusor y de las prendas, tela y luces. No toca la GPU.
   * @returns true si hay algo que dibujar con prendas (visibilidad > 0)
   */
  update(sample: RuntimeSample, nowMs: number, showGarments = true): boolean {
    this.syncSizeToSource();
    const dt = this.lastTime > 0 ? Math.min(0.05, Math.max(0, (nowMs - this.lastTime) / 1000)) : 1 / 60;
    this.lastTime = nowMs;
    this.ensureEnvironment();

    // luz estimada del vídeo
    const lit = this.lights.apply(sample.light, this.scene);
    for (const rig of this.rigs.values()) rig.setLight(lit.exposure, lit.tint);

    const pose = sample.pose;
    const body = this.body;
    const show = showGarments && !!pose && !!body && sample.visibility > 0.002;
    const report = this.report;
    report.skinMs = 0;
    report.clothMs = 0;
    report.triangles = 0;
    report.garmentCount = 0;
    if (this.occluder) this.occluder.mesh.visible = show;
    if (!show || !pose || !body) {
      for (const rig of this.rigs.values()) rig.mesh.visible = false;
      return false;
    }

    if (sample.teleportCount !== this.lastTeleports) {
      this.lastTeleports = sample.teleportCount;
      for (const rig of this.rigs.values()) rig.resetSimulation();
    }

    const t0 = now();
    computeSkinMatrices(body.skeleton, pose, this.skin);
    const simulate = SIMULATE_BY_QUALITY[this.quality];
    if (simulate) this.updateColliders(body);
    this.occluder?.update(this.skin);
    const tBody = now() - t0;
    report.skinMs += tBody;
    if (this.occluder) report.triangles += this.occluder.triangles;

    for (const rig of this.rigs.values()) {
      rig.setOpacity(sample.visibility);
      if (!rig.mesh.visible) continue;
      rig.update(this.skin, this.capsules, dt, simulate);
      report.skinMs += rig.timings.skinMs;
      report.clothMs += rig.timings.clothMs;
      report.triangles += rig.triangles;
      report.garmentCount++;
    }
    return true;
  }

  private updateColliders(body: BodyModel): void {
    const fn = this.opts.colliders ?? worldColliders;
    try {
      fn(body, this.skin, this.capsules);
    } catch (err) {
      this.capsules.length = 0;
      if (!this.warnedColliders && !(err instanceof NotImplementedError)) {
        this.warnedColliders = true;
        console.warn('[mirror] colisionadores no disponibles', err);
      }
    }
  }

  private ensureEnvironment(): void {
    if (this.envReady) return;
    this.envReady = true;
    try {
      this.scene.environment = getRoomEnvironment(this.opts.renderer);
    } catch (err) {
      console.warn('[mirror] no se pudo crear el environment procedural', err);
    }
  }

  /** GPU: dibuja la sub-escena en el RenderTarget (sin tocar el estado del renderer del mundo). */
  render(): void {
    if (this.disposed) return;
    const r = this.opts.renderer;
    if (this.source?.kind === 'canvas') {
      const v = this.source.version();
      if (v !== this.lastCanvasVersion) {
        this.lastCanvasVersion = v;
        if (this.bgTexture) this.bgTexture.needsUpdate = true;
      }
    }
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevShadow = r.shadowMap.enabled;
    r.autoClear = true;
    r.shadowMap.enabled = this.quality === 'high';
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    r.shadowMap.enabled = prevShadow;
  }

  // ---------------------------------------------------------------- captura

  /**
   * PNG del compuesto actual (vídeo + prendas), a la resolución del RenderTarget. Se vuelve a renderizar
   * justo antes de leer, así que es exacto aunque el fotograma de visualización vaya por detrás.
   */
  async capture(mirrored: boolean): Promise<Blob> {
    this.render();
    const { width: w, height: h } = this.rt;
    const px = new Uint8Array(w * h * 4);
    this.opts.renderer.readRenderTargetPixels(this.rt, 0, 0, w, h, px);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const srcRow = (h - 1 - y) * w * 4; // GL tiene el origen abajo-izquierda
      const dstRow = y * w * 4;
      if (!mirrored) {
        out.set(px.subarray(srcRow, srcRow + w * 4), dstRow);
      } else {
        for (let x = 0; x < w; x++) {
          const s = srcRow + (w - 1 - x) * 4;
          const d = dstRow + x * 4;
          out[d] = px[s]!;
          out[d + 1] = px[s + 1]!;
          out[d + 2] = px[s + 2]!;
          out[d + 3] = 255;
        }
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D no disponible para capturar');
    ctx.putImageData(new ImageData(out, w, h), 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo codificar el PNG'))), 'image/png');
    });
  }

  // ---------------------------------------------------------------- limpieza

  get garmentRigs(): ReadonlyMap<LoadedGarment, GarmentRig> {
    return this.rigs;
  }
  get bodyRig(): BodyRig | null {
    return this.occluder;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const rig of this.rigs.values()) {
      rig.mesh.removeFromParent();
      rig.dispose();
    }
    this.rigs.clear();
    this.occluder?.mesh.removeFromParent();
    this.occluder?.dispose();
    this.occluder = null;
    this.overlay.dispose();
    this.lights.dispose();
    this.bgTexture?.dispose();
    this.rt.dispose();
    this.scene.clear();
  }
}

export type { RigTimings, SkeletonPose };
