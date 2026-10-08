import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MathUtils, Vector3, type PerspectiveCamera } from 'three';
import { useApp } from '../state/store';
import { onAnchorsChanged } from './anchors';
import { projectAnchors } from './cssProjector';
import { cameraPoseFor, type StageKey } from './layout';
import { useView } from './viewStore';

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const DURATION = 1.7;

/**
 * Cámara del atelier: viaja entre las poses de cada pantalla con easing cinematográfico y un paralaje mínimo
 * del puntero. Con «reducir movimiento» salta directamente a la pose y no hay paralaje. Tras mover la cámara,
 * proyecta los paneles DOM anclados (CSS3D) con la misma perspectiva.
 */
export function CameraRig() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const stage = useApp((s) => s.flow.stage) as StageKey;
  const layout = useView((s) => s.layout);
  const reduced = useView((s) => s.reducedMotion);

  const from = useRef({ pos: new Vector3(), look: new Vector3() });
  const to = useRef({ pos: new Vector3(), look: new Vector3() });
  const now = useRef({ pos: new Vector3(), look: new Vector3() });
  const progress = useRef(1);
  const started = useRef(false);
  const pointer = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const targetEls = useRef<{ container: HTMLElement; cameraEl: HTMLElement } | null>(null);
  const tmp = useRef({ right: new Vector3(), up: new Vector3() });

  const findEls = () => {
    if (targetEls.current?.cameraEl.isConnected) return targetEls.current;
    const cameraEl = document.getElementById('css3d-camera');
    const container = cameraEl?.parentElement;
    targetEls.current = cameraEl && container ? { container, cameraEl } : null;
    return targetEls.current;
  };

  const project = () => {
    const els = findEls();
    if (els) projectAnchors(camera, size.width, size.height, els);
  };

  // Nueva pantalla → nueva pose objetivo.
  useEffect(() => {
    const pose = cameraPoseFor(stage, layout);
    to.current.pos.set(...pose.position);
    to.current.look.set(...pose.target);
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
    if (!started.current || reduced) {
      now.current.pos.copy(to.current.pos);
      now.current.look.copy(to.current.look);
      from.current.pos.copy(to.current.pos);
      from.current.look.copy(to.current.look);
      progress.current = 1;
      started.current = true;
    } else {
      from.current.pos.copy(now.current.pos);
      from.current.look.copy(now.current.look);
      progress.current = 0;
    }
    invalidate();
  }, [stage, layout, reduced, camera, invalidate]);

  // Los paneles que se montan/desmontan se colocan en el acto (sin parpadeo).
  useEffect(() => {
    const off = onAnchorsChanged(() => {
      project();
      invalidate();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, size.width, size.height]);

  useEffect(() => {
    if (reduced) return undefined;
    const onMove = (e: PointerEvent) => {
      pointer.current.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      pointer.current.ty = (e.clientY / window.innerHeight - 0.5) * 2;
      invalidate();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [reduced, invalidate]);

  useFrame((state, dt) => {
    const p = pointer.current;
    let moving = false;
    if (progress.current < 1) {
      progress.current = Math.min(1, progress.current + dt / DURATION);
      const k = easeInOut(progress.current);
      now.current.pos.lerpVectors(from.current.pos, to.current.pos, k);
      now.current.look.lerpVectors(from.current.look, to.current.look, k);
      moving = progress.current < 1;
    }
    // Paralaje suave del puntero (desactivado con reducir movimiento).
    const px = reduced ? 0 : p.tx;
    const py = reduced ? 0 : p.ty;
    if (Math.abs(p.x - px) > 1e-3 || Math.abs(p.y - py) > 1e-3) {
      p.x = MathUtils.damp(p.x, px, 4, dt);
      p.y = MathUtils.damp(p.y, py, 4, dt);
      moving = true;
    }
    camera.position.copy(now.current.pos);
    camera.lookAt(now.current.look);
    camera.updateMatrixWorld();
    if (p.x !== 0 || p.y !== 0) {
      const { right, up } = tmp.current;
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      camera.position.addScaledVector(right, p.x * 0.07).addScaledVector(up, -p.y * 0.04);
      camera.lookAt(now.current.look);
    }
    project();
    if (moving) state.invalidate();
  });

  return null;
}
