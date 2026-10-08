import { useEffect, useMemo, useRef, useState } from 'react';
import type { Measurements } from '@fitroom/shared';
import type { EquippedItem } from '../contracts';
import { FittingEngine, IDLE_SNAPSHOT, type FittingSnapshot, type TextureSize } from './fitting/engine';
import { createDefaultExecutor } from './fitting/executors';
import { bodyKeyOf } from './fitting/tasks';

let shared: FittingEngine | null = null;

/** Motor compartido por toda la aplicación (caché común entre el espejo, el perchero y las vitrinas). */
export function getSharedFittingEngine(): FittingEngine {
  shared ??= new FittingEngine(createDefaultExecutor());
  return shared;
}

/** Sólo para tests/arnés: sustituye (o limpia) el motor compartido. */
export function setSharedFittingEngine(engine: FittingEngine | null): void {
  if (shared && shared !== engine) shared.dispose();
  shared = engine;
}

export interface UseFittingModelsOptions {
  /** Resolución objetivo de las texturas (por calidad). Por defecto 1024. */
  readonly textureSize?: TextureSize;
  /** Motor alternativo (tests). */
  readonly engine?: FittingEngine;
}

/** Clave de contenido de una petición: new arrays con el mismo contenido NO relanzan la generación. */
export function requestKeyOf(
  measurements: Measurements | null,
  equipped: readonly EquippedItem[],
  size: number,
): string {
  const m = measurements ? bodyKeyOf(measurements) : 'none';
  const items = equipped
    .map(
      (e) =>
        `${e.garment.id}:${e.sizeLabel}:${e.fabric.id}:${e.trimFabric?.id ?? ''}:${e.variant.id}`,
    )
    .join(',');
  return `${m}#${items}#${size}`;
}

/**
 * Cuerpo + prendas listos para pintar (medidas → cuerpo → geometría por prenda → texturas), con caché,
 * cancelación de trabajos obsoletos y Web Worker. Mientras carga conserva el último resultado coherente
 * (sin parpadeos) y marca `status: 'loading'`. Cambiar sólo la muestra de color no regenera geometría.
 *
 * Además del contrato, devuelve `timings` (ms medidos de la última generación).
 */
export function useFittingModels(
  measurements: Measurements | null,
  equipped: readonly EquippedItem[],
  options: UseFittingModelsOptions = {},
): FittingSnapshot {
  const engine = options.engine ?? getSharedFittingEngine();
  const textureSize = options.textureSize ?? 1024;
  const [snapshot, setSnapshot] = useState<FittingSnapshot>(IDLE_SNAPSHOT);
  const watcherRef = useRef<ReturnType<FittingEngine['watch']> | null>(null);

  useEffect(() => {
    const w = engine.watch(setSnapshot);
    watcherRef.current = w;
    return () => {
      w.dispose();
      if (watcherRef.current === w) watcherRef.current = null;
    };
  }, [engine]);

  const key = useMemo(
    () => requestKeyOf(measurements, equipped, textureSize),
    [measurements, equipped, textureSize],
  );
  const latest = useRef({ measurements, equipped, textureSize });
  latest.current = { measurements, equipped, textureSize };

  useEffect(() => {
    watcherRef.current?.update(latest.current);
    // `key` representa el contenido de la petición; las referencias van por `latest`.
  }, [engine, key]);

  return snapshot;
}
