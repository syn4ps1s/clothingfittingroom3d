import {
  MeasurementsSchema,
  type BodyModel,
  type FabricTextureSet,
  type GarmentGeometry,
  type Measurements,
} from '@fitroom/shared';
import type { EquippedItem, FittingModels, LoadedGarment } from '../../contracts';
import { CancelledError, type ExecJob, type Executor } from './executors';
import {
  approxBytes,
  bodyKeyOf,
  garmentGeometryKey,
  hashString,
  textureKey,
  textureSeed,
  type TaskOutput,
  type TaskSpec,
  type TaskValue,
} from './tasks';

export type TextureSize = 512 | 1024 | 2048;

export interface FittingRequest {
  readonly measurements: Measurements | null;
  readonly equipped: readonly EquippedItem[];
  /** Tamaño objetivo de las texturas (según la calidad). Se sirve primero 512 y luego se mejora. */
  readonly textureSize: TextureSize;
}

/** Tiempos medidos (ms) del último ciclo de generación. */
export interface FittingTimings {
  /** Cuerpo: 0 si vino de caché. */
  readonly bodyMs: number;
  /** Geometría por prenda (0 si de caché), en el orden de `equipped`. */
  readonly garmentMs: readonly number[];
  /** Texturas por prenda y capa (0 si de caché). */
  readonly textureMs: readonly number[];
  /** Petición → «listo» (primera versión completa, texturas en resolución rápida). */
  readonly readyMs: number;
  /** Petición → texturas a resolución final. */
  readonly finalMs: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

export type FittingSnapshot = FittingModels & { readonly timings: FittingTimings };

const EMPTY_TIMINGS: FittingTimings = {
  bodyMs: 0,
  garmentMs: [],
  textureMs: [],
  readyMs: 0,
  finalMs: 0,
  cacheHits: 0,
  cacheMisses: 0,
};

export const IDLE_SNAPSHOT: FittingSnapshot = {
  status: 'idle',
  body: null,
  garments: [],
  timings: EMPTY_TIMINGS,
};

type Status = 'queued' | 'done' | 'failed' | 'cancelled';

interface Entry {
  readonly key: string;
  readonly job: ExecJob;
  status: Status;
  interest: number;
  bytes: number;
  ms: number;
  value: TaskValue | undefined;
  readonly promise: Promise<TaskOutput>;
  lastUsed: number;
}

export interface EngineOptions {
  /** Tope de memoria de resultados en caché (bytes aprox.). */
  readonly maxBytes?: number;
  readonly now?: () => number;
}

const nowDefault = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Orquestación de generación con caché, deduplicación y cancelación:
 *   medidas → cuerpo → (por prenda) geometría + texturas principal/ribete.
 *
 *  - Cada trabajo se identifica por una clave de CONTENIDO: cambiar sólo la muestra de color regenera
 *    texturas pero no geometría; cambiar de talla regenera la prenda pero no el cuerpo.
 *  - Los trabajos se comparten entre observadores (`watch`) por conteo de interés: un trabajo en cola
 *    que ya nadie necesita se cancela; uno en curso termina y su resultado queda en caché (útil si el
 *    usuario vuelve a la talla anterior).
 *  - Cada observador sólo publica el resultado de su ÚLTIMA petición (época): nunca una talla vieja.
 */
export class FittingEngine {
  private readonly cache = new Map<string, Entry>();
  private totalBytes = 0;
  private readonly loaded = new Map<string, { garment: LoadedGarment; size: number }>();
  private readonly loadedKeyOf = new WeakMap<LoadedGarment, string>();
  readonly now: () => number;
  private readonly maxBytes: number;
  private disposed = false;
  /** Contadores de diagnóstico. */
  readonly counters = { submitted: 0, cancelled: 0, hits: 0, evicted: 0 };

  constructor(
    private readonly exec: Executor,
    opts: EngineOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 450_000_000;
    this.now = opts.now ?? nowDefault;
  }

  get cacheSize(): number {
    return this.cache.size;
  }
  get cacheBytes(): number {
    return this.totalBytes;
  }
  get executorName(): string {
    return this.exec.name;
  }

  watch(onUpdate: (s: FittingSnapshot) => void): FittingWatcher {
    return new FittingWatcher(this, onUpdate);
  }

