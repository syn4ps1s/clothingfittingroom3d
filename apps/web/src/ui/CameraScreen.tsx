import { useEffect, useRef, useState } from 'react';
import { CAMERA_TEXT_KEYS, CAMERA_TITLE_KEYS, useT } from '../i18n';
import { useApp } from '../state/store';
import { useCameraController } from '../app/CameraContext';
import { goManual, retryCamera, submitHeight } from '../app/actions';
import type { CameraStatus } from '../contracts';
import { FieldErrorText } from './FieldError';
import { Icon } from './Icon';
import { Panel } from './Panel';
import { Button } from './primitives';
import { useMeasureField } from './useMeasureField';

const FAILED: readonly CameraStatus[] = ['denied', 'unavailable', 'insecure-context', 'error'];

/** Estados de la cámara con mensajes claros y alternativas accionables. */
export function CameraPanel() {
  const t = useT();
  const camera = useCameraController();
  const status = camera.status;
  const failed = FAILED.includes(status);
  const waiting = status === 'requesting' || status === 'idle';

  return (
    <Panel id="camera-status" stage="camera" dock="left" width={420} label={t('stage.camera')}>
      <div role={failed ? 'alert' : 'status'} data-camera-status={status}>
        <p className="eyebrow">
          <Icon name="camera" size={14} /> {t('stage.camera')}
        </p>
        <h2 className="display display--md" tabIndex={-1} data-stage-heading>
          {t.dyn(CAMERA_TITLE_KEYS[status])}
        </h2>
        <p className="lead">{t.dyn(CAMERA_TEXT_KEYS[status])}</p>
        {status === 'error' && camera.errorMessage && (
          <p className="detail">{t('camera.detail', { message: camera.errorMessage })}</p>
        )}
      </div>
      {waiting && <div className="spinner" aria-hidden="true" />}
      {failed && (
        <div className="actions">
          {status !== 'insecure-context' && (
            <Button kind="brass" icon="camera" onClick={() => retryCamera(camera)} data-testid="retry-camera">
              {t('app.retry')}
            </Button>
          )}
          <Button
            kind={status === 'insecure-context' ? 'brass' : 'paper'}
            icon="ruler"
            onClick={() => goManual(camera)}
            data-testid="camera-manual"
          >
            {t('camera.manual')}
          </Button>
        </div>
      )}
    </Panel>
  );
}

/** Estatura: única medida obligatoria. Da la escala métrica al escaneo. */
export function HeightPanel() {
  const t = useT();
  const camera = useCameraController();
  const f = useMeasureField('heightCm');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const edited = useApp((s) => s.draft.fields.heightCm.text !== null);
  const visibleError = f.error && (submitted || edited) ? f.error : null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    setSubmitted(true);
    if (!submitHeight()) inputRef.current?.focus();
  };

  return (
    <Panel id="height" stage="height" dock="left" width={420} as="form" onSubmit={submit} labelledBy="height-title">
      <p className="eyebrow">
        <Icon name="ruler" size={14} /> {t('stage.height')}
      </p>
      <h2 id="height-title" className="display display--md">
        {t('height.title')}
      </h2>
      <p className="lead">{t('height.lead')}</p>

      <div className="field">
        <label htmlFor="height-input" className="field__label">
          {t('height.label')} <span className="field__req">· {t('measure.required')}</span>
        </label>
        <div className="field__control" data-invalid={visibleError ? 'true' : undefined}>
          <input
            id="height-input"
            ref={inputRef}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={f.text}
            aria-invalid={visibleError ? 'true' : undefined}
            aria-describedby={visibleError ? 'height-error' : undefined}
            aria-required="true"
            onChange={(e) => f.onChange(e.target.value)}
            onBlur={f.onCommit}
          />
          <span className="field__unit">{t.dyn(`measure.unit.${f.unit}`)}</span>
        </div>
        {visibleError && <FieldErrorText id="height-error" error={visibleError} />}
      </div>

      <ul className="tips">
        <li>{t('height.tip1')}</li>
        <li>{t('height.tip2')}</li>
        <li>{t('height.tip3')}</li>
      </ul>

      <div className="actions">
        <Button type="submit" kind="brass" icon="arrow" data-testid="start-scan">
          {t('height.start')}
        </Button>
        <Button kind="ghost" onClick={() => goManual(camera)} data-testid="height-manual">
          {t('height.manual')}
        </Button>
      </div>
    </Panel>
  );
}
