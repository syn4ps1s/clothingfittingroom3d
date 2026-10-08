/**
 * Worker de generación: cuerpo, geometría de prendas y texturas de tela. Los resultados grandes se
 * devuelven con buffers transferidos (sin copia). El cuerpo NO se transfiere (queda en la caché del
 * worker para generar prendas); se clona.
 */
import { BodyStore, collectTransferables, runTask, type TaskSpec } from './tasks';

interface Request {
  readonly id: number;
  readonly spec: TaskSpec;
}

// El proyecto compila con la librería DOM (no WebWorker): se tipa a mano lo mínimo del ámbito del worker.
interface WorkerScope {
  onmessage: ((ev: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const bodies = new BodyStore();
const scope = self as unknown as WorkerScope;

scope.onmessage = (ev: MessageEvent<Request>) => {
  const { id, spec } = ev.data;
  try {
    const out = runTask(spec, bodies);
    const transfer = spec.kind === 'body' ? [] : collectTransferables(out.value);
    scope.postMessage({ id, ok: true, result: out.value, ms: out.ms }, transfer);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    scope.postMessage({ id, ok: false, error: { name: e.name, message: e.message } });
  }
};
