import { DirectionalLight, Group, Object3D, type Scene } from 'three';
import type { LightEstimate } from '../runtime/lightEstimator';

export interface LightingResult {
  /** Multiplicador de exposición para el shader de las prendas. */
  exposure: number;
  /** Tinte (balance de blancos) para el shader de las prendas. */
  tint: [number, number, number];
}

/**
 * Luces del espejo: una luz clave suave + una de relleno, ajustadas a la luz estimada del vídeo
 * (exposición ∝ luminancia, tinte ∝ color medio, dirección ∝ lado más brillante) para que la prenda
 * parezca iluminada por la habitación del usuario y no «pegada» sobre el vídeo.
 */
export class MirrorLights {
  readonly group = new Group();
  readonly key: DirectionalLight;
  readonly fill: DirectionalLight;
  private readonly target = new Object3D();
  private readonly result: LightingResult = { exposure: 1, tint: [1, 1, 1] };

  constructor() {
    this.key = new DirectionalLight(0xffffff, 2.2);
    this.fill = new DirectionalLight(0xdfe8ff, 0.6);
    this.group.name = 'mirror-lights';
    this.group.add(this.key, this.fill, this.target);
    this.key.target = this.target;
    this.fill.target = this.target;
    this.key.castShadow = false;
  }

  /** Centro de la escena iluminada (el cuerpo), en espacio cámara. */
  setFocus(x: number, y: number, z: number): void {
    this.target.position.set(x, y, z);
    this.target.updateMatrixWorld();
  }

  /**
   * @param estimate estimación de luz del vídeo
   * @param scene escena donde ajustar environmentIntensity/Rotation
   */
  apply(estimate: LightEstimate, scene: Scene): LightingResult {
    const t = this.target.position;
    const lin = Math.min(1, Math.max(0.004, estimate.lumaLinear));
    const exposure = clamp(0.92 * Math.pow(lin / 0.2, 0.5), 0.35, 1.5);
    const contrast = estimate.contrast;

    // la luz clave viene del lado más brillante de la imagen (imagen SIN espejar: +X = derecha de la imagen)
    this.key.position.set(
      t.x + estimate.dirX * 2.2,
      t.y + 1.6 + estimate.dirY * 1.2,
      t.z + 2.4,
    );
    this.key.intensity = 1.0 + contrast * 1.2;
    this.fill.position.set(t.x - estimate.dirX * 2.0, t.y + 0.4, t.z + 1.8);
    this.fill.intensity = 0.28;

    scene.environmentIntensity = 0.62 - 0.2 * contrast;
    scene.environmentRotation.y = estimate.dirX * 0.9;

    // tinte: mezcla del color medio con blanco (no teñir en exceso)
    const k = 0.6;
    const r = this.result;
    r.exposure = exposure;
    r.tint[0] = 1 + (estimate.tint[0] - 1) * k;
    r.tint[1] = 1 + (estimate.tint[1] - 1) * k;
    r.tint[2] = 1 + (estimate.tint[2] - 1) * k;
    // las luces siguen también el tinte
    this.key.color.setRGB(r.tint[0], r.tint[1], r.tint[2]);
    return r;
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
