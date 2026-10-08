import { useMemo, useState } from 'react';
import type { FitVerdict, GarmentSlot } from '@fitroom/shared';
import { NOTE_KEYS, SLOT_KEYS, TRACKING_KEYS, VERDICT_KEYS, ZONE_KEYS, useLang, useT } from '../i18n';
import { formatDecimal, formatPrice, localized } from '../i18n/translate';
import { wornEntries } from '../state/wardrobe';
import { useApp } from '../state/store';
import { useCameraController } from '../app/CameraContext';
import { retryCamera, takeOff, takePhoto } from '../app/actions';
import { getCatalog } from '../world/api/catalog';
import { mirrorHandle } from '../world/mirrorHandle';
import { useView } from '../world/viewStore';
import { Icon, type IconName } from './Icon';
import { Panel } from './Panel';
import { Button, Segmented } from './primitives';
import { SwatchThumb } from './SwatchThumb';

/** Prenda en foco (la última tocada o la primera puesta) con todo lo necesario para mostrarla. */
function useActive() {
  const worn = useApp((s) => s.worn);
  const activeSlot = useApp((s) => s.activeSlot);
  const measurements = useApp((s) => s.measurements);
  const sigma = useApp((s) => s.sigma);
  return useMemo(() => {
    const entries = wornEntries(worn);
    const slot: GarmentSlot | null = activeSlot && worn[activeSlot] ? activeSlot : (entries[0]?.slot ?? null);
    const item = slot ? worn[slot] : undefined;
    const catalog = getCatalog();
    const garment = item ? catalog.garment(item.garmentId) : undefined;
    const fabric = garment ? catalog.fabric(garment.fabricId) : undefined;
    if (!slot || !item || !garment || !fabric || !measurements) return null;
    const rec = catalog.recommend(garment, measurements, sigma);
    const fit = catalog.evaluate(garment, item.size, measurements, sigma);
    return { slot, item, garment, fabric, rec, fit };
  }, [worn, activeSlot, measurements, sigma]);
}

type Group = 'ideal' | 'tight' | 'loose';
const GROUP: Record<FitVerdict, Group> = {
  good: 'ideal',
  snug: 'tight',
  'too-tight': 'tight',
  roomy: 'loose',
  'too-loose': 'loose',
};
const GROUP_ICON: Record<Group, IconName> = { ideal: 'check', tight: 'tight', loose: 'loose' };
const MARKER: Record<FitVerdict, number> = { 'too-tight': 0.06, snug: 0.27, good: 0.5, roomy: 0.74, 'too-loose': 0.94 };

export function VerdictChip({ verdict }: { verdict: FitVerdict }) {
  const t = useT();
  const g = GROUP[verdict];
  return (
    <span className="verdict" data-group={g} data-verdict={verdict}>
      <Icon name={GROUP_ICON[g]} size={14} />
      {t.dyn(VERDICT_KEYS[verdict])}
    </span>
  );
}

