import { useEffect, useMemo, useRef, useState } from 'react';
import { BODY_BASES, MEASUREMENT_KEYS, type BodyBase, type MeasurementKey } from '@fitroom/shared';
import { BODY_BASE_KEYS, MEASURE_KEYS, SOURCE_KEYS, useT } from '../i18n';
import { formatDecimal } from '../i18n/translate';
import { commitAll, setBodyBase, toPartial, validateDraft } from '../state/measurementDraft';
import { useApp } from '../state/store';
import { toDisplay } from '../state/units';
import { useCameraController } from '../app/CameraContext';
import { confirmBook, goBack, submitManual } from '../app/actions';
import { completeMeasurementsApi } from '../world/api/body';
import { FieldErrorText } from './FieldError';
import { Icon } from './Icon';
import { Panel } from './Panel';
import { Button, Segmented, Switch } from './primitives';
import { useMeasureField } from './useMeasureField';

const ORDER: readonly MeasurementKey[] = [
  'heightCm',
  'weightKg',
  'chestCm',
  'waistCm',
  'hipCm',
  'shoulderWidthCm',
  'armLengthCm',
  'inseamCm',
  'neckCm',
  'thighCm',
];

function MeasureRow({
  k,
  mode,
  showErrors,
  placeholder,
}: {
  k: MeasurementKey;
  mode: 'manual' | 'book';
  showErrors: boolean;
  placeholder?: string;
}) {
  const t = useT();
  const lang = useApp((s) => s.settings.lang);
  const f = useMeasureField(k, { refresh: mode === 'book' });
  const edited = useApp((s) => s.draft.fields[k].text !== null);
  const id = `m-${k}`;
  const required = k === 'heightCm';
  const error = f.error && (showErrors || edited) ? f.error : null;
  const sigmaText =
    f.sigma !== null ? t('measure.sigma', { value: formatDecimal(f.sigma, lang, 1), unit: t.dyn(`measure.unit.${f.unit}`) }) : null;

  return (
    <li className="mrow" data-invalid={error ? 'true' : undefined}>
      <label htmlFor={id} className="mrow__label">
        {t.dyn(MEASURE_KEYS[k])}
        {required && (
          <span className="mrow__req" title={t('measure.required')}>
            {' '}
            *<span className="sr-only"> {t('measure.required')}</span>
          </span>
        )}
      </label>
      <div className="mrow__control">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={f.text}
          placeholder={placeholder}
          aria-invalid={error ? 'true' : undefined}
          aria-required={required || undefined}
          aria-describedby={[error ? `${id}-err` : '', sigmaText ? `${id}-sig` : ''].filter(Boolean).join(' ') || undefined}
          onChange={(e) => f.onChange(e.target.value)}
          onBlur={f.onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') f.onCommit();
          }}
        />
        <span className="mrow__unit">{t.dyn(`measure.unit.${f.unit}`)}</span>
      </div>
      <div className="mrow__meta">
        {sigmaText && (
          <span id={`${id}-sig`} className="mrow__sigma" title={t('measure.sigmaLabel', { value: formatDecimal(f.sigma ?? 0, lang, 1), unit: t.dyn(`measure.unit.${f.unit}`) })}>
            {sigmaText}
          </span>
        )}
        <span className="mrow__source" data-source={f.source ?? 'empty'}>
          {f.source ? t.dyn(SOURCE_KEYS[f.source]) : t('measure.source.empty')}
        </span>
      </div>
      {error && <FieldErrorText id={`${id}-err`} error={error} />}
    </li>
  );
}

/**
 * Libro de medidas del sastre. `book`: revisar lo estimado (o escrito) con su incertidumbre y confirmar.
 * `manual`: la misma hoja en blanco para quien no usa la cámara.
 */
