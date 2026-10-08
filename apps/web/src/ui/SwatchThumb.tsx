import { useEffect, useRef } from 'react';
import type { FabricDef, SwatchVariant } from '@fitroom/shared';
import { getFabricTextures } from '../world/textures/fabricSets';

/** Miniatura de una muestra: el albedo PBR de la tela dibujado en un <canvas> (sin imágenes externas ni data: URI). */
export function SwatchThumb({
  fabric,
  variant,
  size = 56,
}: {
  fabric: FabricDef;
  variant: SwatchVariant;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const set = getFabricTextures(fabric, variant, 'medium');
    const img = ctx.createImageData(set.size, set.size);
    img.data.set(set.albedo);
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = set.size;
    tmp.getContext('2d')?.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  }, [fabric, variant]);
  return <canvas ref={ref} className="swatch-thumb" width={size * 2} height={size * 2} aria-hidden="true" />;
}
