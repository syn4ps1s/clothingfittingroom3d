import {
  CanvasTexture,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  LinearFilter,
} from 'three';
import { LM, type PoseFrame, type ScanHint, type ScanProgress } from '@fitroom/shared';

const BONES: readonly (readonly [number, number])[] = [
  [LM.l_shoulder, LM.r_shoulder],
  [LM.l_shoulder, LM.l_elbow],
  [LM.l_elbow, LM.l_wrist],
  [LM.r_shoulder, LM.r_elbow],
  [LM.r_elbow, LM.r_wrist],
  [LM.l_shoulder, LM.l_hip],
  [LM.r_shoulder, LM.r_hip],
  [LM.l_hip, LM.r_hip],
  [LM.l_hip, LM.l_knee],
  [LM.l_knee, LM.l_ankle],
  [LM.r_hip, LM.r_knee],
  [LM.r_knee, LM.r_ankle],
  [LM.l_ankle, LM.l_foot_index],
  [LM.r_ankle, LM.r_foot_index],
];

/** Pistas que son un "todo correcto" (guía en verde). */
const GOOD_HINTS: ReadonlySet<ScanHint> = new Set<ScanHint>(['ok', 'hold-still']);

/**
 * Superposición de guía del escaneo: silueta objetivo + esqueleto detectado, dibujados en un canvas 2D
 * que se pinta como un plano a pantalla completa DENTRO del espejo (así sale también en la captura y
 * recibe el volteo espejo junto con el vídeo). Sin texto: la UI usa las pistas (`ScanHint`) por i18n.
 */
export class ScanOverlay {
  readonly mesh: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private lastKey = '';

  constructor(
    private readonly w = 640,
    private readonly h = 360,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D no disponible');
    this.ctx = ctx;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    const mat = new ShaderMaterial({
      uniforms: { map: { value: this.texture } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(map, vUv);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;
    this.mesh.visible = false;
    this.mesh.name = 'scan-overlay';
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  /** Redibuja sólo si cambió algo relevante (≤30 Hz por la cadencia de detección). */
  draw(frame: PoseFrame | null, progress: ScanProgress | null): void {
    const key = `${frame?.timestampMs ?? 'n'}|${progress?.hint ?? ''}|${progress?.progress.toFixed(2) ?? ''}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const good = !!progress && GOOD_HINTS.has(progress.hint);
    const color = good ? '#4ade80' : '#fbbf24';
    // silueta objetivo (sin espejar): óvalo de cabeza + trapecio del cuerpo, centrada
    ctx.save();
    ctx.strokeStyle = color + 'aa';
    ctx.fillStyle = color + '14';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    const cx = w / 2;
    ctx.beginPath();
    ctx.ellipse(cx, h * 0.14, h * 0.055, h * 0.07, 0, 0, Math.PI * 2);
    ctx.moveTo(cx - h * 0.16, h * 0.27);
    ctx.lineTo(cx + h * 0.16, h * 0.27);
    ctx.lineTo(cx + h * 0.2, h * 0.58);
    ctx.lineTo(cx + h * 0.14, h * 0.94);
    ctx.lineTo(cx - h * 0.14, h * 0.94);
    ctx.lineTo(cx - h * 0.2, h * 0.58);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (frame && frame.image.length >= 33) {
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      for (const [a, b] of BONES) {
        const A = frame.image[a]!,
          B = frame.image[b]!;
        if (A.visibility < 0.3 || B.visibility < 0.3) continue;
        ctx.globalAlpha = Math.min(1, Math.min(A.visibility, B.visibility) + 0.2);
        ctx.beginPath();
        ctx.moveTo(A.x * w, A.y * h);
        ctx.lineTo(B.x * w, B.y * h);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      for (const i of [
        LM.nose,
        LM.l_shoulder,
        LM.r_shoulder,
        LM.l_elbow,
        LM.r_elbow,
        LM.l_wrist,
        LM.r_wrist,
        LM.l_hip,
        LM.r_hip,
        LM.l_knee,
        LM.r_knee,
        LM.l_ankle,
        LM.r_ankle,
      ]) {
        const p = frame.image[i]!;
        if (p.visibility < 0.3) continue;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // barra de progreso inferior
    if (progress && progress.progress > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(w * 0.25, h * 0.965, w * 0.5, 6);
      ctx.fillStyle = color;
      ctx.fillRect(w * 0.25, h * 0.965, w * 0.5 * Math.min(1, progress.progress), 6);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
    this.texture.dispose();
  }
}