function FitReport({ active }: { active: NonNullable<ReturnType<typeof useActive>> }) {
  const t = useT();
  const lang = useLang();
  const { fit, rec, item } = active;
  const notes = item.size === rec.size ? rec.notes : rec.notes.filter((n) => n === 'low-measurement-confidence');
  return (
    <section className="fit" aria-labelledby="fit-title">
      <h3 id="fit-title" className="section-title">
        {t('fitting.fitTitle')}
      </h3>
      <p className="fit__overall" data-testid="fit-overall">
        {t('fitting.fitOverall', { verdict: t.dyn(VERDICT_KEYS[fit.overall]) })}
      </p>
      <ul className="fit__rows">
        {fit.dimensions.map((d) => {
          const ease = Math.round(d.easeCm * 10) / 10;
          return (
            <li key={d.dimension} className="fit__row" data-group={GROUP[d.verdict]}>
              <span className="fit__zone">{t.dyn(ZONE_KEYS[d.dimension])}</span>
              <span className="fit__track" aria-hidden="true">
                <span className="fit__marker" style={{ left: `${MARKER[d.verdict] * 100}%` }} />
              </span>
              <VerdictChip verdict={d.verdict} />
              <span className="fit__ease">
                {ease >= 0 ? '+' : '−'}
                {formatDecimal(Math.abs(ease), lang, 1)} cm
              </span>
            </li>
          );
        })}
      </ul>
      {notes.length > 0 && (
        <ul className="fit__notes">
          {notes.map((n) => (
            <li key={n}>{t.dyn(NOTE_KEYS[n])}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyWorn() {
  const t = useT();
  const send = useApp((s) => s.send);
  return (
    <div className="empty">
      <p>{t('fitting.noWorn')}</p>
      <Button kind="paper" size="sm" icon="hanger" onClick={() => send({ type: 'BACK' })}>
        {t('fitting.backToRack')}
      </Button>
    </div>
  );
}

export function FitSheetContent() {
  const t = useT();
  const lang = useLang();
  const active = useActive();
  const patchWorn = useApp((s) => s.patchWorn);
  if (!active) return <EmptyWorn />;
  const { garment, fabric, item, rec, slot } = active;
  return (
    <>
      <p className="eyebrow">
        <Icon name="hanger" size={14} /> {t('fitting.sheet')}
      </p>
      <h2 className="display display--md" tabIndex={-1} data-stage-heading data-testid="garment-name">
        {localized(garment.name, lang)}
      </h2>
      <p className="gcard__meta">
        {t('fitting.brand', { brand: garment.brand })}
        {garment.price ? ` · ${formatPrice(garment.price.amount, lang)}` : ''}
      </p>
      <p className="sheet__desc">{localized(garment.description, lang)}</p>
      <p className="sheet__fabric">{t('fitting.fabric', { name: localized(fabric.name, lang) })}</p>

      <Segmented
        label={t('fitting.sizeGroup')}
        value={item.size}
        onChange={(size) => patchWorn(slot, { size })}
        className="segmented--sizes"
        options={garment.sizes.map((s) => ({
          value: s.label,
          label: (
            <>
              {s.label}
              {s.label === rec.size && (
                <span className="segmented__badge" title={t('fitting.suggestedHint', { size: rec.size })}>
                  ★<span className="sr-only"> {t('fitting.suggested')}</span>
                </span>
              )}
            </>
          ),
          ariaLabel: `${t('fitting.size')} ${s.label}${s.label === rec.size ? ` (${t('fitting.suggested')})` : ''}`,
        }))}
      />
      <FitReport active={active} />
    </>
  );
}

export function SwatchesContent() {
  const t = useT();
  const lang = useLang();
  const active = useActive();
  const patchWorn = useApp((s) => s.patchWorn);
  if (!active) return null;
  const { garment, fabric, item, slot } = active;
  return (
    <>
      <p className="eyebrow">
        <Icon name="sparkle" size={14} /> {t('fitting.swatches')}
      </p>
      <p className="help">{t('fitting.swatchesHint')}</p>
      <Segmented
        label={t('fitting.swatches')}
        className="segmented--swatches"
        value={item.variantId}
        onChange={(variantId) => patchWorn(slot, { variantId })}
        options={garment.variants.map((v) => ({
          value: v.id,
          ariaLabel: t('fitting.swatch', { name: localized(v.name, lang) }),
          label: (
            <span className="swatch">
              <SwatchThumb fabric={fabric} variant={v} />
              <span className="swatch__name">{localized(v.name, lang)}</span>
            </span>
          ),
        }))}
      />
    </>
  );
}

export function LayersContent() {
  const t = useT();
  const lang = useLang();
  const worn = useApp((s) => s.worn);
  const activeSlot = useApp((s) => s.activeSlot);
  const setActiveSlot = useApp((s) => s.setActiveSlot);
  const catalog = getCatalog();
  const entries = wornEntries(worn);
  return (
    <section aria-labelledby="layers-title" className="layers">
      <h3 id="layers-title" className="section-title">
        <Icon name="layers" size={15} /> {t('fitting.layers')}
      </h3>
      <ul className="layers__list">
        {entries.map(({ slot, item }) => {
          const g = catalog.garment(item.garmentId);
          if (!g) return null;
          const name = localized(g.name, lang);
          return (
            <li key={slot} className="layer" data-active={slot === (activeSlot ?? entries[0]?.slot)}>
              <span className="layer__slot">{t.dyn(SLOT_KEYS[slot])}</span>
              <button type="button" className="layer__name" onClick={() => setActiveSlot(slot)} aria-label={t('fitting.focusItem', { name })}>
                {name}
                <span className="layer__size">{item.size}</span>
              </button>
              <button type="button" className="icon-btn icon-btn--sm" onClick={() => takeOff(slot)} aria-label={t('fitting.removeItem', { name })} title={t('fitting.remove')}>
                <Icon name="trash" size={16} />
              </button>
            </li>
          );
        })}
        {entries.length === 0 && <li className="layer layer--empty">{t('fitting.layerEmpty')}</li>}
      </ul>
    </section>
  );
}

export function ToolbarContent() {
  const t = useT();
  const camera = useCameraController();
  const send = useApp((s) => s.send);
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const mirrored = useApp((s) => s.settings.mirrored);
  const quality = useApp((s) => s.settings.quality);
  const setSettings = useApp((s) => s.setSettings);
  const tracking = useView((s) => s.tracking);
  const [busy, setBusy] = useState(false);
  const cameraOn = camera.status === 'ready';
  const nextQuality = quality === 'low' ? 'medium' : quality === 'medium' ? 'high' : 'low';

  return (
    <>
      <Button kind="brass" size="sm" icon="photo" disabled={busy} onClick={() => { setBusy(true); void takePhoto(mirrorHandle.current).finally(() => setBusy(false)); }} data-testid="photo">
        {t('fitting.photo')}
      </Button>
      <Segmented
        className="segmented--compact segmented--inline"
        label={t('fitting.compareLabel')}
        value={view}
        onChange={setView}
        options={[
          { value: 'before', label: t('fitting.before') },
          { value: 'after', label: t('fitting.after') },
        ]}
      />
      <Button kind="paper" size="sm" icon="mirror" aria-pressed={mirrored} onClick={() => setSettings({ mirrored: !mirrored })} data-testid="toggle-mirror">
        {t('fitting.mirror')}: {mirrored ? t('app.on') : t('app.off')}
      </Button>
      <Button kind="paper" size="sm" icon="sparkle" onClick={() => setSettings({ quality: nextQuality })} data-testid="cycle-quality" aria-label={`${t('fitting.quality')}: ${t.dyn(`settings.quality.${quality}`)}`}>
        {t('fitting.quality')}: {t.dyn(`settings.quality.${quality}`)}
      </Button>
      <Button kind="paper" size="sm" icon="camera" onClick={() => (cameraOn ? camera.stop() : retryCamera(camera))} data-testid="toggle-camera">
        {cameraOn ? t('camera.stop') : t('camera.start')}
      </Button>
      <Button kind="ghost" size="sm" icon="hanger" onClick={() => send({ type: 'BACK' })} data-testid="back-to-rack">
        {t('fitting.backToRack')}
      </Button>
      <Button kind="ghost" size="sm" icon="ruler" onClick={() => send({ type: 'EDIT_MEASUREMENTS' })}>
        {t('fitting.measures')}
      </Button>
      <p className="tracking" role="status" aria-live="polite" data-tracking={tracking}>
        <span className="tracking__dot" aria-hidden="true" />
        {cameraOn ? t.dyn(TRACKING_KEYS[tracking]) : t('fitting.cameraOffHint')}
      </p>
    </>
  );
}

const TABS = ['size', 'swatches', 'layers'] as const;

/** Probador en pantallas anchas: ficha y talla a la izquierda, mesa de muestras a la derecha, rail de acciones abajo. */
export function FittingPanels() {
  const t = useT();
  const layout = useView((s) => s.layout);
  const [tab, setTab] = useState<(typeof TABS)[number]>('size');

  if (layout === 'compact') {
    const labels = { size: t('fitting.size'), swatches: t('fitting.swatches'), layers: t('fitting.layers') };
    return (
      <>
        <Panel id="fit-sheet" stage="fitting" dock="bottom" className="fit-compact" label={t('fitting.sheet')}>
          <div role="tablist" aria-label={t('fitting.sheet')} className="tabs">
            {TABS.map((id) => (
              <button
                key={id}
                id={`tab-${id}`}
                role="tab"
                type="button"
                aria-selected={tab === id}
                aria-controls={`tabpanel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={(e) => {
                  const i = TABS.indexOf(id);
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
                    setTab(next);
                    document.getElementById(`tab-${next}`)?.focus();
                  }
                }}
              >
                {labels[id]}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`} className="tabs__panel">
            {tab === 'size' && <FitSheetContent />}
            {tab === 'swatches' && <SwatchesContent />}
            {tab === 'layers' && <LayersContent />}
          </div>
        </Panel>
        <Panel id="fit-toolbar" stage="fitting" dock="top" tone="dark" className="toolbar" label={t('fitting.toolbar')}>
          <ToolbarContent />
        </Panel>
      </>
    );
  }

  return (
    <>
      <Panel id="fit-sheet" stage="fitting" dock="left" width={380} label={t('fitting.sheet')} className="fit-sheet">
        <FitSheetContent />
      </Panel>
      <Panel id="fit-swatches" stage="fitting" dock="right" width={360} label={t('fitting.swatches')} className="fit-swatches">
        <SwatchesContent />
        <LayersContent />
      </Panel>
      <Panel id="fit-toolbar" stage="fitting" dock="bottom" tone="dark" width={940} className="toolbar" label={t('fitting.toolbar')}>
        <ToolbarContent />
      </Panel>
    </>
  );
}
