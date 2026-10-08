import { useT } from '../i18n';
import { formatDecimal } from '../i18n/translate';
import type { FieldError } from '../state/measurementDraft';
import { useApp } from '../state/store';
import { Icon } from './Icon';

/** Mensaje de error de un campo: siempre texto + icono (nunca sólo color). */
export function FieldErrorText({ id, error }: { id: string; error: FieldError }) {
  const t = useT();
  const lang = useApp((s) => s.settings.lang);
  const { limits } = error;
  const message =
    error.code === 'required'
      ? t('measure.error.required')
      : error.code === 'invalid'
        ? t('measure.error.invalid', { example: formatDecimal(Math.round(limits.min + 8), lang, 0) })
        : t('measure.error.range', {
            min: formatDecimal(limits.min, lang, 1),
            max: formatDecimal(limits.max, lang, 1),
            unit: t.dyn(`measure.unit.${limits.unit}`),
          });
  return (
    <p id={id} className="field__error">
      <Icon name="alert" size={15} />
      <span>{message}</span>
    </p>
  );
}
