import { buildBodyAsync, completeMeasurements } from '@fitroom/body';
import { generateFabricTexturesAsync, generateGarment } from '@fitroom/garments';
import { BodyStore, type TaskOutput, type TaskSpec, type TaskValue } from './tasks';

/** Un trabajo enviado a un ejecutor. `cancel()` sólo tiene efecto si aún no empezó (devuelve true entonces). */
export interface ExecJob {
  readonly spec: TaskSpec;
  readonly promise: Promise<TaskOutput>;
  cancel(): boolean;
}

export interface Executor {
  readonly name: string;
  submit(spec: TaskSpec): ExecJob;
  dispose(): void;
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

// ---------------------------------------------------------------- cola con cancelación

interface Pending {
  spec: TaskSpec;
  resolve: (o: TaskOutput) => void;
  reject: (e: unknown) => void;
  started: boolean;
  cancelled: boolean;
}

/** Cola FIFO de un solo hilo de ejecución. Base común del ejecutor inline y de cada carril de worker. */
abstract class LaneBase {
  protected queue: Pending[] = [];
  protected current: Pending | null = null;
  protected disposed = false;

  enqueue(spec: TaskSpec): ExecJob {
    let p!: Pending;
    const promise = new Promise<TaskOutput>((resolve, reject) => {
      p = { spec, resolve, reject, started: false, cancelled: false };
    });
    // evita "unhandled rejection" cuando se cancela un trabajo que nadie espera
    promise.catch(() => {});
    this.queue.push(p);
    queueMicrotask(() => this.pump());
    return {
      spec,
      promise,
      cancel: () => {
        if (p.started || p.cancelled) return false;
        p.cancelled = true;
        const i = this.queue.indexOf(p);
        if (i >= 0) this.queue.splice(i, 1);
        p.reject(new CancelledError());
        return true;
      },
    };
  }

  protected abstract pump(): void;

  dispose(): void {
    this.disposed = true;
    for (const p of this.queue) p.reject(new CancelledError());
    this.queue = [];
  }
}

// ---------------------------------------------------------------- ejecutor en el hilo principal

const yieldToMain = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Fallback sin worker: ejecuta en el hilo principal, de uno en uno, cediendo el control entre trabajos
 * (y por bandas dentro de las texturas) para que la interfaz no se congele.
 */
export class InlineExecutor extends LaneBase implements Executor {
  readonly name = 'inline';
  private readonly bodies = new BodyStore();

  submit(spec: TaskSpec): ExecJob {
    return this.enqueue(spec);
  }

  protected pump(): void {
    if (this.current || this.disposed) return;
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    next.started = true;
    void this.run(next).finally(() => {
      this.current = null;
      this.pump();
    });
  }

  private async run(p: Pending): Promise<void> {
    try {
      await yieldToMain();
      const t0 = performance.now();
      let value: TaskValue;
      const spec = p.spec;
      switch (spec.kind) {
        case 'body':
          value = await buildBodyAsync(completeMeasurements(spec.measurements));
          break;
        case 'garment': {
          const body = this.bodies.get(spec.measurements);
          value = generateGarment(spec.def, spec.sizeLabel, body);
          break;
        }
        case 'textures':
          value = await generateFabricTexturesAsync(spec.fabric, spec.variant, spec.size, spec.seed);
          break;
      }
      p.resolve({ value, ms: performance.now() - t0 });
    } catch (err) {
      p.reject(err);
    }
  }
}

// ---------------------------------------------------------------- pool de Web Workers

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: TaskValue;
  ms?: number;
  error?: { name: string; message: string };
}

class WorkerLane extends LaneBase {
  private nextId = 1;
  private inflight: { id: number; p: Pending } | null = null;
  broken = false;

  constructor(
    private readonly worker: WorkerLike,
    private readonly onBroken: (pending: Pending[]) => void,
  ) {
    super();
    worker.onmessage = (ev: MessageEvent) => this.onReply(ev.data as WorkerReply);
    worker.onerror = (ev: ErrorEvent) => this.fail(new Error(ev.message || 'worker error'));
    worker.onmessageerror = () => this.fail(new Error('worker messageerror'));
  }

