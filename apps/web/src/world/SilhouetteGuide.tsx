import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, CanvasTexture, SRGBColorSpace, type Material } from 'three';
import { MIRROR } from './layout';
import { useView } from './viewStore';

/** Dibuja una silueta humana (postura en A) con trazo discontinuo de latón y marcas de encuadre. */
function drawGuide(ok: boolean): HTMLCanvasElement {
  const w = 288;
  const h = Math.round((w * MIRROR.height) / MIRROR.width);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const cx = w / 2;
  const top = h * 0.08;
  const H = h * 0.84;
  const col = ok ? '#bfe08a' : '#ffdf9a';
  ctx.strokeStyle = col;
  ctx.fillStyle = ok ? 'rgba(190,225,130,0.08)' : 'rgba(255,223,154,0.06)';
  ctx.lineWidth = 3.2;
  ctx.setLineDash([10, 8]);
  ctx.lineJoin = 'round';
  const p = new Path2D();
  // cabeza
  p.ellipse(cx, top + H * 0.065, H * 0.045, H * 0.058, 0, 0, Math.PI * 2);
  // cuerpo (contorno único en A)
  p.moveTo(cx - H * 0.03, top + H * 0.115);
  p.lineTo(cx - H * 0.032, top + H * 0.15);
  p.bezierCurveTo(cx - H * 0.16, top + H * 0.165, cx - H * 0.2, top + H * 0.2, cx - H * 0.27, top + H * 0.42);
  p.lineTo(cx - H * 0.24, top + H * 0.44);
  p.lineTo(cx - H * 0.17, top + H * 0.3);
  p.lineTo(cx - H * 0.115, top + H * 0.46);
  p.lineTo(cx - H * 0.12, top + H * 0.5);
  p.lineTo(cx - H * 0.12, top + H * 0.97);
  p.lineTo(cx - H * 0.03, top + H * 0.97);
  p.lineTo(cx - H * 0.02, top + H * 0.52);
  p.lineTo(cx + H * 0.02, top + H * 0.52);
  p.lineTo(cx + H * 0.03, top + H * 0.97);
  p.lineTo(cx + H * 0.12, top + H * 0.97);
  p.lineTo(cx + H * 0.12, top + H * 0.5);
  p.lineTo(cx + H * 0.115, top + H * 0.46);
  p.lineTo(cx + H * 0.17, top + H * 0.3);
  p.lineTo(cx + H * 0.24, top + H * 0.44);
  p.lineTo(cx + H * 0.27, top + H * 0.42);
  p.bezierCurveTo(cx + H * 0.2, top + H * 0.2, cx + H * 0.16, top + H * 0.165, cx + H * 0.032, top + H * 0.15);
  p.lineTo(cx + H * 0.03, top + H * 0.115);
  ctx.fill(p);
  ctx.stroke(p);
  // marcas de encuadre en las esquinas
  ctx.setLineDash([]);
  ctx.lineWidth = 4;
  const m = 22;
  for (const [x, y, dx, dy] of [
    [12, 12, 1, 1],
    [w - 12, 12, -1, 1],
    [12, h - 12, 1, -1],
    [w - 12, h - 12, -1, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x + dx * m, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * m);
    ctx.stroke();
  }
  // línea de suelo
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - H * 0.3, top + H * 0.985);
  ctx.lineTo(cx + H * 0.3, top + H * 0.985);
  ctx.stroke();
  return c;
}

/** Guía visible mientras se pide la estatura y se escanea. Respira suavemente (quieta con «reducir movimiento»). */
export function SilhouetteGuide({ ok = false }: { ok?: boolean }) {
  const reduced = useView((s) => s.reducedMotion);
  const tex = useMemo(() => {
    const t = new CanvasTexture(drawGuide(ok));
    t.colorSpace = SRGBColorSpace;
    return t;
  }, [ok]);
  useEffect(() => () => tex.dispose(), [tex]);
  const mat = useRef<Material & { opacity: number }>(null);
  useFrame(({ clock }) => {
    if (mat.current) mat.current.opacity = reduced ? 0.8 : 0.62 + 0.2 * Math.sin(clock.elapsedTime * 1.8);
  });
  return (
    <mesh position={[0, 0, 0.006]} renderOrder={3}>
      <planeGeometry args={[MIRROR.width, MIRROR.height]} />
      <meshBasicMaterial ref={mat as never} map={tex} transparent depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
    </mesh>
  );
}
