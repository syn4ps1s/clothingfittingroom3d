import { LM, type PoseFrame } from '@fitroom/shared';

/**
 * «Vídeo» sintético dibujado en un canvas 2D: una habitación con ventana y una persona de muñeco dibujada
 * a partir de los landmarks de imagen del proveedor sintético. Permite probar el espejo de extremo a
 * extremo sin cámara (e2e) y COMPROBAR visualmente que la prenda 3D sigue al cuerpo dibujado: el muñeco
 * y la prenda salen de la misma verdad de terreno por caminos independientes.
 *
 * La imagen es SIN espejar (como la cámara); el efecto espejo se aplica después, al compuesto final.
 */
export interface SyntheticVideoOptions {
  readonly width?: number;
  readonly height?: number;
  /** Lado de la ventana luminosa (imagen sin espejar). Alimenta la estimación de luz. */
  readonly windowSide?: 'left' | 'right';
  /** Brillo global de la habitación 0.3..1.5 (para probar la adaptación a poca/mucha luz). */
  readonly brightness?: number;
  /** Dibujar los landmarks encima (depuración de alineación). */
  readonly debugLandmarks?: boolean;
}

type Ctx = CanvasRenderingContext2D;

interface P2 {
  x: number;
  y: number;
}

export class SyntheticVideo {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** Se incrementa en cada fotograma dibujado (el compositor sube la textura cuando cambia). */
  version = 0;
  private readonly ctx: Ctx;
  private opts: SyntheticVideoOptions;

  constructor(opts: SyntheticVideoOptions = {}) {
    this.opts = opts;
    this.width = opts.width ?? 1280;
    this.height = opts.height ?? 720;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D no disponible');
    this.ctx = ctx;
    this.drawBackdrop();
    this.version = 1;
  }

  setOptions(o: Partial<SyntheticVideoOptions>): void {
    this.opts = { ...this.opts, ...o };
  }

  /** Dibuja un fotograma: fondo + persona (si la hay). */
  draw(frame: PoseFrame | null): void {
    this.drawBackdrop();
    if (frame) this.drawPerson(frame);
    this.version++;
  }

