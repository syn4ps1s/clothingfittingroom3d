import { BoxGeometry, ExtrudeGeometry, Shape, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface BoxSpec {
  readonly pos: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

/** Funde muchas cajas en una sola malla (un solo draw call): molduras, paneles, listones. */
export function mergeBoxes(boxes: readonly BoxSpec[]): BufferGeometry {
  const geos = boxes.map((b) => {
    const g = new BoxGeometry(b.size[0], b.size[1], b.size[2]);
    g.translate(b.pos[0], b.pos[1], b.pos[2]);
    return g;
  });
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (!merged) throw new Error('mergeBoxes: lista vacía');
  return merged;
}

/** Rectángulo con esquinas redondeadas como Shape (en el plano XY, centrado). */
export function roundedRect(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Marco: anillo (rectángulo exterior − hueco) extruido con bisel pulido. */
export function frameRing(
  outerW: number,
  outerH: number,
  innerW: number,
  innerH: number,
  depth: number,
  bevel: number,
): ExtrudeGeometry {
  const outer = roundedRect(outerW, outerH, 0.035);
  outer.holes.push(roundedRect(innerW, innerH, 0.008));
  return new ExtrudeGeometry(outer, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 8,
  });
}
