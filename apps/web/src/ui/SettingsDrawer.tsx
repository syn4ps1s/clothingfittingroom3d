import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useApp } from '../state/store';
import { useCameraController } from '../app/CameraContext';
import { wipeEverything } from '../app/actions';
import { Icon } from './Icon';
import { Button, IconButton, Segmented, Switch } from './primitives';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Atrapa el foco dentro del diálogo y lo devuelve al abrirse/cerrarse (accesibilidad de modales). */
function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    root?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [open, onClose]);
  return ref;
}

export function SettingsDrawer() {
  const t = useT();
  const camera = useCameraController();
  const open = useApp((s) => s.settingsOpen);
  const setOpen = useApp((s) => s.setSettingsOpen);
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const [confirming, setConfirming] = useState(false);
  const close = () => {
    setConfirming(false);
    setOpen(false);
  };
  const ref = useFocusTrap(open, close);
  if (!open) return null;

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        className="drawer surface-paper"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="settings"
      >
        <header className="drawer__head">
          <h2 id="settings-title" className="display display--sm">
            {t('settings.title')}
          </h2>
          <IconButton icon="close" label={t('app.close')} onClick={close} data-autofocus />
        </header>

        <div className="drawer__body">
          <Segmented
            label={t('settings.language')}
            value={settings.lang}
            onChange={(lang) => setSettings({ lang })}
            options={[
              { value: 'es', label: t('app.languageEs') },
              { value: 'en', label: t('app.languageEn') },
            ]}
          />
          <Segmented
            label={t('settings.units')}
            value={settings.units}
            onChange={(units) => setSettings({ units })}
            options={[
              { value: 'metric', label: t('measure.units.metric') },
              { value: 'imperial', label: t('measure.units.imperial') },
            ]}
          />
          <div>
            <Segmented
              label={t('settings.quality')}
              value={settings.quality}
              onChange={(quality) => setSettings({ quality })}
              options={[
                { value: 'low', label: t('settings.quality.low') },
                { value: 'medium', label: t('settings.quality.medium') },
                { value: 'high', label: t('settings.quality.high') },
              ]}
            />
            <p className="help">{t('settings.qualityHelp')}</p>
          </div>
          <div>
            <Segmented
              label={t('settings.motion')}
              value={settings.motion}
              onChange={(motion) => setSettings({ motion })}
              options={[
                { value: 'system', label: t('settings.motion.system') },
                { value: 'reduce', label: t('settings.motion.reduce') },
                { value: 'full', label: t('settings.motion.full') },
              ]}
            />
            <p className="help">{t('settings.motionHelp')}</p>
          </div>

          <Switch
            label={t('settings.remember')}
            help={t('settings.rememberHelp')}
            checked={settings.remember}
            onChange={(remember) => setSettings({ remember })}
          />

          <section className="drawer__privacy" aria-labelledby="privacy-title">
            <h3 id="privacy-title" className="eyebrow">
              <Icon name="lock" size={14} /> {t('settings.privacy')}
            </h3>
            <p className="help">{t('settings.privacyText')}</p>
          </section>

          <section className="drawer__danger">
            <h3 className="eyebrow">{t('settings.wipe')}</h3>
            <p className="help">{t('settings.wipeHelp')}</p>
            {confirming ? (
              <div className="drawer__confirm" role="group" aria-label={t('settings.wipe')}>
                <Button
                  kind="danger"
                  icon="trash"
                  onClick={() => {
                    wipeEverything(camera);
                    close();
                  }}
                  data-testid="wipe-confirm"
                >
                  {t('settings.wipeConfirm')}
                </Button>
                <Button kind="paper" onClick={() => setConfirming(false)}>
                  {t('app.cancel')}
                </Button>
              </div>
            ) : (
              <Button kind="paper" icon="trash" onClick={() => setConfirming(true)} data-testid="wipe">
                {t('settings.wipe')}
              </Button>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
