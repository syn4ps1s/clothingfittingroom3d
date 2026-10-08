import { useT } from '../i18n';
import { useApp } from '../state/store';
import { useView } from '../world/viewStore';
import { useCameraController } from '../app/CameraContext';
import { beginCamera, goManual } from '../app/actions';
import { Icon } from './Icon';
import { Panel } from './Panel';
import { Button } from './primitives';

/** Bienvenida: título, promesa de privacidad y alternativas. El botón principal vive sobre el espejo. */
export function WelcomePanel() {
  const t = useT();
  const camera = useCameraController();
  const hasSaved = useApp((s) => s.flow.hasMeasurements);
  const send = useApp((s) => s.send);
  const noScene = useView((s) => s.sceneStatus === 'none');

  return (
    <Panel id="welcome-copy" stage="welcome" dock="left" width={440} label={t('stage.welcome')} className="welcome">
      <p className="eyebrow">{t('app.tagline')}</p>
      <h1 className="display" tabIndex={-1} data-stage-heading>
        {t('welcome.title')}
      </h1>
      <p className="lead">{t('welcome.lead')}</p>

      {noScene && (
        <p className="notice" role="note">
          <Icon name="alert" size={18} />
          <span>
            <strong>{t('fallback.title')}.</strong> {t('fallback.text')}
          </span>
        </p>
      )}

      <section className="privacy" aria-labelledby="privacy-heading">
        <h2 id="privacy-heading" className="privacy__title">
          <Icon name="lock" size={18} />
          {t('welcome.privacyTitle')}
        </h2>
        <ul className="privacy__list">
          <li>{t('welcome.privacy1')}</li>
          <li>{t('welcome.privacy2')}</li>
          <li>{t('welcome.privacy3')}</li>
        </ul>
      </section>

      <div className="actions">
        <Button kind="paper" icon="ruler" onClick={() => goManual(camera)} data-testid="manual-entry">
          {t('welcome.manual')}
        </Button>
        {hasSaved && (
          <Button kind="ghost" icon="hanger" onClick={() => send({ type: 'USE_SAVED' })} data-testid="use-saved">
            {t('welcome.saved')}
          </Button>
        )}
      </div>
    </Panel>
  );
}

/** El botón «físico» sobre el espejo (en pantallas estrechas, una placa fija abajo). */
export function MirrorCta() {
  const t = useT();
  const camera = useCameraController();
  const noScene = useView((s) => s.sceneStatus === 'none');
  if (noScene) return null;
  return (
    <Panel id="welcome-cta" stage="welcome" dock="bottom" tone="bare" width={320} className="cta" label={t('welcome.mirrorSign')}>
      <Button kind="brass" size="lg" icon="camera" onClick={() => beginCamera(camera)} data-testid="start-camera">
        {t('welcome.cta')}
      </Button>
      <p className="cta__hint">{t('welcome.ctaHint')}</p>
    </Panel>
  );
}
