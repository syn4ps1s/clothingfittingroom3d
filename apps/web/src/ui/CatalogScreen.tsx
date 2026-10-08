import { useMemo } from 'react';
import { GARMENT_CATEGORIES, type GarmentCategory } from '@fitroom/shared';
import { CATEGORY_KEYS, useLang, useT } from '../i18n';
import { formatPrice, localized } from '../i18n/translate';
import { useApp } from '../state/store';
import { useCameraController } from '../app/CameraContext';
import { tryGarment } from '../app/actions';
import { Icon } from './Icon';
import { Panel } from './Panel';
import { Button } from './primitives';
import { garmentMatches, useRanking, type RankedGarment } from './useRanking';

function confidenceLevel(c: number): 'high' | 'medium' | 'low' {
  return c >= 0.8 ? 'high' : c >= 0.55 ? 'medium' : 'low';
}

/** Tarjeta de prenda «colgada de una percha»: nombre, precio, talla sugerida y confianza. */
function GarmentCard({ item, featured }: { item: RankedGarment; featured?: boolean }) {
  const t = useT();
  const lang = useLang();
  const camera = useCameraController();
  const setHovered = useApp((s) => s.setHoveredGarment);
  const { garment, rec } = item;
  const name = localized(garment.name, lang);
  const level = confidenceLevel(rec.confidence);
  const percent = Math.round(rec.confidence * 100);

  return (
    <li
      className={`gcard ${featured ? 'gcard--featured' : ''}`}
      data-garment={garment.id}
      onMouseEnter={() => setHovered(garment.id)}
      onMouseLeave={() => setHovered(null)}
      onFocusCapture={() => setHovered(garment.id)}
      onBlurCapture={() => setHovered(null)}
    >
      <svg className="gcard__hanger" viewBox="0 0 40 18" aria-hidden="true" focusable="false">
        <path d="M20 3.500a2.300 2.300 0 1 0-2.300-2.300M20 3.500v3L36 16H4L20 6.500" fill="none" stroke="currentColor" strokeWidth="1.500" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="gcard__swatches" aria-hidden="true">
        {garment.variants.slice(0, 5).map((v) => (
          <span key={v.id} style={{ background: v.color }} />
        ))}
      </div>
      <h3 className="gcard__name">{name}</h3>
      <p className="gcard__meta">
        {garment.brand}
        {garment.price ? ` · ${formatPrice(garment.price.amount, lang)}` : ''}
      </p>
      <p className="gcard__fit">
        <span className="chip chip--size">{t('catalog.suggestedSize', { size: rec.size })}</span>
        <span className="conf" data-level={level} title={`${t('catalog.confidence', { level: t.dyn(`catalog.confidence.${level}`), percent })}`}>
          <span className="conf__bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </span>
          <span className="conf__text">{t('catalog.confidence', { level: t.dyn(`catalog.confidence.${level}`), percent })}</span>
        </span>
      </p>
      <Button
        kind={featured ? 'brass' : 'paper'}
        size="sm"
        icon="mirror"
        aria-label={t('catalog.tryGarment', { name })}
        onClick={() => tryGarment(garment, camera)}
        data-testid={`try-${garment.id}`}
      >
        {t('catalog.try')}
      </Button>
    </li>
  );
}

export function CatalogPanel() {
  const t = useT();
  const lang = useLang();
  const send = useApp((s) => s.send);
  const ui = useApp((s) => s.catalogUi);
  const setUi = useApp((s) => s.setCatalogUi);
  const ranking = useRanking();

  const filtered = useMemo(
    () =>
      ranking.filter(
        (r) => (ui.category === 'all' || r.garment.category === ui.category) && garmentMatches(r.garment, ui.query),
      ),
    [ranking, ui],
  );
  const showRecommended = ui.category === 'all' && ui.query.trim() === '';
  const recommended = showRecommended ? filtered.filter((r) => r.rec.overall === 'good').slice(0, 3) : [];
  const recIds = new Set(recommended.map((r) => r.garment.id));
  const rest = filtered.filter((r) => !recIds.has(r.garment.id));
  const categories: readonly (GarmentCategory | 'all')[] = ['all', ...GARMENT_CATEGORIES];
  void lang;

  return (
    <Panel id="catalog" stage="catalog" dock="bottom" width={440} label={t('catalog.title')} className="catalog">
      <p className="eyebrow">
        <Icon name="hanger" size={14} /> {t('stage.catalog')}
      </p>
      <h2 className="display display--md" tabIndex={-1} data-stage-heading>
        {t('catalog.title')}
      </h2>
      <p className="lead">{t('catalog.lead')}</p>

      <div className="search">
        <label htmlFor="catalog-search" className="field__label">
          {t('catalog.search')}
        </label>
        <div className="search__control">
          <Icon name="search" size={18} />
          <input
            id="catalog-search"
            type="search"
            autoComplete="off"
            value={ui.query}
            placeholder={t('catalog.searchPlaceholder')}
            onChange={(e) => setUi({ query: e.target.value })}
          />
        </div>
      </div>

      <div className="chips" role="group" aria-label={t('catalog.categories')}>
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            className="chip chip--filter"
            aria-pressed={ui.category === c}
            onClick={() => setUi({ category: c })}
            data-testid={`cat-${c}`}
          >
            {t.dyn(CATEGORY_KEYS[c])}
          </button>
        ))}
      </div>

      <p className="count" role="status" aria-live="polite">
        {t('catalog.count', { count: filtered.length })}
      </p>

      <div className="catalog__scroll">
        {recommended.length > 0 && (
          <section aria-labelledby="rec-title">
            <h3 id="rec-title" className="section-title">
              <Icon name="sparkle" size={15} /> {t('catalog.recommended')}
            </h3>
            <ul className="gcards" aria-label={t('catalog.recommended')}>
              {recommended.map((r) => (
                <GarmentCard key={r.garment.id} item={r} featured />
              ))}
            </ul>
          </section>
        )}
        {rest.length > 0 && (
          <section aria-labelledby="all-title">
            <h3 id="all-title" className="section-title">
              {recommended.length > 0 ? t('catalog.all') : t('catalog.listLabel')}
            </h3>
            <ul className="gcards" aria-label={t('catalog.listLabel')}>
              {rest.map((r) => (
                <GarmentCard key={r.garment.id} item={r} />
              ))}
            </ul>
          </section>
        )}
        {filtered.length === 0 && (
          <div className="empty">
            <p>{t('catalog.empty')}</p>
            <Button kind="paper" size="sm" onClick={() => setUi({ category: 'all', query: '' })}>
              {t('catalog.clearFilters')}
            </Button>
          </div>
        )}
      </div>

      <div className="actions">
        <Button kind="ghost" size="sm" icon="ruler" onClick={() => send({ type: 'EDIT_MEASUREMENTS' })} data-testid="edit-measures">
          {t('catalog.editMeasures')}
        </Button>
      </div>
    </Panel>
  );
}