export function MeasurementBook({ mode }: { mode: 'manual' | 'book' }) {
  const t = useT();
  const camera = useCameraController();
  const origin = useApp((s) => s.flow.origin);
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const draft = useApp((s) => s.draft);
  const setDraft = useApp((s) => s.setDraft);
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<'invalid' | 'failed' | null>(null);
  const summaryRef = useRef<HTMLParagraphElement | null>(null);
  const hasEstimates = MEASUREMENT_KEYS.some((k) => {
    const s = draft.fields[k].source;
    return s === 'scan-video' || s === 'scan-photo';
  });

  const errorCount = Object.keys(validateDraft(draft, settings.units).errors).length;

  // Valores derivados como «placeholder» en la hoja en blanco (se calculan a partir de la estatura).
  const hints = useMemo(() => {
    if (mode !== 'manual') return null;
    const partial = toPartial(draft);
    if (!partial) return null;
    try {
      return completeMeasurementsApi({ heightCm: partial.heightCm, bodyBase: partial.bodyBase });
    } catch {
      return null;
    }
  }, [mode, draft]);

  useEffect(() => {
    if (attempted && errorCount > 0) {
      document.querySelector<HTMLInputElement>('.mrow[data-invalid="true"] input')?.focus();
    }
    // sólo al intentar enviar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempted]);

  const submit = () => {
    setAttempted(true);
    if (mode === 'manual') {
      if (!submitManual()) setFailure('invalid');
      return;
    }
    const r = confirmBook();
    if (!r.ok) setFailure(r.reason === 'invalid-input' || r.reason === 'incomplete' ? 'invalid' : 'failed');
  };

  const subtitle = origin === 'scan' ? t('book.subtitle.scan') : origin === 'saved' ? t('book.subtitle.saved') : t('book.subtitle.manual');

  return (
    <Panel
      id="book"
      stage={mode === 'manual' ? 'manual' : 'book'}
      dock="bottom"
      width={940}
      as="form"
      onSubmit={submit}
      tone="paper"
      className="book"
      labelledBy="book-title"
    >
      <div className="book__spread">
        <div className="book__page book__page--left">
          <p className="eyebrow">
            <Icon name="ruler" size={14} /> {mode === 'manual' ? t('stage.manual') : t('book.title')}
          </p>
          <h2 id="book-title" className="display display--md" tabIndex={-1} data-stage-heading>
            {mode === 'manual' ? t('manual.title') : t('book.title')}
          </h2>
          {mode === 'book' && <p className="book__subtitle">{subtitle}</p>}
          <p className="lead">{mode === 'manual' ? t('manual.lead') : ''}</p>

          {mode === 'book' && hasEstimates && (
            <div className="disclaimer" role="note">
              <Icon name="alert" size={18} />
              <div>
                <strong>{t('book.disclaimerTitle')}</strong>
                <p>{t('book.disclaimer')}</p>
              </div>
            </div>
          )}
          {mode === 'manual' && <p className="help">{t('manual.tapeTip')}</p>}

          <Segmented
            label={t('measure.units')}
            value={settings.units}
            onChange={(units) => {
              // Confirma lo escrito en la unidad anterior antes de cambiar (el canónico no se toca).
              setDraft(commitAll(draft, settings.units));
              setSettings({ units });
            }}
            options={[
              { value: 'metric', label: t('measure.units.metric') },
              { value: 'imperial', label: t('measure.units.imperial') },
            ]}
          />
          <div>
            <Segmented
              label={t('measure.bodyBase')}
              value={draft.bodyBase}
              onChange={(v: BodyBase) => setDraft(setBodyBase(draft, v))}
              options={BODY_BASES.map((b) => ({ value: b, label: t.dyn(BODY_BASE_KEYS[b]) }))}
            />
            <p className="help">{t('measure.bodyBaseHelp')}</p>
          </div>
          {mode === 'book' && (
            <Switch
              label={t('book.remember')}
              help={t('book.rememberHelp')}
              checked={settings.remember}
              onChange={(remember) => setSettings({ remember })}
            />
          )}
        </div>

        <div className="book__page book__page--right">
          <div className="book__head" aria-hidden="true">
            <span>{t('book.columnMeasure')}</span>
            <span>{t('book.columnValue')}</span>
            <span>{t('book.columnOrigin')}</span>
          </div>
          <ul className="mrows">
            {ORDER.map((k) => (
              <MeasureRow
                key={k}
                k={k}
                mode={mode}
                showErrors={attempted}
                placeholder={
                  hints && k !== 'heightCm'
                    ? `≈ ${formatDecimal(Math.round(toDisplay(k, hints[k], settings.units) * 10) / 10, settings.lang, 1)}`
                    : undefined
                }
              />
            ))}
          </ul>
          {failure && attempted && (
            <p ref={summaryRef} className="form-error" role="alert">
              <Icon name="alert" size={16} />
              {failure === 'failed'
                ? t('book.failed')
                : errorCount > 0
                  ? t('measure.error.summary', { count: errorCount })
                  : t('book.invalid')}
            </p>
          )}
          <div className="actions book__actions">
            <Button type="submit" kind="brass" icon="check" data-testid={mode === 'manual' ? 'manual-submit' : 'book-confirm'}>
              {mode === 'manual' ? t('manual.submit') : t('book.confirm')}
            </Button>
            {mode === 'book' && origin === 'scan' && (
              <Button kind="paper" icon="camera" onClick={() => goBack(camera)} data-testid="book-rescan">
                {t('book.rescan')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