  dispose(): void {
    this.disposed = true;
    this.exec.dispose();
    this.cache.clear();
    this.loaded.clear();
    this.totalBytes = 0;
  }

  // ---------------------------------------------------------------- caché de trabajos

  /** Devuelve la entrada existente (suma interés) o encola el trabajo. */
  acquire(key: string, spec: TaskSpec, held: Set<Entry>): { entry: Entry; hit: boolean } {
    let entry = this.cache.get(key);
    const hit = entry !== undefined && entry.status !== 'failed';
    if (!entry || entry.status === 'failed') {
      entry = this.createEntry(key, spec);
    } else {
      this.counters.hits++;
    }
    entry.lastUsed = this.now();
    if (!held.has(entry)) {
      entry.interest++;
      held.add(entry);
    }
    return { entry, hit };
  }

  private createEntry(key: string, spec: TaskSpec): Entry {
    this.counters.submitted++;
    const job = this.exec.submit(spec);
    const entry: Entry = {
      key,
      job,
      status: 'queued',
      interest: 0,
      bytes: 0,
      ms: 0,
      value: undefined,
      lastUsed: this.now(),
      promise: job.promise,
    };
    this.cache.set(key, entry);
    job.promise.then(
      (out) => {
        if (entry.status === 'cancelled') return;
        entry.status = 'done';
        entry.value = out.value;
        entry.ms = out.ms;
        entry.bytes = approxBytes(out.value);
        this.totalBytes += entry.bytes;
        this.evictIfNeeded();
      },
      (err) => {
        if (entry.status === 'cancelled') return;
        entry.status = err instanceof CancelledError ? 'cancelled' : 'failed';
        if (this.cache.get(key) === entry) this.cache.delete(key);
      },
    );
    return entry;
  }

  /** Resta interés; un trabajo en cola que nadie necesita se cancela y se retira de la caché. */
  release(entry: Entry): void {
    entry.interest = Math.max(0, entry.interest - 1);
    if (entry.interest > 0 || entry.status !== 'queued') return;
    if (entry.job.cancel()) {
      entry.status = 'cancelled';
      this.counters.cancelled++;
      if (this.cache.get(entry.key) === entry) this.cache.delete(entry.key);
    }
  }

  private evictIfNeeded(): void {
    if (this.totalBytes <= this.maxBytes) return;
    const candidates = [...this.cache.values()]
      .filter((e) => e.status === 'done' && e.interest === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of candidates) {
      if (this.totalBytes <= this.maxBytes) break;
      this.cache.delete(e.key);
      this.totalBytes -= e.bytes;
      this.counters.evicted++;
    }
  }

  // ---------------------------------------------------------------- prendas cargadas (identidad estable)

  bestLoaded(baseKey: string): { garment: LoadedGarment; size: number } | undefined {
    return this.loaded.get(baseKey);
  }

  makeLoaded(
    baseKey: string,
    size: number,
    item: EquippedItem,
    geometry: GarmentGeometry,
    main: FabricTextureSet,
    trim: FabricTextureSet | undefined,
  ): LoadedGarment {
    const prev = this.loaded.get(baseKey);
    if (prev && prev.size === size && prev.garment.geometry === geometry && prev.garment.textures.main === main) {
      return prev.garment;
    }
    const garment: LoadedGarment = {
      item,
      geometry,
      textures: trim ? { main, trim } : { main },
    };
    this.loaded.set(baseKey, { garment, size });
    this.loadedKeyOf.set(garment, baseKey);
    while (this.loaded.size > 64) {
      const first = this.loaded.keys().next().value;
      if (first === undefined) break;
      this.loaded.delete(first);
    }
    return garment;
  }

