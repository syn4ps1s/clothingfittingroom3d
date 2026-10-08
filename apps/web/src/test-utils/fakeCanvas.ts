import { vi } from 'vitest';

/** Contexto 2D falso que registra las llamadas (jsdom no implementa canvas). */
export function makeFakeContext(): CanvasRenderingContext2D & { calls: string[] } {
  const calls: string[] = [];
  const gradient = { addColorStop: () => {} };
  const data = new Uint8ClampedArray(32 * 18 * 4).fill(128);
  const handler: ProxyHandler<object> = {
    get(target, prop: string) {
      if (prop === 'calls') return calls;
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
      if (prop === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(128), width: w, height: h });
      if (prop in target) return (target as Record<string, unknown>)[prop];
      return (...args: unknown[]) => {
        calls.push(`${prop}(${args.length})`);
      };
    },
    set(target, prop: string, value: unknown) {
      (target as Record<string, unknown>)[prop] = value;
      return true;
    },
  };
  void data;
  return new Proxy({}, handler) as unknown as CanvasRenderingContext2D & { calls: string[] };
}

/** Sustituye getContext('2d') por el contexto falso durante el test. */
export function installFakeCanvas(): { ctx: ReturnType<typeof makeFakeContext>; restore(): void } {
  const ctx = makeFakeContext();
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => ctx as unknown as RenderingContext);
  return { ctx, restore: () => spy.mockRestore() };
}
