import {
  CancelledError,
  type ExecJob,
  type Executor,
} from '../../runtime/fitting/executors';
import type { TaskOutput, TaskSpec } from '../../runtime/fitting/tasks';
import { doubleBody, doubleTee, doubleTextures } from './doubles';

/** Ejecutor de DESARROLLO que fabrica cuerpo/prenda/texturas con los dobles (sin @fitroom/garments). */
export class DoublesExecutor implements Executor {
  readonly name = 'doubles';
  private readonly bodies = new Map<string, ReturnType<typeof doubleBody>>();
  private disposed = false;

  submit(spec: TaskSpec): ExecJob {
    let cancelled = false;
    let started = false;
    const promise = new Promise<TaskOutput>((resolve, reject) => {
      setTimeout(() => {
        if (cancelled || this.disposed) return reject(new CancelledError());
        started = true;
        const t0 = performance.now();
        try {
          switch (spec.kind) {
            case 'body': {
              const b = this.body(spec.measurements);
              resolve({ value: b, ms: performance.now() - t0 });
              break;
            }
            case 'garment': {
              const g = doubleTee(this.body(spec.measurements), spec.def.slot);
              resolve({ value: { ...g, sizeLabel: spec.sizeLabel }, ms: performance.now() - t0 });
              break;
            }
            case 'textures':
              resolve({ value: doubleTextures(spec.variant, 256), ms: performance.now() - t0 });
              break;
          }
        } catch (e) {
          reject(e);
        }
      }, 0);
    });
    promise.catch(() => {});
    return {
      spec,
      promise,
      cancel: () => {
        if (started || cancelled) return false;
        cancelled = true;
        return true;
      },
    };
  }

  private body(m: Parameters<typeof doubleBody>[0]): ReturnType<typeof doubleBody> {
    const key = JSON.stringify(m);
    let b = this.bodies.get(key);
    if (!b) {
      b = doubleBody(m);
      this.bodies.set(key, b);
    }
    return b;
  }

  dispose(): void {
    this.disposed = true;
  }
}
