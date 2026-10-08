import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type ButtonKind = 'brass' | 'paper' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly kind?: ButtonKind;
  readonly icon?: IconName;
  readonly size?: 'md' | 'lg' | 'sm';
  readonly block?: boolean;
}

/** Botón físico: placa de latón (primario), papel (secundario), fantasma o peligro. Siempre >= 44 px de alto. */
export function Button({ kind = 'paper', icon, size = 'md', block, className, children, type, ...rest }: ButtonProps) {
  const cls = ['btn', `btn--${kind}`, `btn--${size}`, block ? 'btn--block' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type ?? 'button'} className={cls} {...rest}>
      {icon && <Icon name={icon} size={size === 'lg' ? 22 : 18} />}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({
  icon,
  label,
  className,
  ...rest
}: { icon: IconName; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`icon-btn ${className ?? ''}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={20} />
    </button>
  );
}

export interface SegmentOption<V extends string> {
  readonly value: V;
  readonly label: ReactNode;
  readonly ariaLabel?: string;
}

/** Grupo de radios con aspecto de selector segmentado (flechas para moverse, un solo tab-stop). */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: V;
  options: readonly SegmentOption<V>[];
  onChange: (v: V) => void;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={`segmented ${className ?? ''}`}>
      <legend className="segmented__legend">{label}</legend>
      <div className="segmented__track">
        {options.map((o) => (
          <label key={o.value} className="segmented__option">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={o.value === value}
              onChange={() => onChange(o.value)}
              aria-label={o.ariaLabel}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Interruptor accesible (checkbox con role=switch) con ayuda opcional enlazada. */
export function Switch({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="switch">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        aria-describedby={help ? `${id}-help` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id}>
        <span className="switch__track" aria-hidden="true">
          <span className="switch__thumb" />
        </span>
        <span className="switch__text">{label}</span>
      </label>
      {help && (
        <p id={`${id}-help`} className="switch__help">
          {help}
        </p>
      )}
    </div>
  );
}