  protected pump(): void {
    if (this.inflight || this.disposed || this.broken) return;
    const next = this.queue.shift();
    if (!next) return;
    next.started = true;
    const id = this.nextId++;
    this.inflight = { id, p: next };
    this.current = next;
    try {
      this.worker.postMessage({ id, spec: next.spec });
    } catch (err) {
      this.fail(err);
    }
  }

  private onReply(r: WorkerReply): void {
    const cur = this.inflight;
    if (!cur || cur.id !== r.id) return;
    this.inflight = null;
    this.current = null;
    if (r.ok && r.result !== undefined) cur.p.resolve({ value: r.result, ms: r.ms ?? 0 });
    else {
      const e = new Error(r.error?.message ?? 'error en el worker');
      e.name = r.error?.name ?? 'Error';
      cur.p.reject(e);
    }
    this.pump();
  }

  /** El worker murió o no cargó: lo que quedaba (en vuelo + cola) se reencola en el fallback. */
  private fail(_err: unknown): void {
    if (this.broken) return;
    this.broken = true;
    const orphans: Pending[] = [];
    if (this.inflight) orphans.push(this.inflight.p);
    orphans.push(...this.queue);
    this.inflight = null;
    this.queue = [];
    this.current = null;
    try {
      this.worker.terminate();
    } catch {
      /* ya terminado */
    }
    this.onBroken(orphans);
  }

  override dispose(): void {
    super.dispose();
    if (this.inflight) this.inflight.p.reject(new CancelledError());
    this.inflight = null;
    try {
      this.worker.terminate();
    } catch {
      /* ya terminado */
    }
  }
}

/**
 * Pool de dos carriles: uno para geometría (cuerpo + prendas) y otro para texturas, que pueden avanzar
 * en paralelo. Los resultados vuelven con buffers TRANSFERIDOS (sin copia). Si un worker falla o no
 * existe, sus trabajos se reejecutan en un ejecutor inline: la app sigue funcionando.
 */
export class WorkerExecutor implements Executor {
  readonly name = 'worker';
  private readonly lanes: WorkerLane[];
  private fallback: InlineExecutor | null = null;
  private disposed = false;

  constructor(factory: () => WorkerLike, laneCount = 2) {
    const n = Math.max(1, laneCount);
    this.lanes = Array.from({ length: n }, () => new WorkerLane(factory(), (o) => this.adopt(o)));
  }

  /** ¿Algún carril sigue vivo? */
  get alive(): boolean {
    return this.lanes.some((l) => !l.broken);
  }

  submit(spec: TaskSpec): ExecJob {
    const idx = spec.kind === 'textures' && this.lanes.length > 1 ? 1 : 0;
    const lane = this.lanes[idx]!;
    if (lane.broken) return this.getFallback().submit(spec);
    return lane.enqueue(spec);
  }

  private getFallback(): InlineExecutor {
    this.fallback ??= new InlineExecutor();
    return this.fallback;
  }

  private adopt(orphans: Pending[]): void {
    if (this.disposed) return;
    const fb = this.getFallback();
    for (const p of orphans) {
      if (p.cancelled) continue;
      const job = fb.submit(p.spec);
      job.promise.then(p.resolve, p.reject);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const l of this.lanes) l.dispose();
    this.fallback?.dispose();
  }
}

/**
 * Ejecutor por defecto: workers de módulo de Vite si el navegador los soporta; si no (jsdom, entornos
 * sin Worker, fallo al crear), ejecución inline.
 */
export function createDefaultExecutor(): Executor {
  if (typeof Worker === 'undefined') return new InlineExecutor();
  try {
    const make = (): WorkerLike =>
      new Worker(new URL('./fitting.worker.ts', import.meta.url), {
        type: 'module',
        name: 'fitting',
      }) as unknown as WorkerLike;
    return new WorkerExecutor(make, 2);
  } catch {
    return new InlineExecutor();
  }
}
