import { dismissToast, useApp } from '../state/store';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';

const TONE_ICON: Record<string, IconName> = { success: 'check', warning: 'alert', error: 'alert', default: 'info' };

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.tone ?? 'default'}`)} role={t.tone === 'error' ? 'alert' : 'status'}>
          <span className="toast-icon">
            <Icon name={TONE_ICON[t.tone ?? 'default']} size={16} strokeWidth={2} />
          </span>
          <span className="toast-text">
            <strong>{t.message}</strong>
            {t.detail && <span>{t.detail}</span>}
          </span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
