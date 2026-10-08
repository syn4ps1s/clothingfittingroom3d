import type { MaterialSlot } from '@fitroom/shared';
import { F64Buf } from './buf.js';

/** Ranuras de material como enteros (índice en MATERIAL_SLOTS). */
export const SLOT = { main: 0, trim: 1, lining: 2, hardware: 3 } as const;
export const SLOT_NAMES: readonly MaterialSlot[] = ['main', 'trim', 'lining', 'hardware'];

/** Banderas por nodo. */
export const NF = {
  /** capa interior (vuelta de dobladillo/vista): su normal exterior apunta hacia el cuerpo */
  inner: 1,
  /** no se mueve en la relajación (p. ej. lazo de la sisa compartido) */
  pinned: 2,
  /** ancla de tela: maxDistance=0 */
  anchor: 4,
  /** herraje/botón: rígido respecto al soporte */
  rigid: 8,
} as const;

/**
 * Superficie estructurada (rejilla de filas × columnas). Es la unidad de construcción: las prendas son un
 * conjunto de superficies que COMPARTEN nodos (posiciones) en sus uniones. Un nodo puede tener varios vértices
 * (p. ej. costuras de UV): la posición vive en el nodo, los UV en el vértice.
 */
export interface Surface {
  readonly name: string;
  readonly rows: number;
  readonly cols: number;
  /** última columna = duplicado de la primera (tubo cerrado, costura de UV) */
  readonly wrap: boolean;
  /** nodo por celda de rejilla (rows*cols); -1 = ausente */
  readonly node: Int32Array;
  /** vértice por celda (se asigna al emitir) */
  vert: Int32Array;
  /** 1 si la quad (r,c) existe, ((rows-1)*(cols-1)) */
  readonly cellOn: Uint8Array;
  readonly cellSlot: Uint8Array;
  /** capa de tela interior: la orientación esperada es la contraria */
  inner: boolean;
  /** separación vertical de UV (se reasigna al empaquetar) */
  vOffset: number;
  uOffset: number;
  /** modo UV */
  uv: 'tube' | 'flat';
  /** triángulos invertidos respecto al orden de la rejilla (se decide al emitir) */
  flip: boolean;
}

export class GarmentMesh {
  readonly pos = new F64Buf(4096);
  /** holgura mínima exigida al cuerpo por nodo (m): d_min */
  readonly clear = new F64Buf(1024);
  readonly flags: number[] = [];
  readonly surfaces: Surface[] = [];
  get nodeCount(): number {
    return this.flags.length;
  }
  addNode(x: number, y: number, z: number, clearance: number, flags = 0): number {
    this.pos.push3(x, y, z);
    this.clear.push(clearance);
    this.flags.push(flags);
    return this.flags.length - 1;
  }
  px(n: number): number {
    return this.pos.data[n * 3]!;
  }
  py(n: number): number {
    return this.pos.data[n * 3 + 1]!;
  }
  pz(n: number): number {
    return this.pos.data[n * 3 + 2]!;
  }
  setPos(n: number, x: number, y: number, z: number): void {
    const d = this.pos.data;
    d[n * 3] = x;
    d[n * 3 + 1] = y;
    d[n * 3 + 2] = z;
  }
}

export function newSurface(
  name: string,
  rows: number,
  cols: number,
  opts: { wrap?: boolean; slot?: number; inner?: boolean } = {},
): Surface {
  const cells = Math.max(0, (rows - 1) * (cols - 1));
  return {
    name,
    rows,
    cols,
    wrap: opts.wrap ?? false,
    node: new Int32Array(rows * cols).fill(-1),
    vert: new Int32Array(rows * cols).fill(-1),
    cellOn: new Uint8Array(cells).fill(1),
    cellSlot: new Uint8Array(cells).fill(opts.slot ?? SLOT.main),
    inner: opts.inner ?? false,
    vOffset: 0,
    uOffset: 0,
    uv: 'tube',
    flip: false,
  };
}

/** Longitud de un camino de nodos. */
export function pathLength(m: GarmentMesh, nodes: ArrayLike<number>): number {
  let len = 0;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!,
      b = nodes[i]!;
    len += Math.hypot(m.px(a) - m.px(b), m.py(a) - m.py(b), m.pz(a) - m.pz(b));
  }
  return len;
}
