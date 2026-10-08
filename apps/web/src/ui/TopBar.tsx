import { STAGE_KEYS, useLang, useT, type MessageKey } from '../i18n';
import { backTarget, type Stage } from '../state/flow';
import { useApp } from '../state/store';
import { useCameraController } from '../app/CameraContext';
import { goBack } from '../app/actions';
import { Icon } from './Icon';
import { IconButton, Segmented } from './primitives';

const STEPS: readonly { key: MessageKey; stages: readonly Stage[] }[] = [
  { key: 'steps.camera', stages: ['camera', 'height', 'scan'] },
  { key: 'steps.measures', stages: ['manual', 'book'] },
  { key: 'steps.garments', stages: ['catalog'] },
  { key: 'steps.mirror', stages: ['fitting'] },
];

function BrandMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" focusable="false">
      <path d="M9 28V12.500C9 8 12 4.500 16 4.500S23 8 23 12.500V28Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12.500 28V13c0-2.700 1.500-4.500 3.500-4.500s3.500 1.800 3.500 4.500v15" fill="currentColor" opacity=".22" />
      <path d="M6 28h20" stroke="currentColor" strokeWidth="1.800" strokeLinecap="round" />
    </svg>
  );
}

export function TopBar() {
  const t = useT();
  const lang = useLang();
  const camera = useCameraController();
  const flow = useApp((s) => s.flow);
  const setSettings = useApp((s) => s.setSettings);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const target = backTarget(flow);
  const stepIndex = STEPS.findIndex((s) => s.stages.includes(flow.stage));

  return (
    <header className="topbar surface-dark">
      <div className="topbar__left">
        {target ? (
          <button type="button" className="topbar__back" onClick={() => goBack(camera)}>
            <Icon name="back" size={18} />
            <span>{t('app.back')}</span>
          </button>
        ) : null}
        <p className="brand">
          <BrandMark />
          <span className="brand__name">{t('app.name')}</span>
        </p>
      </div>

      {stepIndex >= 0 && (
        <nav className="steps" aria-label={t('steps.label')}>
          <ol>
            {STEPS.map((s, i) => (
              <li
                key={s.key}
                className="steps__item"
                data-state={i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo'}
                aria-current={i === stepIndex ? 'step' : undefined}
              >
                <span className="steps__num" aria-hidden="true">
                  {i < stepIndex ? <Icon name="check" size={13} /> : i + 1}
                </span>
                <span className="steps__label">{t.dyn(s.key)}</span>
                {i === stepIndex && <span className="sr-only"> — {t('steps.current')}</span>}
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="topbar__right">
        <Segmented
          className="segmented--compact"
          label={t('app.language')}
          value={lang}
          onChange={(v) => setSettings({ lang: v })}
          options={[
            { value: 'es', label: 'ES', ariaLabel: t('app.languageEs') },
            { value: 'en', label: 'EN', ariaLabel: t('app.languageEn') },
          ]}
        />
        <IconButton icon="gear" label={t('app.settings')} onClick={() => setSettingsOpen(true)} data-testid="open-settings" />
      </div>
      <p className="sr-only" data-stage-name>
        {t.dyn(STAGE_KEYS[flow.stage])}
      </p>
    </header>
  );
}
