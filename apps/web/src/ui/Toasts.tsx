import { useEffect } from 'react';
import { useT } from '../i18n';
import { useApp, type Toast } from '../state/store';
import { Icon } from './Icon';

function ToastItem({ toast }: { toast: Toast }) {
  const t = useT();
  const dismiss = useApp((s) => s.dismissToast);
  useEffect(() => {
    const id = window.setTimeout(() => dismiss(toast.id), toast.tone === 'error' ? 8000 : 5000);
    return () => window.clearTimeout(id);
  }, [dismiss, toast.id, toast.tone]);
  return (
    <li className={`toast toast--${toast.tone}`}>
      <Icon name={toast.tone === 'error' ? 'alert' : 'check'} size={18} />
      <span>{t.dyn(toast.key, toast.params)}</span>
      <button type="button" className="toast__close" onClick={() => dismiss(toast.id)} aria-label={t('app.close')}>
        <Icon name="close" size={16} />
      </button>
    </li>
  );
}

/** Avisos efímeros. `role=status`: los lectores de pantalla los anuncian sin robar el foco. */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <ul className="toasts" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </ul>
  );
}
