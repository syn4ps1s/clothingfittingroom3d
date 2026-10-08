import { Suspense, lazy, useEffect, useState } from 'react';
import { useAppCamera } from '../world/api/camera';
import { useLang, useT } from '../i18n';
import { stageWantsCamera } from '../state/flow';
import { appStore, useApp } from '../state/store';
import { viewStore, useView } from '../world/viewStore';
import { CameraProvider } from './CameraContext';
import { ErrorBoundary } from './ErrorBoundary';
import { useLayoutWatcher, useMotionWatcher } from './hooks';
import { appParams } from './params';
import { hasWebgl2 } from './webgl';
import { CameraPanel, HeightPanel } from '../ui/CameraScreen';
import { BookScreenStage } from '../ui/BookStage';
import { CatalogPanel } from '../ui/CatalogScreen';
import { DebugHud } from '../ui/DebugHud';
import { LiveRegion } from '../ui/LiveRegion';
import { SettingsDrawer } from '../ui/SettingsDrawer';
import { Toasts } from '../ui/Toasts';
import { TopBar } from '../ui/TopBar';
import { MirrorCta, WelcomePanel } from '../ui/WelcomeScreen';

const Scene = lazy(() => import('../world/Scene'));
const ScanPanel = lazy(() => import('../ui/ScanScreen'));
const FittingPanels = lazy(() => import('../ui/FittingScreen').then((m) => ({ default: m.FittingPanels })));

function Shell() {
  const t = useT();
  const lang = useLang();
  const camera = useAppCamera();
  const stage = useApp((s) => s.flow.stage);
  const layout = useView((s) => s.layout);
  const sceneStatus = useView((s) => s.sceneStatus);
  const [webgl] = useState(() => hasWebgl2());

  useLayoutWatcher();
  useMotionWatcher();

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t('app.name');
  }, [lang, t]);

  useEffect(() => {
    viewStore.getState().setSceneStatus(webgl ? 'loading' : 'none');
  }, [webgl]);

  // Cámara: se pasa a «lista» cuando el permiso se concede, y se apaga en cuanto no hace falta (privacidad).
  useEffect(() => {
    if (stage === 'camera' && camera.status === 'ready') appStore().getState().send({ type: 'CAMERA_READY' });
  }, [stage, camera.status]);
  useEffect(() => {
    if (!stageWantsCamera(stage) && camera.status !== 'idle') camera.stop();
    // `camera` cambia de identidad con su estado; basta reaccionar a la pantalla y al estado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, camera.status]);
  useEffect(() => () => camera.stop(), []);

  const params = appParams();
  return (
    <CameraProvider camera={camera}>
      <div className="app" data-stage={stage} data-layout={layout} data-scene={sceneStatus}>
        <a className="skip-link" href="#main">
          {t('app.skipToContent')}
        </a>
        {webgl && (
          <div className="scene-layer" aria-hidden="true" data-testid="scene-layer">
            <ErrorBoundary
              fallback={() => null}
              onError={() => viewStore.getState().setSceneStatus('failed')}
            >
              <Suspense fallback={null}>
                <Scene camera={camera} />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
        <TopBar />
        <main id="main" className="stage" tabIndex={-1}>
          <div className="css3d" aria-hidden="false">
            <div id="css3d-camera" className="css3d__camera" />
          </div>
          <div className="hud">
            {stage === 'welcome' && (
              <>
                <WelcomePanel />
                <MirrorCta />
              </>
            )}
            {stage === 'camera' && <CameraPanel />}
            {stage === 'height' && <HeightPanel />}
            {stage === 'scan' && (
              <Suspense fallback={null}>
                <ScanPanel />
              </Suspense>
            )}
            {(stage === 'manual' || stage === 'book') && <BookScreenStage key={stage} stage={stage} />}
            {stage === 'catalog' && <CatalogPanel />}
            {stage === 'fitting' && (
              <Suspense fallback={null}>
                <FittingPanels />
              </Suspense>
            )}
          </div>
        </main>
        <Toasts />
        <LiveRegion />
        <SettingsDrawer />
        {params.debug && <DebugHud />}
      </div>
    </CameraProvider>
  );
}

export function App() {
  const t = useT();
  return (
    <ErrorBoundary
      fallback={(error) => (
        <div className="fatal surface-paper" role="alert">
          <h1>{t('app.unknownError')}</h1>
          <p>{error.message}</p>
          <button type="button" className="btn btn--brass btn--md" onClick={() => location.reload()}>
            <span>{t('app.reload')}</span>
          </button>
        </div>
      )}
    >
      <Shell />
    </ErrorBoundary>
  );
}
