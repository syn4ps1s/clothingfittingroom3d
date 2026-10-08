import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import type { Measurements } from '@fitroom/shared';
import type { EquippedItem, MirrorHandle, MirrorStageProps, TrackingState } from '../../contracts';
import { generateDevFabricTextures } from './devFabric';

const PX_W = 384;

/** Convierte un set de texturas de desarrollo en un patrón 2D reutilizable por la silueta de la prenda. */
function makePattern(ctx: CanvasRenderingContext2D, item: EquippedItem): CanvasPattern | null {
  const set = generateDevFabricTextures(item.fabric, item.variant, 96);
  const tile = document.createElement('canvas');
  tile.width = tile.height = set.size;
  const t = tile.getContext('2d');
  if (!t) return null;
  const img = t.createImageData(set.size, set.size);
  img.data.set(set.albedo);
  t.putImageData(img, 0, 0);
  return ctx.createPattern(tile, 'repeat');
}

interface Figure {
  readonly cx: number;
  readonly floor: number;
  readonly k: number; // px por cm
  readonly m: Measurements;
}

function polygon(ctx: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

/** Puntos de la silueta en coordenadas de pantalla. y se mide en cm desde el suelo. */
function silhouette(f: Figure, sway: number) {
  const { cx, floor, k, m } = f;
  const X = (xcm: number, ycm: number) => cx + (xcm + sway * (ycm / m.heightCm)) * k;
  const Y = (ycm: number) => floor - ycm * k;
  const H = m.heightCm;
  const chestHalf = m.chestCm / 2 / Math.PI * 1.25;
  const waistHalf = m.waistCm / 2 / Math.PI * 1.25;
  const hipHalf = m.hipCm / 2 / Math.PI * 1.25;
  const sh = m.shoulderWidthCm / 2;
  return { X, Y, H, chestHalf, waistHalf, hipHalf, sh };
}

function drawFigure(ctx: CanvasRenderingContext2D, f: Figure, sway: number, items: readonly EquippedItem[], patterns: Map<string, CanvasPattern | null>): void {
  const { X, Y, H, chestHalf, waistHalf, hipHalf, sh } = silhouette(f, sway);
  const k = f.k;
  const torso: [number, number][] = [
    [X(-sh, 0.82 * H), Y(0.82 * H)],
    [X(sh, 0.82 * H), Y(0.82 * H)],
    [X(chestHalf, 0.72 * H), Y(0.72 * H)],
    [X(waistHalf, 0.62 * H), Y(0.62 * H)],
    [X(hipHalf, 0.5 * H), Y(0.5 * H)],
    [X(-hipHalf, 0.5 * H), Y(0.5 * H)],
    [X(-waistHalf, 0.62 * H), Y(0.62 * H)],
    [X(-chestHalf, 0.72 * H), Y(0.72 * H)],
  ];
  const legW = (f.m.thighCm / Math.PI) * 0.5;
  const skin = 'rgba(58,42,32,0.78)';
  ctx.fillStyle = skin;
  // piernas
  for (const side of [-1, 1]) {
    polygon(ctx, [
      [X(side * 1, 0.5 * H), Y(0.5 * H)],
      [X(side * (hipHalf * 0.95), 0.5 * H), Y(0.5 * H)],
      [X(side * (legW * 0.8 + 4), 0.04 * H), Y(0.04 * H)],
      [X(side * (4), 0.04 * H), Y(0.04 * H)],
    ]);
    ctx.fill();
  }
  // brazos
  for (const side of [-1, 1]) {
    polygon(ctx, [
      [X(side * sh, 0.82 * H), Y(0.82 * H)],
      [X(side * (sh + 4), 0.8 * H), Y(0.8 * H)],
      [X(side * (sh + 11), 0.46 * H), Y(0.46 * H)],
      [X(side * (sh + 6), 0.46 * H), Y(0.46 * H)],
    ]);
    ctx.fill();
  }
  polygon(ctx, torso);
  ctx.fill();
  // cuello y cabeza
  ctx.fillRect(X(-3.2, 0.9 * H), Y(0.9 * H), 6.4 * k, 0.07 * H * k);
  ctx.beginPath();
  ctx.ellipse(X(0, 0.935 * H), Y(0.935 * H), 0.052 * H * k, 0.066 * H * k, 0, 0, Math.PI * 2);
  ctx.fill();

  // prendas, de dentro hacia fuera
  const order = ['lower', 'upper', 'full', 'outer'] as const;
  for (const slot of order) {
    const item = items.find((i) => i.garment.slot === slot);
    if (!item) continue;
    const key = `${item.garment.id}:${item.variant.id}`;
    if (!patterns.has(key)) patterns.set(key, makePattern(ctx, item));
    ctx.fillStyle = patterns.get(key) ?? item.variant.color;
    const t = item.garment.template;
    const long = ['shirt', 'long_sleeve', 'sweater', 'hoodie', 'blazer', 'jacket', 'coat', 'dress'].includes(t);
    const bottom = t === 'coat' ? 0.27 : t === 'dress' ? 0.3 : t === 'blazer' || t === 'jacket' ? 0.47 : 0.54;
    if (slot === 'lower' && t !== 'skirt') {
      for (const side of [-1, 1]) {
        polygon(ctx, [
          [X(side * 0.5, 0.58 * H), Y(0.58 * H)],
          [X(side * (hipHalf + 1.5), 0.58 * H), Y(0.58 * H)],
          [X(side * (legW * 0.85 + 5), t === 'shorts' ? 0.32 * H : 0.04 * H), Y(t === 'shorts' ? 0.32 * H : 0.04 * H)],
          [X(side * 3, t === 'shorts' ? 0.32 * H : 0.04 * H), Y(t === 'shorts' ? 0.32 * H : 0.04 * H)],
        ]);
        ctx.fill();
      }
    } else if (t === 'skirt') {
      polygon(ctx, [
        [X(-waistHalf - 1, 0.62 * H), Y(0.62 * H)],
        [X(waistHalf + 1, 0.62 * H), Y(0.62 * H)],
        [X(hipHalf + 12, 0.3 * H), Y(0.3 * H)],
        [X(-hipHalf - 12, 0.3 * H), Y(0.3 * H)],
      ]);
      ctx.fill();
    } else {
      const flare = t === 'dress' || t === 'coat' ? 14 : 2;
      polygon(ctx, [
        [X(-sh - 1, 0.825 * H), Y(0.825 * H)],
        [X(sh + 1, 0.825 * H), Y(0.825 * H)],
        [X(chestHalf + 3, 0.72 * H), Y(0.72 * H)],
        [X(waistHalf + 3, 0.62 * H), Y(0.62 * H)],
        [X(hipHalf + flare, bottom * H), Y(bottom * H)],
        [X(-hipHalf - flare, bottom * H), Y(bottom * H)],
        [X(-waistHalf - 3, 0.62 * H), Y(0.62 * H)],
        [X(-chestHalf - 3, 0.72 * H), Y(0.72 * H)],
      ]);
      ctx.fill();
      const sleeveEnd = long ? 0.47 : 0.7;
      for (const side of [-1, 1]) {
        polygon(ctx, [
          [X(side * (sh - 1), 0.83 * H), Y(0.83 * H)],
          [X(side * (sh + 6.5), 0.8 * H), Y(0.8 * H)],
          [X(side * (sh + (long ? 13 : 8)), sleeveEnd * H), Y(sleeveEnd * H)],
          [X(side * (sh + (long ? 6.5 : 2.5)), sleeveEnd * H), Y(sleeveEnd * H)],
        ]);
        ctx.fill();
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = Math.max(1, k * 0.25);
    ctx.stroke();
  }
  void k;
}

/**
 * Espejo SIMULADO fiel al contrato `MirrorStage`: degradado cálido + silueta con las prendas puestas.
 * Sirve para desarrollar y probar el flujo sin cámara ni pose reales (`?mock=1`).
 */
export const MockMirrorStage = forwardRef<MirrorHandle, MirrorStageProps>(function MockMirrorStage(
  { width, height, measurements, equipped, camera, mirrored = true, onTrackingChange, onStats },
  ref,
) {
  const pxH = Math.round((PX_W * height) / width);
  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = PX_W;
    c.height = pxH;
    return c;
  }, [pxH]);
  const texture = useMemo(() => {
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.minFilter = LinearFilter;
    return t;
  }, [canvas]);
  useEffect(() => () => texture.dispose(), [texture]);

  const patterns = useRef(new Map<string, CanvasPattern | null>());
  const frames = useRef({ n: 0, last: performance.now() });
  const invalidate = useThree((s) => s.invalidate);

  const ready = camera.status === 'ready';
  useEffect(() => {
    const ids: number[] = [];
    const emit = (s: TrackingState) => onTrackingChange?.(s);
    emit('initializing');
    if (ready) {
      ids.push(window.setTimeout(() => emit('searching'), 500));
      ids.push(window.setTimeout(() => emit('tracking'), 1200));
    }
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [ready, onTrackingChange]);

  const draw = (time: number) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    // Habitación reflejada: pared cálida, suelo de roble, haz de luz.
    const wall = ctx.createLinearGradient(0, 0, 0, h);
    wall.addColorStop(0, '#4a3b2c');
    wall.addColorStop(0.7, '#8a6f52');
    wall.addColorStop(1, '#5a4430');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, w, h);
    const beam = ctx.createLinearGradient(w * 0.1, 0, w * 0.9, h * 0.6);
    beam.addColorStop(0, 'rgba(255,214,150,0.38)');
    beam.addColorStop(1, 'rgba(255,214,150,0)');
    ctx.fillStyle = beam;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(30,20,12,0.45)';
    ctx.fillRect(0, h * 0.9, w, h * 0.1);

    if (ready) {
      const k = (h * 0.8) / measurements.heightCm;
      const sway = Math.sin(time * 0.9) * 1.2;
      ctx.save();
      if (mirrored) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      drawFigure(ctx, { cx: w / 2, floor: h * 0.9, k, m: measurements }, sway, equipped, patterns.current);
      ctx.restore();
    }
    const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
    texture.needsUpdate = true;
  };

  useFrame((state) => {
    draw(state.clock.elapsedTime);
    frames.current.n += 1;
    const now = performance.now();
    if (now - frames.current.last >= 1000) {
      onStats?.({
        fps: (frames.current.n * 1000) / (now - frames.current.last),
        poseMs: 0,
        skinMs: 0,
        clothMs: 0,
        triangles: equipped.length * 2400,
      });
      frames.current = { n: 0, last: now };
    }
  });
  useEffect(() => invalidate(), [invalidate, equipped, ready, mirrored, measurements]);

  useImperativeHandle(
    ref,
    () => ({
      capture: () =>
        new Promise<Blob>((resolve, reject) => {
          draw(0);
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob devolvió null'))), 'image/png');
        }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvas, equipped, ready, mirrored, measurements],
  );

  return (
    <mesh>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
});
