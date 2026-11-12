import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { initials } from '../lib/names';
import { useBackgroundInert } from '../lib/overlay';
import { useThumb } from '../lib/thumbs';
import type { Eye, Patient } from '../lib/types';
import { Icon, type IconName } from './Icon';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'plain';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'lg'; icon?: IconName; iconRight?: IconName }) {
  return (
    <button type="button" className={cx('btn', `btn-${variant}`, `btn-${size}`, !children && 'btn-icon', className)} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children && <span>{children}</span>}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 14 : 16} />}
    </button>
  );
}

export function IconButton({ icon, label, active, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; active?: boolean }) {
  return (
    <button type="button" className={cx('icon-btn', active && 'is-active', className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

/** A button that opens a short list of actions. */
export function Menu({
  label,
  icon,
  items,
  size = 'md',
  variant = 'secondary',
  disabled,
  align = 'right',
}: {
  label: ReactNode;
  icon?: IconName;
  items: { label: string; detail?: string; icon?: IconName; onSelect: () => void; disabled?: boolean }[];
  size?: 'sm' | 'md';
  variant?: BtnVariant;
  disabled?: boolean;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    // Escape closes the list and nothing else (not the sheet or viewer it sits in).
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      root.current?.querySelector<HTMLElement>('button')?.focus();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return (
    <div ref={root} className={cx('menu', open && 'is-open', `menu-${align}`)}>
      <Button size={size} variant={variant} icon={icon} iconRight="chevronDown" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </Button>
      {open && (
        <ul className="menu-list" role="menu">
          {items.map((it) => (
            <li key={it.label} role="none">
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.icon && <Icon name={it.icon} size={16} />}
                <span className="menu-item-text">
                  <span>{it.label}</span>
                  {it.detail && <span className="menu-item-detail">{it.detail}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div
      className={cx('segmented', `segmented-${size}`, className)}
      role="radiogroup"
      aria-label={ariaLabel}
      style={{ ['--n' as string]: options.length, ['--i' as string]: index }}
    >
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={cx('segmented-item', o.value === value && 'is-on')}
          onClick={() => onChange(o.value)}
          title={o.title}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label?: string; id?: string }) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      className={cx('switch', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function EyeTag({ eye, size = 'sm' }: { eye: Eye; size?: 'sm' | 'md' }) {
  return <span className={cx('eye-tag', `eye-${eye.toLowerCase()}`, `eye-tag-${size}`)}>{eye}</span>;
}

export function Avatar({ patient, size = 40 }: { patient: Pick<Patient, 'firstName' | 'lastName' | 'id'>; size?: number }) {
  // A stable hue per patient within the blue family keeps the list calm but scannable.
  let h = 0;
  for (const ch of patient.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = 200 + (h % 50);
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.36, ['--hue' as string]: hue }}
      aria-hidden="true"
    >
      {initials(patient)}
    </span>
  );
}

export function Thumb({ id, alt, className }: { id: string; alt: string; className?: string }) {
  const url = useThumb(id);
  return url ? <img className={cx('thumb-img', className)} src={url} alt={alt} draggable={false} /> : <span className={cx('thumb-img thumb-loading', className)} />;
}

export function Modal({
  open,
  onClose,
  children,
  variant = 'center',
  width,
  labelledBy,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  variant?: 'center' | 'side';
  width?: number;
  labelledBy?: string;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useBackgroundInert(open);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const el = panel.current?.querySelector<HTMLElement>('[data-autofocus]');
      (el ?? panel.current)?.focus();
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className={cx('modal-root', `modal-${variant}`)} data-modal="true">
      <div className="modal-scrim" onClick={onClose} />
      <div
        ref={panel}
        className={cx('modal-panel', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={width ? { width } : undefined}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function SheetHeader({ title, subtitle, onClose, id }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; id?: string }) {
  return (
    <header className="sheet-header">
      <div>
        <h2 id={id} className="sheet-title">
          {title}
        </h2>
        {subtitle && <p className="sheet-subtitle">{subtitle}</p>}
      </div>
      <IconButton icon="x" label="Close" onClick={onClose} className="sheet-close" />
    </header>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={cx('field', wide && 'field-wide')}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'off' | 'error' | 'live' }) {
  return <span className={cx('status-dot', `status-${tone}`)} aria-hidden="true" />;
}
