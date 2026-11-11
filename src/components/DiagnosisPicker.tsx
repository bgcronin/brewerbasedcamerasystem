import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { addDiagnosis, canonicalDiagnosis, hasDiagnosis, removeDiagnosis, sameDiagnosis, suggestDiagnoses } from '../lib/diagnoses';
import { Icon } from './Icon';
import { cx } from './ui';

/** A diagnosis label. `onClick` makes it a button (used as a search filter); `onRemove` adds a ×. */
export function DiagnosisChip({ name, onRemove, onClick, active, count }: { name: string; onRemove?: () => void; onClick?: () => void; active?: boolean; count?: number }) {
  const body = (
    <>
      <span className="dx-chip-name">{name}</span>
      {count != null && <span className="dx-chip-count">{count}</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cx('dx-chip dx-chip-btn', active && 'is-on')} onClick={onClick} aria-pressed={active}>
        {body}
      </button>
    );
  }
  return (
    <span className="dx-chip">
      {body}
      {onRemove && (
        <button type="button" className="dx-chip-x" onClick={onRemove} aria-label={`Remove ${name}`} title={`Remove ${name}`}>
          <Icon name="x" size={11} strokeWidth={2.2} />
        </button>
      )}
    </span>
  );
}

/**
 * Type-ahead for diagnosis labels. Suggestions come from a built-in anterior
 * segment list (abbreviations and either spelling work: "KC", "edema"), the
 * patient's earlier diagnoses and the ones used most recently. Anything else
 * can simply be typed and kept.
 */
export function DiagnosisPicker({
  value,
  onChange,
  preferred = [],
  placeholder = 'Add a diagnosis…',
  inputId,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** Offered first: this patient's earlier diagnoses, then recent ones. */
  preferred?: string[];
  placeholder?: string;
  inputId?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [up, setUp] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const suggestions = useMemo(() => suggestDiagnoses(query, { exclude: value, preferred, limit: 7 }), [query, value, preferred]);
  const typed = canonicalDiagnosis(query);
  // Offer the typed text itself unless it is already a suggestion or already chosen.
  const custom = typed && !suggestions.some((s) => sameDiagnosis(s, typed)) && !hasDiagnosis(value, typed) ? typed : null;
  const options = custom ? [...suggestions, custom] : suggestions;

  useEffect(() => setHi(0), [query]);
  // Near the bottom of the window the list opens upwards instead of being cut off.
  useEffect(() => {
    if (!open || !field.current) return;
    const r = field.current.getBoundingClientRect();
    // The list is clipped by whichever panel scrolls it, so measure the room inside that panel.
    const panel = field.current.closest('.insp-scroll, .viewer-info')?.getBoundingClientRect();
    const below = (panel?.bottom ?? window.innerHeight) - r.bottom;
    const above = r.top - (panel?.top ?? 0);
    setUp(below < 300 && above > below);
  }, [open]);
  useEffect(() => {
    list.current?.querySelector('.is-hi')?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const pick = (name: string) => {
    onChange(addDiagnosis(value, name));
    setQuery('');
    setHi(0);
    input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHi((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = open ? options[hi] : undefined;
      if (choice) pick(choice);
      else if (typed && !hasDiagnosis(value, typed)) pick(typed);
    } else if (e.key === 'Backspace' && !query && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape' && (open || query)) {
      // First Esc closes the list and clears the text; the next one leaves the field.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div className={cx('dx-picker', open && options.length > 0 && 'is-open')}>
      <div ref={field} className="dx-field" onClick={() => input.current?.focus()}>
        {value.map((d) => (
          <DiagnosisChip key={d} name={d} onRemove={() => onChange(removeDiagnosis(value, d))} />
        ))}
        <input
          ref={input}
          id={inputId}
          className="dx-input"
          value={query}
          placeholder={value.length ? 'Add another…' : placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setQuery('');
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-autocomplete="list"
          aria-label="Diagnosis"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {open && options.length > 0 && (
        <ul ref={list} className={cx('dx-menu', up && 'is-up')} role="listbox">
          {!query && <li className="dx-menu-head">Recent</li>}
          {options.map((o, i) => (
            <li
              key={o}
              role="option"
              aria-selected={i === hi}
              className={cx('dx-option', i === hi && 'is-hi')}
              // mousedown, so the choice lands before the input's blur closes the list
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              onMouseEnter={() => setHi(i)}
            >
              {o === custom ? (
                <>
                  <Icon name="plus" size={13} />
                  <span>
                    Use “{o}”
                  </span>
                </>
              ) : (
                <span>{o}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
