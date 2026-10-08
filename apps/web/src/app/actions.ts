import type { GarmentDefinition, GarmentSlot } from '@fitroom/shared';
import type { CameraController, MirrorHandle } from '../contracts';
import { localized } from '../i18n/translate';
import {
  buildMeasurements,
  commitAll,
  refreshDerived,
  validateDraft,
  type BuildResult,
} from '../state/measurementDraft';
import { appStore } from '../state/store';
import { completeMeasurementsApi } from '../world/api/body';
import { getCatalog } from '../world/api/catalog';
import { appParams } from './params';

/** Acciones que combinan varios almacenes / efectos. Cada una es un gesto de la persona. */
const state = () => appStore().getState();

/** «Encender cámara»: gesto de usuario → pide permiso. Con `?synthetic=1` no hace falta cámara. */
export function beginCamera(camera: CameraController): void {
  state().send({ type: 'START_CAMERA' });
  if (appParams().synthetic) {
    state().send({ type: 'CAMERA_READY' });
    return;
  }
  void camera.start();
}

export function retryCamera(camera: CameraController): void {
  camera.stop();
  void camera.start();
}

/** Alternativa sin cámara: apaga lo que haya encendido y abre la entrada manual. */
export function goManual(camera: CameraController): void {
  camera.stop();
  state().send({ type: 'START_MANUAL' });
}

export function goBack(camera: CameraController): void {
  const stage = state().flow.stage;
  if (stage === 'camera' || stage === 'height') camera.stop();
  state().send({ type: 'BACK' });
}

/** Estatura declarada → empieza el escaneo. Devuelve false si la estatura no es válida. */
export function submitHeight(): boolean {
  const { draft, settings } = state();
  const committed = commitAll(draft, settings.units);
  state().setDraft(committed);
  const { errors } = validateDraft(committed, settings.units);
  if (errors.heightCm) return false;
  state().send({ type: 'SUBMIT_HEIGHT' });
  return true;
}

/** Entrada manual → libro. Valida, rellena lo no dado con la regresión y avanza. */
export function submitManual(): boolean {
  const { draft, settings } = state();
  const committed = commitAll(draft, settings.units);
  const { ok } = validateDraft(committed, settings.units);
  state().setDraft(committed);
  if (!ok) return false;
  state().setDraft(refreshDerived(committed, completeMeasurementsApi));
  state().send({ type: 'SUBMIT_MANUAL' });
  return true;
}

export function finishScan(): void {
  state().setDraft(refreshDerived(state().draft, completeMeasurementsApi));
  state().send({ type: 'SCAN_COMPLETE' });
}

export function confirmBook(): BuildResult {
  const { draft, settings } = state();
  const result = buildMeasurements(draft, settings.units, completeMeasurementsApi);
  if (result.ok) state().confirmMeasurements(result.measurements);
  return result;
}

/** Elige una prenda: la viste con la talla sugerida y su primera muestra, y abre el probador. */
export function tryGarment(garment: GarmentDefinition, camera: CameraController): void {
  const { measurements, sigma, worn, settings } = state();
  if (!measurements) return;
  const catalog = getCatalog();
  const rec = catalog.recommend(garment, measurements, sigma);
  const displaced = state().wear(garment.slot, {
    garmentId: garment.id,
    size: rec.size,
    variantId: garment.variants[0]!.id,
  });
  for (const slot of displaced) notifyDisplaced(worn[slot]?.garmentId, settings.lang);
  state().send({ type: 'SELECT_GARMENT' });
  if (camera.status === 'idle' && !appParams().synthetic) void camera.start();
}

function notifyDisplaced(garmentId: string | undefined, lang: 'es' | 'en'): void {
  const g = garmentId ? getCatalog().garment(garmentId) : undefined;
  if (g) state().toast('fitting.displaced', { name: localized(g.name, lang) });
}

export function takeOff(slot: GarmentSlot): void {
  const { worn, settings } = state();
  const g = worn[slot] ? getCatalog().garment(worn[slot]!.garmentId) : undefined;
  state().takeOff(slot);
  if (g) state().toast('fitting.removed', { name: localized(g.name, settings.lang) });
}

export function wipeEverything(camera: CameraController): void {
  camera.stop();
  state().wipeData();
  state().toast('settings.wipeDone');
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Foto del espejo: se descarga LOCALMENTE (blob + enlace), jamás se sube a ningún sitio. */
export async function takePhoto(handle: MirrorHandle | null): Promise<boolean> {
  if (!handle) {
    state().toast('fitting.photoFailed', undefined, 'error');
    return false;
  }
  try {
    const blob = await handle.capture();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `probador-3d-${timestamp()}.png`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    state().toast('fitting.photoSaved');
    return true;
  } catch (err) {
    console.error('capture() falló', err);
    state().toast('fitting.photoFailed', undefined, 'error');
    return false;
  }
}
