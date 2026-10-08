import {
  BODY_BASES,
  MEASUREMENT_KEYS,
  MEASUREMENT_LIMITS,
  MeasurementsSchema,
  type BodyBase,
  type EstimatedValue,
  type MeasurementEstimate,
  type MeasurementKey,
  type MeasurementSource,
  type Measurements,
  type PartialMeasurements,
} from '@fitroom/shared';
import {
  displayLimits,
  formatNumber,
  fromDisplay,
  parseDecimalInput,
  roundForDisplay,
  toDisplay,
  unitFor,
  type DisplayLimits,
  type UnitSystem,
} from './units';

/**
 * Borrador de medidas del formulario (libro del sastre / entrada manual).
 *
 * Reglas:
 * - El valor canónico SIEMPRE está en cm/kg. Cambiar de unidades jamás reescribe el canónico
 *   (así cm → in → cm no pierde precisión; sólo se reformatea el texto).
 * - `text` es lo que la persona está escribiendo (en la unidad mostrada). Sólo pasa a canónico al confirmar el campo
 *   y si es válido; mientras tanto el error se calcula sobre el texto.
 * - Una entrada inválida NUNCA se «corrige» en silencio.
 */
export interface DraftField {
  readonly value: number | null;
  readonly text: string | null;
  readonly sigma: number | null;
  readonly source: MeasurementSource | null;
}

export interface Draft {
  readonly fields: Readonly<Record<MeasurementKey, DraftField>>;
  readonly bodyBase: BodyBase;
}

export type FieldErrorCode = 'required' | 'invalid' | 'out-of-range';

export interface FieldError {
  readonly code: FieldErrorCode;
  /** Límites en la unidad mostrada, para el mensaje. */
  readonly limits: DisplayLimits;
}

const EMPTY_FIELD: DraftField = { value: null, text: null, sigma: null, source: null };

export function emptyDraft(bodyBase: BodyBase = 'neutral'): Draft {
  const fields = Object.fromEntries(MEASUREMENT_KEYS.map((k) => [k, EMPTY_FIELD])) as Record<
    MeasurementKey,
    DraftField
  >;
  return { fields, bodyBase };
}

export function draftFromMeasurements(m: Measurements, source: MeasurementSource = 'user'): Draft {
  const draft = emptyDraft(m.bodyBase);
  const fields = { ...draft.fields };
  for (const k of MEASUREMENT_KEYS) fields[k] = { value: m[k], text: null, sigma: 0, source };
  return { fields, bodyBase: m.bodyBase };
}

export function draftFromEstimate(
  estimate: MeasurementEstimate,
  bodyBase: BodyBase = 'neutral',
): Draft {
  const draft = emptyDraft(bodyBase);
  const fields = { ...draft.fields };
  for (const k of MEASUREMENT_KEYS) {
    const e: EstimatedValue | undefined = estimate[k];
    if (e && Number.isFinite(e.value)) {
      fields[k] = {
        value: e.value,
        text: null,
        sigma: Number.isFinite(e.sigma) ? Math.max(0, e.sigma) : null,
        source: e.source,
      };
    }
  }
  return { fields, bodyBase };
}

export function draftFromPartial(partial: PartialMeasurements): Draft {
  const draft = emptyDraft(partial.bodyBase ?? 'neutral');
  const fields = { ...draft.fields };
  for (const k of MEASUREMENT_KEYS) {
    const v = partial[k];
    if (v !== undefined) fields[k] = { value: v, text: null, sigma: 0, source: 'user' };
  }
  return { ...draft, fields };
}

export function setBodyBase(draft: Draft, bodyBase: BodyBase): Draft {
  return BODY_BASES.includes(bodyBase) ? { ...draft, bodyBase } : draft;
}

/** La persona escribe: guardamos el texto tal cual (sin tocar el canónico). */
export function editField(draft: Draft, key: MeasurementKey, text: string): Draft {
  const prev = draft.fields[key];
  return { ...draft, fields: { ...draft.fields, [key]: { ...prev, text } } };
}

/**
 * Confirma el texto en edición (al salir del campo / pulsar Intro).
 * - Texto válido y en rango → canónico, fuente «user», incertidumbre 0.
 * - Vacío en campo opcional → se borra el valor (se derivará de la estatura).
 * - Cualquier otro caso → el texto se conserva y el error sigue visible.
 */
export function commitField(draft: Draft, key: MeasurementKey, system: UnitSystem): Draft {
  const prev = draft.fields[key];
  if (prev.text === null) return draft;
  const parsed = parseDecimalInput(prev.text, unitFor(key, system));
  if (parsed.kind === 'empty') {
    if (MEASUREMENT_LIMITS[key].required) return draft;
    return { ...draft, fields: { ...draft.fields, [key]: EMPTY_FIELD } };
  }
  if (parsed.kind === 'invalid') return draft;
  const canonical = fromDisplay(key, parsed.value, system);
  const { min, max } = MEASUREMENT_LIMITS[key];
  if (canonical < min || canonical > max) return draft;
  // Si el texto no cambia el valor mostrado, conservamos el canónico (y su incertidumbre) intactos.
  if (
    prev.value !== null &&
    roundForDisplay(toDisplay(key, prev.value, system)) === roundForDisplay(parsed.value)
  ) {
    return { ...draft, fields: { ...draft.fields, [key]: { ...prev, text: null } } };
  }
  return {
    ...draft,
    fields: {
      ...draft.fields,
      [key]: { value: canonical, text: null, sigma: 0, source: 'user' },
    },
  };
}

/** Confirma todos los textos pendientes (p. ej. antes de cambiar de unidades o de enviar). */
export function commitAll(draft: Draft, system: UnitSystem): Draft {
  return MEASUREMENT_KEYS.reduce((d, k) => commitField(d, k, system), draft);
}

