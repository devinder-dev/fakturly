// ui.tsx — the small set of components the whole app is built from.
//
// Hand-written rather than pulled from a library, so every one is explainable.
// Kept in a single file because there are few enough that splitting them into
// a directory of one-export files would be filing, not structure.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import type { Invoice, InvoiceStatus, LedgerType } from '../lib/types.ts'

// ─────────────────────────────────────────────────────────────

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger'
  isLoading?: boolean
}

export function Button({
  variant = 'primary',
  isLoading = false,
  disabled,
  children,
  className = '',
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm ' +
    'font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2'

  const variants = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700',
    secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700'
  }

  return (
    <button
      // Disabled while loading, so a double-click cannot send a second
      // request. On "send invoice" that would be a real problem — the second
      // is refused by the API, but the user sees an error for an action that
      // actually succeeded.
      disabled={disabled || isLoading}
      className={`${base} ${variants[variant]} ${className}`}
      {...props}
    >
      {isLoading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  error?: string | undefined
  hint?: string | undefined
}

export function Field({ label, error, hint, id, className = '', ...props }: FieldProps) {
  const inputId = id ?? props.name ?? label
  const errorId = `${inputId}-error`
  const hintId = `${inputId}-hint`

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
        {label}
      </label>

      <input
        id={inputId}
        // Tells a screen reader the field is invalid, and points it at the
        // message. A red border alone conveys nothing to anyone not looking
        // at it — and nothing at all to someone who cannot distinguish red.
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className={
          'w-full rounded-md border px-3 py-2 text-sm text-slate-900 ' +
          'placeholder:text-slate-400 focus:outline-none focus:ring-2 ' +
          (error
            ? 'border-red-400 focus:ring-red-400 '
            : 'border-slate-300 focus:ring-brand-500 ') +
          className
        }
        {...props}
      />

      {error ? (
        <p id={errorId} className="text-sm text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-slate-200 bg-white ${className}`}>{children}</div>
  )
}

export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-between gap-4">
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      {action}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

/**
 * Invoice status.
 *
 * Colour AND text, never colour alone. A red dot means nothing to a
 * colour-blind reader, and roughly 8% of men are.
 */
export function StatusBadge({ status, type = 'INVOICE' }: { status: InvoiceStatus; type?: Invoice['type'] }) {
  const styles: Record<InvoiceStatus, { label: string; className: string }> = {
    DRAFT: { label: 'Utkast', className: 'bg-slate-100 text-slate-700' },
    SENT: { label: 'Skickad', className: 'bg-blue-100 text-blue-800' },
    PAID: { label: 'Betald', className: 'bg-green-100 text-green-800' },
    OVERDUE: { label: 'Förfallen', className: 'bg-red-100 text-red-800' },
    CREDITED: { label: 'Krediterad', className: 'bg-amber-100 text-amber-900' }
  }

  // A credit note is "sent" in the database but that word means nothing to
  // a reader; the document kind is what matters.
  const { label, className } =
    type === 'CREDIT_NOTE'
      ? { label: 'Kreditfaktura', className: 'bg-violet-100 text-violet-900' }
      : styles[status]

  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────

/** A failed request, shown with the requestId so it can be traced in the log. */
export function ErrorMessage({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'Något gick fel'
  const requestId = (error as { requestId?: string }).requestId

  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-4" role="alert">
      <p className="text-sm text-red-800">{message}</p>
      {requestId && (
        <p className="mt-1 font-mono text-xs text-red-600">Referens: {requestId}</p>
      )}
    </div>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
    </div>
  )
}

export function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div
        className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"
        role="status"
        aria-label="Laddar"
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

/**
 * Formats öre for display.
 *
 * Mirrors the backend's formatOre, including the NON-BREAKING space, so a
 * value the API formatted and one the frontend formatted look identical.
 * The API sends both the öre and a formatted string; this is for the cases
 * where we compute a total client-side.
 */
const NBSP = ' '

export function formatOre(ore: number, currency = 'SEK'): string {
  const sign = ore < 0 ? '-' : ''
  const absolute = Math.abs(ore)
  const whole = Math.floor(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, '0')
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)

  return `${sign}${grouped},${fraction}${NBSP}${currency}`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('sv-SE')
}

// ─────────────────────────────────────────────────────────────

/** Human labels for the ledger. The type is the truth; the label is for reading. */
export const LEDGER_LABELS: Record<LedgerType, string> = {
  INVOICE_CREATED: 'Faktura utfärdad',
  PAYMENT_RECEIVED: 'Betalning mottagen',
  LATE_FEE_ADDED: 'Dröjsmålsränta',
  REMINDER_FEE_ADDED: 'Påminnelseavgift',
  CREDIT_NOTE_ISSUED: 'Krediterad',
  LATE_FEE_WAIVED: 'Ränta avskriven',
  REMINDER_FEE_WAIVED: 'Avgift avskriven',
  REFUND: 'Återbetalning',
  ADJUSTMENT: 'Justering'
}

/**
 * Downloads a file the API produced, with the access token attached.
 *
 * Same reason as the PDF: a plain link sends no Authorization header. The
 * filename comes from the caller, not from the response — reading
 * Content-Disposition across CORS needs an exposed header, and the caller
 * already knows what it asked for.
 */
export async function downloadFromApi(
  fetchBlob: (path: string) => Promise<Blob>,
  path: string,
  filename: string
): Promise<void> {
  const blob = await fetchBlob(path)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke after the click has been handled, or Safari downloads nothing.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
