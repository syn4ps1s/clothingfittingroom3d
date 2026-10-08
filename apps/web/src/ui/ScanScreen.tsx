import { useEffect, useRef } from 'react';
import { SCAN_HINT_KEYS, SCAN_PHASE_KEYS, useT } from '../i18n';
import { appStore, useApp } from '../state/store';
import { appParams } from '../app/params';
import { useCameraController } from '../app/CameraContext';
import { finishScan, goManual } from '../app/actions';
import type { PoseSourceKind } from '../contracts';
import { useAppBodyScan } from '../world/api/mirror';
import { Icon } from './Icon';
import { Panel } from './Panel';
import { Button } from './primitives';

const R = 54;
const C = 2 * Math.PI * R;

/** Anillo de progreso: valor y etiqueta accesibles (`progressbar`). */
function ProgressRing({ value, label, percentText }: { value: number; label: string; percentText: string }) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <div
      className="ring"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <svg viewBox="0 0 128 128" width="128" height="128" aria-hidden="true" focusable="false">
        <circle className="ring__track" cx="64" cy="64" r={R} />
        <circle
          className="ring__value"
          cx="64"
          cy="64"
          r={R}
          strokeDasharray={C}
          strokeDashoffset={C * (1 - clamped)}
          transform="rotate(-90 64 64)"
        />
      </svg>
      <span className="ring__text" aria-hidden="true">
        {percentText}
      </span>
    </div>
  );
}

/** Escaneo de talla guiado: fase, pista (aria-live) y progreso. La pose la procesa MIRROR; aquí sólo se presenta. */
export default function ScanPanel() {
  const t = useT();
  const camera = useCameraController();
  const source: PoseSourceKind = appParams().synthetic ? 'synthetic' : 'camera';
  const scan = useAppBodyScan(camera, source);
  const send = useApp((s) => s.send);
  const { phase, hint, progress } = scan.progress;
  const failed = phase === 'failed';
  const startRef = useRef(scan.start);
  const cancelRef = useRef(scan.cancel);
  startRef.current = scan.start;
  cancelRef.current = scan.cancel;

  useEffect(() => {
    const height = appStore().getState().draft.fields.heightCm.value;
    if (height === null) {
      send({ type: 'SCAN_CANCEL' });
      return undefined;
    }
    startRef.current(height);
    return () => cancelRef.current();
  }, [send]);

  useEffect(() => {
    if (phase === 'complete' && scan.estimate) {
      appStore().getState().applyEstimate(scan.estimate);
      finishScan();
    }
  }, [phase, scan.estimate]);

  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);

  return (
    <Panel id="scan" stage="scan" dock="left" width={400} label={t('scan.title')}>
      <p className="eyebrow">
        <Icon name="ruler" size={14} /> {t('stage.scan')}
      </p>
      <h2 className="display display--md" tabIndex={-1} data-stage-heading>
        {failed ? t('scan.failedTitle') : t('scan.title')}
      </h2>

      {failed ? (
        <>
          <p className="lead" role="alert">
            {t('scan.failedText')}
          </p>
          <div className="actions">
            <Button
              kind="brass"
              icon="camera"
              onClick={() => {
                const h = appStore().getState().draft.fields.heightCm.value;
                if (h !== null) scan.start(h);
              }}
              data-testid="scan-retry"
            >
              {t('scan.retry')}
            </Button>
            <Button kind="paper" icon="ruler" onClick={() => goManual(camera)}>
              {t('camera.manual')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="scan">
            <ProgressRing
              value={progress}
              label={t('scan.progressLabel')}
              percentText={t('scan.percent', { percent })}
            />
            <div className="scan__text">
              <p className="scan__phase">{t.dyn(SCAN_PHASE_KEYS[phase])}</p>
              <p className="scan__hint" role="status" aria-live="polite" data-testid="scan-hint">
                {t.dyn(SCAN_HINT_KEYS[hint])}
              </p>
            </div>
          </div>
          <div className="actions">
            <Button
              kind="paper"
              onClick={() => {
                scan.cancel();
                send({ type: 'SCAN_CANCEL' });
              }}
              data-testid="scan-cancel"
            >
              {t('scan.cancel')}
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