  loadedKey(g: LoadedGarment): string | undefined {
    return this.loadedKeyOf.get(g);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

interface ItemPlan {
  readonly item: EquippedItem;
  readonly baseKey: string;
  readonly geo: Entry;
  /** Entradas de textura por fase [principal, ribete?] */
  readonly fast: readonly Entry[] | null;
  readonly final: readonly Entry[] | null;
  readonly fastSize: number;
  readonly finalSize: number;
}

/** Observador de una petición viva (p. ej. un componente). Sólo publica la última petición. */
export class FittingWatcher {
  private epoch = 0;
  private held = new Set<Entry>();
  private snapshot: FittingSnapshot = IDLE_SNAPSHOT;
  private publishedBodyKey: string | null = null;
  private disposed = false;

  constructor(
    private readonly engine: FittingEngine,
    private readonly onUpdate: (s: FittingSnapshot) => void,
  ) {}

  get current(): FittingSnapshot {
    return this.snapshot;
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    for (const e of this.held) this.engine.release(e);
    this.held = new Set();
  }

  /** Nueva petición: cancela lo obsoleto y publica `loading` → `ready`. */
  update(req: FittingRequest): void {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    void this.run(req, epoch).catch((err) => {
      if (err instanceof CancelledError || epoch !== this.epoch || this.disposed) return;
      this.publish({
        ...this.snapshot,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private current_(epoch: number): boolean {
    return epoch === this.epoch && !this.disposed;
  }

  private publish(s: FittingSnapshot): void {
    this.snapshot = s;
    this.onUpdate(s);
  }

  private async run(req: FittingRequest, epoch: number): Promise<void> {
    const engine = this.engine;
    const t0 = engine.now();
    const m = req.measurements;
    if (!m) {
      this.swapHeld(new Set());
      this.publishedBodyKey = null;
      this.publish(IDLE_SNAPSHOT);
      return;
    }
    const parsed = MeasurementsSchema.safeParse(m);
    if (!parsed.success) {
      this.swapHeld(new Set());
      this.publish({
        status: 'error',
        body: null,
        garments: [],
        errorMessage: `Medidas no válidas: ${parsed.error.issues[0]?.message ?? 'desconocido'}`,
        timings: EMPTY_TIMINGS,
      });
      return;
    }

    const bodyKey = bodyKeyOf(m);
    const newHeld = new Set<Entry>();
    let hits = 0;
    let misses = 0;
    const take = (key: string, spec: TaskSpec): Entry => {
      const { entry, hit } = engine.acquire(key, spec, newHeld);
      if (hit) hits++;
      else misses++;
      return entry;
    };

    const bodyEntry = take(`body|${bodyKey}`, { kind: 'body', measurements: m });
    const plans: ItemPlan[] = req.equipped.map((item) => {
      const seedMain = textureSeed(item.fabric, item.variant);
      const geoKey = garmentGeometryKey(item.garment, item.sizeLabel, bodyKey);
      const trimFabric = item.trimFabric;
      const baseKey = `${geoKey}|${hashString(JSON.stringify([item.fabric, item.variant, trimFabric ?? null]))}`;
      const fastSize = req.textureSize > 512 ? 512 : req.textureSize;
      const have = engine.bestLoaded(baseKey);
      const needFast = !(have && have.size >= fastSize);
      const needFinal = req.textureSize > fastSize && !(have && have.size >= req.textureSize);
      const texEntries = (size: TextureSize): Entry[] => {
        const list = [
          take(textureKey(item.fabric, item.variant, size, seedMain), {
            kind: 'textures',
            fabric: item.fabric,
            variant: item.variant,
            size,
            seed: seedMain,
          }),
        ];
        if (trimFabric) {
          list.push(
            take(textureKey(trimFabric, item.variant, size, textureSeed(trimFabric, item.variant)), {
              kind: 'textures',
              fabric: trimFabric,
              variant: item.variant,
              size,
              seed: textureSeed(trimFabric, item.variant),
            }),
          );
        }
        return list;
      };
      const geo = take(geoKey, {
        kind: 'garment',
        def: item.garment,
        sizeLabel: item.sizeLabel,
        measurements: m,
      });
      return {
        item,
        baseKey,
        geo,
        fast: needFast ? texEntries(fastSize as TextureSize) : null,
        final: needFinal ? texEntries(req.textureSize) : null,
        fastSize,
        finalSize: req.textureSize,
      };
    });
    // IMPORTANTE: primero se adquiere lo nuevo, luego se libera lo viejo (no se cancela lo que se reutiliza)
    this.swapHeld(newHeld);

    const sameBody = this.publishedBodyKey === bodyKey;
    // publicación inmediata: mismo cuerpo ⇒ las prendas ya cargadas que siguen vigentes se mantienen
    const keepNow = (): LoadedGarment[] => {
      const out: LoadedGarment[] = [];
      for (const p of plans) {
        const have = engine.bestLoaded(p.baseKey);
        if (have) out.push(have.garment);
      }
      return sameBody ? out : [...this.snapshot.garments];
    };
    this.publish({
      status: 'loading',
      body: this.snapshot.body,
      garments: keepNow(),
      timings: this.snapshot.timings,
    });

    const body = (await bodyEntry.promise).value as BodyModel;
    if (!this.current_(epoch)) return;
    if (!sameBody && this.snapshot.garments.length === 0) {
      // primera carga: el cuerpo ya puede dibujarse (maniquí/oclusor) mientras llegan las prendas
      this.publish({ ...this.snapshot, status: 'loading', body, garments: [] });
    }

    // ---- fase 1: geometría + texturas rápidas
    const ready: (LoadedGarment | null)[] = plans.map(() => null);
    let failure: string | undefined;
    const assemble = (): LoadedGarment[] => ready.filter((g): g is LoadedGarment => g !== null);
    const timingsBase = () => ({
      bodyMs: bodyEntry.ms,
      garmentMs: plans.map((p) => p.geo.ms),
      textureMs: plans.flatMap((p) => [...(p.fast ?? []), ...(p.final ?? [])].map((e) => e.ms)),
    });

    await Promise.all(
      plans.map(async (p, i) => {
        try {
          const have = engine.bestLoaded(p.baseKey);
          const geoOut = (await p.geo.promise).value as GarmentGeometry;
          let main: FabricTextureSet;
          let trim: FabricTextureSet | undefined;
          let size: number;
          if (p.fast) {
            const outs = await Promise.all(p.fast.map((e) => e.promise));
            main = outs[0]!.value as FabricTextureSet;
            trim = outs[1]?.value as FabricTextureSet | undefined;
            size = p.fastSize;
          } else if (have) {
            main = have.garment.textures.main;
            trim = have.garment.textures.trim;
            size = have.size;
          } else {
            return;
          }
          if (!this.current_(epoch)) return;
          ready[i] = engine.makeLoaded(p.baseKey, size, p.item, geoOut, main, trim);
          if (sameBody) {
            this.publish({
              status: 'loading',
              body,
              garments: assemble(),
              timings: this.snapshot.timings,
            });
          }
        } catch (err) {
          if (err instanceof CancelledError) return;
          failure ??= err instanceof Error ? err.message : String(err);
        }
      }),
    );
    if (!this.current_(epoch)) return;

    this.publishedBodyKey = bodyKey;
    const readyMs = engine.now() - t0;
    this.publish({
      status: failure ? 'error' : 'ready',
      body,
      garments: assemble(),
      ...(failure ? { errorMessage: failure } : {}),
      timings: {
        ...timingsBase(),
        readyMs,
        finalMs: readyMs,
        cacheHits: hits,
        cacheMisses: misses,
      },
    });

    // ---- fase 2: texturas a resolución final (la geometría no cambia: la identidad se conserva)
    if (failure) return;
    const upgrades = plans.map(async (p, i) => {
      if (!p.final) return;
      try {
        const outs = await Promise.all(p.final.map((e) => e.promise));
        if (!this.current_(epoch)) return;
        const geo = (await p.geo.promise).value as GarmentGeometry;
        ready[i] = engine.makeLoaded(
          p.baseKey,
          p.finalSize,
          p.item,
          geo,
          outs[0]!.value as FabricTextureSet,
          outs[1]?.value as FabricTextureSet | undefined,
        );
        this.publish({ ...this.snapshot, garments: assemble() });
      } catch (err) {
        if (!(err instanceof CancelledError)) {
          // la mejora de resolución es opcional: se queda la rápida
          console.warn('[mirror] texturas finales no disponibles', err);
        }
      }
    });
    await Promise.all(upgrades);
    if (!this.current_(epoch)) return;
    this.publish({
      ...this.snapshot,
      timings: { ...this.snapshot.timings, ...timingsBase(), finalMs: engine.now() - t0 },
    });
  }

  private swapHeld(next: Set<Entry>): void {
    const prev = this.held;
    this.held = next;
    for (const e of prev) if (!next.has(e)) this.engine.release(e);
  }
}