  private drawBackdrop(): void {
    const { ctx, width: W, height: H } = this;
    const b = this.opts.brightness ?? 1;
    const k = (v: number): number => Math.round(Math.min(255, v * b));
    // pared
    const wall = ctx.createLinearGradient(0, 0, 0, H);
    wall.addColorStop(0, `rgb(${k(168)},${k(160)},${k(150)})`);
    wall.addColorStop(1, `rgb(${k(132)},${k(124)},${k(116)})`);
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, H);
    // suelo
    const floorY = H * 0.86;
    const floor = ctx.createLinearGradient(0, floorY, 0, H);
    floor.addColorStop(0, `rgb(${k(96)},${k(78)},${k(62)})`);
    floor.addColorStop(1, `rgb(${k(70)},${k(56)},${k(44)})`);
    ctx.fillStyle = floor;
    ctx.fillRect(0, floorY, W, H - floorY);
    ctx.fillStyle = `rgba(0,0,0,0.25)`;
    ctx.fillRect(0, floorY - 3, W, 4);
    // ventana luminosa en un lado
    const left = this.opts.windowSide !== 'right';
    const wx = left ? W * 0.04 : W * 0.74;
    const grad = ctx.createLinearGradient(wx, 0, wx + W * 0.22, 0);
    grad.addColorStop(0, `rgb(${k(250)},${k(246)},${k(232)})`);
    grad.addColorStop(1, `rgb(${k(214)},${k(226)},${k(240)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(wx, H * 0.1, W * 0.22, H * 0.5);
    ctx.fillStyle = `rgba(60,55,50,0.9)`;
    ctx.fillRect(wx + W * 0.105, H * 0.1, W * 0.01, H * 0.5);
    ctx.fillRect(wx, H * 0.34, W * 0.22, H * 0.01);
    // halo de luz de la ventana sobre la pared
    const halo = ctx.createRadialGradient(
      wx + W * 0.11,
      H * 0.35,
      W * 0.05,
      wx + W * 0.11,
      H * 0.35,
      W * 0.55,
    );
    halo.addColorStop(0, 'rgba(255,248,230,0.22)');
    halo.addColorStop(1, 'rgba(255,248,230,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);
    // un mueble de fondo para dar referencias de movimiento/escala
    ctx.fillStyle = `rgb(${k(90)},${k(70)},${k(58)})`;
    ctx.fillRect(left ? W * 0.76 : W * 0.06, H * 0.62, W * 0.17, H * 0.24);
  }

  private drawPerson(frame: PoseFrame): void {
    const { ctx, width: W, height: H } = this;
    const lm = frame.image;
    const wl = frame.world;
    if (lm.length < 33) return;
    const pt = (i: number): P2 => ({ x: lm[i]!.x * W, y: lm[i]!.y * H });
    const depth = (i: number): number => wl[i]?.z ?? 0;
    const mid = (a: P2, b: P2): P2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    const sh = mid(pt(LM.l_shoulder), pt(LM.r_shoulder));
    const hip = mid(pt(LM.l_hip), pt(LM.r_hip));
    const torsoPx = Math.hypot(sh.x - hip.x, sh.y - hip.y);
    if (!(torsoPx > 8)) return;
    const pxPerM = torsoPx / 0.5;

    const SKIN = '#c99978';
    const SKIN_D = '#a87a5e';
    const SHIRT = '#8f9aa6';
    const SHIRT_D = '#6f7a86';
    const PANTS = '#3b4352';
    const SHOE = '#2a2623';

    type Seg = { z: number; draw: () => void };
    const segs: Seg[] = [];
    const limb = (a: number, b: number, widthM: number, color: string, edge: string): void => {
      const A = pt(a),
        B = pt(b);
      segs.push({
        z: (depth(a) + depth(b)) / 2,
        draw: () => capsule(ctx, A, B, widthM * pxPerM, color, edge),
      });
    };

    // piernas y pies
    limb(LM.l_hip, LM.l_knee, 0.17, PANTS, '#2a303b');
    limb(LM.l_knee, LM.l_ankle, 0.12, PANTS, '#2a303b');
    limb(LM.r_hip, LM.r_knee, 0.17, PANTS, '#2a303b');
    limb(LM.r_knee, LM.r_ankle, 0.12, PANTS, '#2a303b');
    limb(LM.l_ankle, LM.l_foot_index, 0.09, SHOE, '#161412');
    limb(LM.r_ankle, LM.r_foot_index, 0.09, SHOE, '#161412');
    // brazos: camiseta hasta el codo, antebrazo y mano piel
    limb(LM.l_shoulder, LM.l_elbow, 0.1, SHIRT, SHIRT_D);
    limb(LM.l_elbow, LM.l_wrist, 0.075, SKIN, SKIN_D);
    limb(LM.l_wrist, LM.l_index, 0.065, SKIN, SKIN_D);
    limb(LM.r_shoulder, LM.r_elbow, 0.1, SHIRT, SHIRT_D);
    limb(LM.r_elbow, LM.r_wrist, 0.075, SKIN, SKIN_D);
    limb(LM.r_wrist, LM.r_index, 0.065, SKIN, SKIN_D);

    // tronco: polígono hombros-caderas (más ancho en la cintura que las caderas del esqueleto)
    const ls = pt(LM.l_shoulder),
      rs = pt(LM.r_shoulder),
      lh = pt(LM.l_hip),
      rh = pt(LM.r_hip);
    const zTorso = (depth(LM.l_shoulder) + depth(LM.r_shoulder) + depth(LM.l_hip) + depth(LM.r_hip)) / 4;
    segs.push({
      z: zTorso,
      draw: () => {
        const grow = (a: P2, c: P2, px: number): [P2, P2] => {
          const dx = c.x - a.x,
            dy = c.y - a.y;
          const l = Math.hypot(dx, dy) || 1;
          return [
            { x: a.x - (dx / l) * px, y: a.y - (dy / l) * px },
            { x: c.x + (dx / l) * px, y: c.y + (dy / l) * px },
          ];
        };
        const [lsx, rsx] = grow(ls, rs, 0.02 * pxPerM);
        const [lhx, rhx] = grow(lh, rh, 0.045 * pxPerM);
        ctx.fillStyle = SHIRT;
        ctx.strokeStyle = SHIRT_D;
        ctx.lineWidth = Math.max(1.5, pxPerM * 0.012);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(lsx.x, lsx.y);
        ctx.lineTo(rsx.x, rsx.y);
        ctx.lineTo(rhx.x, rhx.y);
        ctx.lineTo(lhx.x, lhx.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // pantalón desde la cintura
        ctx.fillStyle = PANTS;
        const k = 0.78;
        ctx.beginPath();
        ctx.moveTo(lhx.x + (lsx.x - lhx.x) * 0.0, lhx.y);
        ctx.lineTo(rhx.x, rhx.y);
        ctx.lineTo(rhx.x + (rh.x - rhx.x) * k, rhx.y + 0.08 * pxPerM);
        ctx.lineTo(lhx.x + (lh.x - lhx.x) * k, lhx.y + 0.08 * pxPerM);
        ctx.closePath();
        ctx.fill();
      },
    });

    // cuello y cabeza
    const nose = pt(LM.nose);
    const earMid = mid(pt(LM.l_ear), pt(LM.r_ear));
    const headC = { x: (nose.x + earMid.x) / 2, y: (nose.y + earMid.y) / 2 - 0.015 * pxPerM };
    const neckBase = sh;
    segs.push({
      z: depth(LM.nose) * 0.5,
      draw: () => {
        capsule(ctx, neckBase, headC, 0.1 * pxPerM, SKIN, SKIN_D);
        ctx.fillStyle = SKIN;
        ctx.strokeStyle = SKIN_D;
        ctx.lineWidth = Math.max(1.5, pxPerM * 0.01);
        ctx.beginPath();
        ctx.ellipse(headC.x, headC.y, 0.085 * pxPerM, 0.11 * pxPerM, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // pelo
        ctx.fillStyle = '#3a2a22';
        ctx.beginPath();
        ctx.ellipse(headC.x, headC.y - 0.035 * pxPerM, 0.088 * pxPerM, 0.085 * pxPerM, 0, Math.PI, Math.PI * 2);
        ctx.fill();
      },
    });

    segs.sort((a, b) => a.z - b.z); // atrás → delante (+Z hacia la cámara)
    for (const s of segs) s.draw();

    if (this.opts.debugLandmarks) {
      ctx.fillStyle = '#ff2d55';
      for (const i of [
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
        const p = pt(i);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function capsule(ctx: Ctx, a: P2, b: P2, widthPx: number, fill: string, edge: string): void {
  ctx.lineCap = 'round';
  ctx.strokeStyle = edge;
  ctx.lineWidth = Math.max(2, widthPx + 3);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.strokeStyle = fill;
  ctx.lineWidth = Math.max(1, widthPx);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}