export function fieldError(
  draft: Draft,
  key: MeasurementKey,
  system: UnitSystem,
): FieldError | null {
  const field = draft.fields[key];
  const limits = displayLimits(key, system);
  const lim = MEASUREMENT_LIMITS[key];
  let canonical: number | null;
  if (field.text !== null) {
    const parsed = parseDecimalInput(field.text, unitFor(key, system));
    if (parsed.kind === 'empty') canonical = null;
    else if (parsed.kind === 'invalid') return { code: 'invalid', limits };
    else canonical = fromDisplay(key, parsed.value, system);
  } else {
    canonical = field.value;
  }
  if (canonical === null) return lim.required ? { code: 'required', limits } : null;
  if (!Number.isFinite(canonical)) return { code: 'invalid', limits };
  if (canonical < lim.min || canonical > lim.max) return { code: 'out-of-range', limits };
  return null;
}

export interface DraftValidation {
  readonly errors: Readonly<Partial<Record<MeasurementKey, FieldError>>>;
  readonly ok: boolean;
}

export function validateDraft(draft: Draft, system: UnitSystem): DraftValidation {
  const errors: Partial<Record<MeasurementKey, FieldError>> = {};
  for (const k of MEASUREMENT_KEYS) {
    const e = fieldError(draft, k, system);
    if (e) errors[k] = e;
  }
  return { errors, ok: Object.keys(errors).length === 0 };
}

/** Texto a mostrar en el campo, en la unidad elegida (coma decimal en español). */
export function displayText(
  draft: Draft,
  key: MeasurementKey,
  system: UnitSystem,
  lang: string,
): string {
  const f = draft.fields[key];
  if (f.text !== null) return f.text;
  if (f.value === null) return '';
  return formatNumber(roundForDisplay(toDisplay(key, f.value, system)), lang);
}

/**
 * Medidas parciales listas para `completeMeasurements`. Sólo incluye valores canónicos válidos
 * (los textos sin confirmar se ignoran: `validateDraft` ya los habría marcado).
 */
export function toPartial(draft: Draft): PartialMeasurements | null {
  const height = draft.fields.heightCm.value;
  if (height === null) return null;
  const out: Record<string, number | string> = { heightCm: height, bodyBase: draft.bodyBase };
  for (const k of MEASUREMENT_KEYS) {
    const v = draft.fields[k].value;
    if (k !== 'heightCm' && v !== null) out[k] = v;
  }
  return out as unknown as PartialMeasurements;
}

export type BuildResult =
  | { readonly ok: true; readonly measurements: Measurements }
  | { readonly ok: false; readonly reason: 'invalid-input' | 'incomplete' | 'completion-failed' };

/**
 * Valida el borrador, completa lo que falte (regresión antropométrica) y vuelve a validar el resultado
 * con el esquema compartido: nada llega al cuerpo 3D sin pasar por zod.
 */
export function buildMeasurements(
  draft: Draft,
  system: UnitSystem,
  complete: (partial: PartialMeasurements) => Measurements,
): BuildResult {
  const committed = commitAll(draft, system);
  if (!validateDraft(committed, system).ok) return { ok: false, reason: 'invalid-input' };
  const partial = toPartial(committed);
  if (!partial) return { ok: false, reason: 'incomplete' };
  try {
    const full = complete(partial);
    const parsed = MeasurementsSchema.safeParse(full);
    return parsed.success
      ? { ok: true, measurements: parsed.data }
      : { ok: false, reason: 'completion-failed' };
  } catch {
    return { ok: false, reason: 'completion-failed' };
  }
}

/** Sigma de un campo en la unidad mostrada, o null si no hay incertidumbre que enseñar. */
export function sigmaForDisplay(
  draft: Draft,
  key: MeasurementKey,
  system: UnitSystem,
): number | null {
  const f = draft.fields[key];
  if (f.sigma === null || f.sigma <= 0 || f.source === 'user' || f.text !== null) return null;
  return roundForDisplay(toDisplay(key, f.sigma, system)) || 0.1;
}

/**
 * Rellena lo que falte (y recalcula lo que ya era derivado) con `complete`, marcándolo como «regression».
 * Los valores escritos por la persona o estimados por cámara NUNCA se tocan.
 */
export function refreshDerived(
  draft: Draft,
  complete: (partial: PartialMeasurements) => Measurements,
): Draft {
  const own: Record<string, number | string> = {};
  const height = draft.fields.heightCm.value;
  if (height === null) return draft;
  own.heightCm = height;
  own.bodyBase = draft.bodyBase;
  for (const k of MEASUREMENT_KEYS) {
    const f = draft.fields[k];
    if (k !== 'heightCm' && f.value !== null && f.source !== 'regression') own[k] = f.value;
  }
  let full: Measurements;
  try {
    full = MeasurementsSchema.parse(complete(own as unknown as PartialMeasurements));
  } catch {
    return draft;
  }
  const fields = { ...draft.fields };
  for (const k of MEASUREMENT_KEYS) {
    const f = draft.fields[k];
    if (f.text !== null) continue;
    if (f.value === null || f.source === 'regression') {
      fields[k] = {
        value: Math.round(full[k] * 10) / 10,
        text: null,
        sigma: null,
        source: 'regression',
      };
    }
  }
  return { ...draft, fields };
}

/** ¿Algún campo pendiente de confirmar o con valor derivado? Útil para decidir si hace falta refrescar. */
export function hasDerived(draft: Draft): boolean {
  return MEASUREMENT_KEYS.some((k) => draft.fields[k].source === 'regression');
}
