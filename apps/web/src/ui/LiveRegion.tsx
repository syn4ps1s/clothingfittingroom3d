import { useEffect, useRef, useState } from 'react';
import { STAGE_KEYS, useT } from '../i18n';
import { useApp } from '../state/store';

/** Anuncia los cambios de pantalla a lectores de pantalla y lleva el foco al encabezado de la nueva pantalla. */
export function LiveRegion() {
  const t = useT();
  const stage = useApp((s) => s.flow.stage);
  const [message, setMessage] = useState('');
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    setMessage(t('app.stageAnnouncement', { stage: t.dyn(STAGE_KEYS[stage]) }));
    // Tras montar los paneles de la nueva pantalla, el foco va a su encabezado (teclado y lector de pantalla).
    const id = window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>('[data-stage-heading]');
      if (target && !document.querySelector('[role="dialog"]')) target.focus({ preventScroll: true });
    }, 120);
    return () => window.clearTimeout(id);
    // sólo reacciona al cambio de pantalla
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  return (
    <p className="sr-only" aria-live="polite" role="status" data-testid="stage-announcer">
      {message}
    </p>
  );
}
