import { useEffect } from 'react';
import { useApp } from '../state/store';
import { viewStore, useView } from '../world/viewStore';

/** Ancho mínimo y relación de aspecto a partir de los cuales los paneles se anclan al espacio 3D. */
const WIDE_QUERY = '(min-width: 900px) and (min-aspect-ratio: 5/4)';

/** Mantiene el almacén de vista (disposición, aspecto, alto) sincronizado con la ventana. */
export function useLayoutWatcher(): void {
  useEffect(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_QUERY) : null;
    const update = () => {
      const h = Math.max(1, window.innerHeight);
      viewStore.getState().setLayout(mq?.matches ? 'wide' : 'compact', window.innerWidth / h, h);
    };
    update();
    mq?.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => {
      mq?.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);
}

/** Resuelve «reducir movimiento»: ajuste de la persona o, por defecto, la preferencia del sistema. */
export function useMotionWatcher(): void {
  const pref = useApp((s) => s.settings.motion);
  useEffect(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const update = () => {
      const reduced = pref === 'reduce' || (pref === 'system' && Boolean(mq?.matches));
      viewStore.getState().setReducedMotion(reduced);
      document.documentElement.dataset.motion = reduced ? 'reduce' : 'full';
    };
    update();
    mq?.addEventListener('change', update);
    return () => mq?.removeEventListener('change', update);
  }, [pref]);
}

export function useReducedMotion(): boolean {
  return useView((s) => s.reducedMotion);
}
