import { useCallback } from 'react';
import type { MeasurementKey } from '@fitroom/shared';
import { useLang } from '../i18n';
import {
  commitField,
  displayText,
  editField,
  fieldError,
  refreshDerived,
  sigmaForDisplay,
  type FieldError,
} from '../state/measurementDraft';
import { appStore, useApp } from '../state/store';
import { unitFor, type DisplayUnit } from '../state/units';
import { completeMeasurementsApi } from '../world/api/body';

export interface MeasureFieldBinding {
  readonly text: string;
  readonly unit: DisplayUnit;
  readonly error: FieldError | null;
  /** Incertidumbre en la unidad mostrada (sólo estimaciones de cámara). */
  readonly sigma: number | null;
  readonly source: ReturnType<typeof useSource>;
  readonly onChange: (text: string) => void;
  readonly onCommit: () => void;
  /** ¿El campo ya fue tocado o mostrado con error? Evita regañar antes de tiempo. */
  readonly touched: boolean;
}

/** El borrador vigente en el momento del evento (evita cierres obsoletos al escribir rápido). */
const currentDraft = () => appStore().getState().draft;

function useSource(key: MeasurementKey) {
  return useApp((s) => s.draft.fields[key].source);
}

/** Enlaza un campo del formulario de medidas con el borrador del almacén (texto, validación, unidades). */
export function useMeasureField(key: MeasurementKey, opts: { refresh?: boolean } = {}): MeasureFieldBinding {
  const lang = useLang();
  const draft = useApp((s) => s.draft);
  const units = useApp((s) => s.settings.units);
  const setDraft = useApp((s) => s.setDraft);
  const source = useSource(key);
  const field = draft.fields[key];

  const onChange = useCallback(
    (text: string) => setDraft(editField(currentDraft(), key, text)),
    [key, setDraft],
  );
  const onCommit = useCallback(() => {
    let next = commitField(currentDraft(), key, units);
    if (opts.refresh && next !== currentDraft()) next = refreshDerived(next, completeMeasurementsApi);
    setDraft(next);
  }, [key, units, setDraft, opts.refresh]);

  return {
    text: displayText(draft, key, units, lang),
    unit: unitFor(key, units),
    error: fieldError(draft, key, units),
    sigma: sigmaForDisplay(draft, key, units),
    source,
    onChange,
    onCommit,
    touched: field.text !== null || field.value !== null,
  };
}
