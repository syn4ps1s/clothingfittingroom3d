/** Búferes numéricos crecientes (evitan arrays JS de doubles al generar decenas de miles de vértices). */
export class F64Buf {
  data: Float64Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Float64Array(capacity);
  }
  private grow(min: number): void {
    let cap = this.data.length;
    while (cap < min) cap *= 2;
    const next = new Float64Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  push(v: number): number {
    if (this.length >= this.data.length) this.grow(this.length + 1);
    this.data[this.length] = v;
    return this.length++;
  }
  push3(x: number, y: number, z: number): void {
    if (this.length + 3 > this.data.length) this.grow(this.length + 3);
    const d = this.data;
    d[this.length] = x;
    d[this.length + 1] = y;
    d[this.length + 2] = z;
    this.length += 3;
  }
  toArray(): Float64Array {
    return this.data.slice(0, this.length);
  }
}

export class U32Buf {
  data: Uint32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Uint32Array(capacity);
  }
  private grow(min: number): void {
    let cap = this.data.length;
    while (cap < min) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  push(v: number): void {
    if (this.length >= this.data.length) this.grow(this.length + 1);
    this.data[this.length++] = v;
  }
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) this.grow(this.length + 3);
    const d = this.data;
    d[this.length] = a;
    d[this.length + 1] = b;
    d[this.length + 2] = c;
    this.length += 3;
  }
  toArray(): Uint32Array {
    return this.data.slice(0, this.length);
  }
}
