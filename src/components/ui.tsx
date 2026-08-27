/**
 * Shared building blocks.
 *
 * Rules that apply to everything in this file:
 *   - a control always has a visible text label; icons never stand alone
 *   - status is carried by words + shape + colour, never colour alone
 *   - every error is associated with its field via aria-describedby
 *   - nothing is inert: if a thing looks interactive, it does something
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { KindlyError } from '../lib/types';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonTone = 'coral' | 'yellow' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  icon?: string;
  iconAfter?: string;
  big?: boolean;
  full?: boolean;
  loading?: boolean;
  loadingLabel?: string;
}

export function Button({
  tone = 'secondary', icon, iconAfter, big, full, loading, loadingLabel,
  children, className, disabled, type = 'button', ...rest
}: ButtonProps) {
  const classes = ['button', tone, big ? 'big' : '', full ? 'full' : '', className ?? '']
    .filter(Boolean).join(' ');
  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Icon name="i-loader" size={big ? 19 : 16} className="req-spin" /> : icon ? <Icon name={icon} size={big ? 19 : 16} strokeWidth={2.5} /> : null}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
      {!loading && iconAfter ? <Icon name={iconAfter} size={big ? 19 : 16} /> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Form fields — label, hint and error are always connected to the input
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  optionalNote?: string;
  children: (props: { id: string; describedBy: string; invalid: boolean }) => ReactNode;
}

export function Field({ label, hint, error, required, optionalNote, children }: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="field-block">
      <label htmlFor={id}>
        {label}
        {!required && optionalNote ? (
          <span style={{ fontWeight: 600, color: 'var(--muted-foreground)' }}> ({optionalNote})</span>
        ) : null}
      </label>
      {children({ id, describedBy: helpId, invalid: Boolean(error) })}
      {error ? (
        <span className="field-error" id={helpId} role="alert">
          <Icon name="i-alert" size={14} strokeWidth={2.5} />
          {error}
        </span>
      ) : hint ? (
        <small className="field-hint" id={helpId}>{hint}</small>
      ) : (
        <small className="field-hint" id={helpId} hidden />
      )}
    </div>
  );
}

interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
  optionalNote?: string;
}

export function TextInput({ label, hint, error, optionalNote, required, ...rest }: TextInputProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} optionalNote={optionalNote}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          required={required}
          {...rest}
        />
      )}
    </Field>
  );
}

interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string | null;
  optionalNote?: string;
}

export function TextArea({ label, hint, error, optionalNote, required, ...rest }: TextAreaProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} optionalNote={optionalNote}>
      {({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          rows={4}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          required={required}
          {...rest}
        />
      )}
    </Field>
  );
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: string;
  error?: string | null;
  options: { value: string; label: string }[];
}

export function Select({ label, hint, error, options, required, ...rest }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {({ id, describedBy, invalid }) => (
        <select id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </Field>
  );
}

interface ToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Shown when the toggle is locked on for a safety reason. */
  lockedReason?: string;
}

export function Toggle({ label, description, checked, onChange, disabled, lockedReason }: ToggleProps) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className="settings-row">
      <div>
        <b>
          <label htmlFor={id}>{label}</label>
        </b>
        {description ? <small id={descId}>{description}</small> : null}
        {lockedReason ? <small id={`${descId}-locked`}>{lockedReason}</small> : null}
      </div>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? descId : undefined}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 44, height: 44 }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avatar — initials come from the correct profile, never from a placeholder
// ---------------------------------------------------------------------------

interface AvatarProps {
  /** The already-computed initial. Empty string renders the neutral fallback. */
  initial: string;
  label: string;
  large?: boolean;
  className?: string;
}

export function Avatar({ initial, label, large, className }: AvatarProps) {
  const classes = ['avatar', large ? 'large' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={classes} role="img" aria-label={label}>
      <span aria-hidden="true">{initial || <Icon name="i-user-round" size={large ? 20 : 17} />}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status pill — icon + words, never colour alone
// ---------------------------------------------------------------------------

export function StatusPill({ tone, icon, text, className }: { tone: string; icon: string; text: string; className?: string }) {
  return (
    <span className={`status ${tone} ${className ?? ''}`}>
      <Icon name={icon} size={12} strokeWidth={3} />
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Data states
// ---------------------------------------------------------------------------

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state-block" role="status" aria-live="polite">
      <span className="state-icon"><Icon name="i-loader" size={24} className="req-spin" /></span>
      <h3>{label}…</h3>
      <p>This usually takes a moment.</p>
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="state-block">
      <span className="state-icon"><Icon name="i-sparkles" size={24} /></span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const kindly = error instanceof KindlyError ? error : null;
  const code = kindly?.code ?? 'UNKNOWN';
  const offline = code === 'NETWORK' || (typeof navigator !== 'undefined' && !navigator.onLine);
  const denied = code === 'PERMISSION_DENIED' || code === 'NOT_PERMITTED' || code === 'NOT_A_FAMILY_MEMBER';

  const variant = offline ? 'state-offline' : denied ? 'state-denied' : 'state-error';
  const heading = title ?? (offline ? 'You are offline' : denied ? 'You do not have access to this' : 'Something went wrong');
  const message = kindly?.message
    ?? (error instanceof Error ? error.message : 'KINDLY could not finish that. Nothing was lost.');

  return (
    <div className={`state-block ${variant}`} role="alert">
      <span className="state-icon">
        <Icon name={offline ? 'i-offline' : denied ? 'i-lock' : 'i-alert'} size={24} />
      </span>
      <h3>{heading}</h3>
      <p>{message}</p>
      {onRetry && !denied ? <Button tone="coral" icon="i-refresh" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

export function OfflineBanner() {
  return (
    <div className="offline-banner" role="status">
      <Icon name="i-offline" size={17} strokeWidth={2.5} />
      <span>You are offline. KINDLY will not say a request was delivered until it really has been.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog — focus is trapped, Escape closes, focus returns to the opener
// ---------------------------------------------------------------------------

interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  actions: ReactNode;
  danger?: boolean;
  /** alertdialog for destructive or safety-critical confirmations. */
  alert?: boolean;
}

export function Dialog({ open, title, description, onClose, children, actions, danger, alert }: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement;

    const panel = panelRef.current;
    const focusable = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((el) => !el.hasAttribute('disabled'));

    focusable()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener('keydown', onKey, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        className={`dialog-panel ${danger ? 'dialog-danger' : ''}`}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
      >
        <h2 id={titleId}>{title}</h2>
        {description ? <p id={descId}>{description}</p> : null}
        {children}
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section heading used across the app
// ---------------------------------------------------------------------------

export function SectionTitle({ eyebrow, title, detail, action, split }: {
  eyebrow?: string; title: string; detail?: string; action?: ReactNode; split?: boolean;
}) {
  return (
    <div className={`section-title ${split ? 'split' : ''}`}>
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h2>{title}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** A destination that genuinely is not built yet. Never a fake button. */
export function ComingLater({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="state-block">
      <span className="state-icon"><Icon name="i-clock-3" size={24} /></span>
      <h3>{title}</h3>
      <p>{detail}</p>
      <p><b>Coming later.</b> This is not a button — nothing here can be selected yet.</p>
    </div>
  );
}
