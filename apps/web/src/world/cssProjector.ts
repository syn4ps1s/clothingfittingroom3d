import { Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { forEachAnchor, type AnchorPose } from './anchors';

/**
 * Proyector CSS3D: escribe `matrix3d` en cada panel DOM anclado para que se vea con la MISMA perspectiva que
 * la escena WebGL (misma cámara, mismo FOV). Es el mismo modelo que usa `Html transform` de drei, pero opera
 * sobre elementos que viven en el árbol normal de React (con sus contextos, foco y orden de tabulación).
 */
const epsilon = (v: number) => (Math.abs(v) < 1e-10 ? 0 : v);

function cssMatrix(elements: ArrayLike<number>, mult: readonly number[], prepend = ''): string {
  let out = `${prepend}matrix3d(`;
  for (let i = 0; i < 16; i++) out += epsilon(mult[i]! * elements[i]!) + (i === 15 ? ')' : ',');
  return out;
}

const CAMERA_MULT = [1, -1, 1, 1, 1, -1, 1, 1, 1, -1, 1, 1, 1, -1, 1, 1] as const;
const objectMult = (f: number): number[] => [
  1 / f, 1 / f, 1 / f, 1,
  -1 / f, -1 / f, -1 / f, -1,
  1 / f, 1 / f, 1 / f, 1,
  1, 1, 1, 1,
];

const m = new Matrix4();
const rot = new Matrix4();
const pos = new Vector3();
const q = new Quaternion();
const sc = new Vector3(1, 1, 1);
const fwd = new Vector3();
const toPanel = new Vector3();
const vx = new Vector3();
const vy = new Vector3();
const vz = new Vector3();

function poseMatrix(pose: AnchorPose, out: Matrix4): Matrix4 {
  const [bx, by, bz] = pose.basis;
  rot.makeBasis(vx.set(bx[0], bx[1], bx[2]), vy.set(by[0], by[1], by[2]), vz.set(bz[0], bz[1], bz[2]));
  q.setFromRotationMatrix(rot);
  pos.set(...pose.position);
  return out.compose(pos, q, sc);
}

export interface ProjectionTarget {
  readonly container: HTMLElement; // .css3d (lleva la perspectiva)
  readonly cameraEl: HTMLElement; // .css3d__camera (lleva la transformación de cámara)
}

/** Escribe la transformación de cada panel. Devuelve cuántos paneles se han colocado. */
export function projectAnchors(
  camera: PerspectiveCamera,
  width: number,
  height: number,
  target: ProjectionTarget,
): number {
  camera.updateMatrixWorld();
  const fov = (camera.projectionMatrix.elements[5] ?? 1) * (height / 2);
  const { container, cameraEl } = target;
  container.style.perspective = `${fov}px`;
  cameraEl.style.width = `${width}px`;
  cameraEl.style.height = `${height}px`;
  cameraEl.style.transform = `translateZ(${fov}px)${cssMatrix(camera.matrixWorldInverse.elements, CAMERA_MULT)}translate(${width / 2}px,${height / 2}px)`;

  camera.getWorldDirection(fwd);
  let placed = 0;
  forEachAnchor((_id, { el, pose }) => {
    poseMatrix(pose, m);
    el.style.transform = cssMatrix(m.elements, objectMult(pose.pxPerMeter), 'translate(-50%,-50%)');
    // Un panel detrás de la cámara no se dibuja (evita reflejos 3D con perspectiva invertida).
    toPanel.set(...pose.position).sub(camera.position);
    el.style.visibility = toPanel.dot(fwd) < 0.15 ? 'hidden' : 'visible';
    if (el.dataset.placed !== 'true') el.dataset.placed = 'true';
    placed++;
  });
  return placed;
}
