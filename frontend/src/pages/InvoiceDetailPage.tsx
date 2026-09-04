// InvoiceDetailPage.tsx — one invoice, for either role.
//
// Shared deliberately. The API decides what this caller may see: an admin
// gets any invoice, a client gets only their own, and someone else's returns
// 404 — identical to one that never existed. So the page does not check
// ownership, because it could not be trusted to and does not need to.
//
// The only role-dependent things here are which BUTTONS appear and whether
// the audit trail is shown. Both are conveniences: the API refuses a client
// who calls the endpoints anyway.

import { useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../lib/api.ts'
import { useAuth } from '../lib/auth.tsx'
import type { Invoice, AuditLogResponse } from '../lib/types.ts'
import {
  Button,
  Card,
  PageHeader,
  Spinner,
  ErrorMessage,
  StatusBadge,
  formatDate,
  formatOre,
  LEDGER_LABELS
} from '../components/ui.tsx'

/** An amount without its currency, for table cells where the unit is implied. */
const plain = (ore: number) => formatOre(ore, '').trim()

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })

/**
 * Keyed by the invoice id.
 *
 * React Router reuses the same component instance when only the `:id`
 * changes — going from an invoice to its credit note and back keeps every
 * useState and every mutation result from the previous invoice. `key`
 * forces a fresh instance per id, so a "reminder sent" notice cannot
 * outlive the invoice it was about.
 */
export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  return <InvoiceDetail key={id} id={id} />
}

function InvoiceDetail({ id }: { id: string | undefined }) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirmCredit, setConfirmCredit] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get<{ invoice: Invoice }>(`/invoices/${id}`),
    enabled: Boolean(id)
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['invoice', id] })
    void queryClient.invalidateQueries({ queryKey: ['invoices'] })
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    void queryClient.invalidateQueries({ queryKey: ['audit', id] })
  }

  const send = useMutation({
    mutationFn: () => api.post<{ invoice: Invoice }>(`/invoices/${id}/send`),
    onSuccess: invalidate
  })

  const remind = useMutation({
    mutationFn: () => api.post<{ invoice: Invoice; feeCharged: boolean }>(`/invoices/${id}/reminder`),
    onSuccess: invalidate
  })

  /**
   * A credit note creates a NEW document. On success we go to it — the
   * original is now a closed chapter, and the new number is what the admin
   * will be asked about next.
   */
  const credit = useMutation({
    mutationFn: () =>
      api.post<{ creditNote: Invoice; original: Invoice }>(`/invoices/${id}/credit-note`),
    onSuccess: (result) => {
      invalidate()
      navigate(`/invoices/${result.creditNote.id}`)
    }
  })

  /**
   * The PDF is opened in a new tab from a Blob.
   *
   * window.open must be called synchronously inside the click, or Safari's
   * popup blocker treats a tab opened after an await as unsolicited. So the
   * tab is opened first, blank, and pointed at the PDF once it has arrived.
   */
  const pdf = useMutation({
    mutationFn: async () => {
      const tab = window.open('', '_blank')
      try {
        const blob = await api.getBlob(`/invoices/${id}/pdf`)
        const url = URL.createObjectURL(blob)
        if (tab) tab.location.href = url
        else window.location.href = url
      } catch (error) {
        tab?.close()
        throw error
      }
    }
  })

  const paymentLink = useMutation({
    mutationFn: () => api.post<{ paymentUrl: string }>(`/invoices/${id}/payment-link`),
    onSuccess: (result) => {
      // Opened rather than navigated to, so the admin keeps the invoice open.
      window.open(result.paymentUrl, '_blank', 'noopener,noreferrer')
    }
  })

  if (isLoading) return <Spinner />

  if (error) {
    // A 404 here is also what a client sees for someone else's invoice. The
    // wording avoids implying it exists.
    const notFound = error instanceof ApiError && error.status === 404
    return (
      <>
        <PageHeader title={notFound ? 'Fakturan hittades inte' : 'Kunde inte hämta fakturan'} />
        {!notFound && <ErrorMessage error={error} />}
        <Link to="/invoices" className="text-sm font-medium text-brand-600 hover:underline">
          Tillbaka till fakturor
        </Link>
      </>
    )
  }

  if (!data) return null

  const invoice = data.invoice
  const isAdmin = user?.role === 'ADMIN'
  const isCreditNote = invoice.type === 'CREDIT_NOTE'
  const isOpen = invoice.status === 'SENT' || invoice.status === 'OVERDUE'
  const canAct = isAdmin && !isCreditNote && isOpen

  return (
    <>
      <PageHeader
        title={`${isCreditNote ? 'Kreditfaktura' : 'Faktura'} ${invoice.invoiceNumber}`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={invoice.status} type={invoice.type} />

            <Button variant="secondary" onClick={() => pdf.mutate()} isLoading={pdf.isPending}>
              PDF
            </Button>

            {isAdmin && invoice.status === 'DRAFT' && (
              <Button onClick={() => send.mutate()} isLoading={send.isPending}>
                Skicka faktura
              </Button>
            )}

            {canAct && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => remind.mutate()}
                  isLoading={remind.isPending}
                >
                  {invoice.reminderSentAt ? 'Påminn igen' : 'Skicka påminnelse'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => paymentLink.mutate()}
                  isLoading={paymentLink.isPending}
                >
                  Betallänk
                </Button>
                <Button variant="danger" onClick={() => setConfirmCredit(true)}>
                  Kreditera
                </Button>
              </>
            )}
          </div>
        }
      />

      {send.error && <ErrorMessage error={send.error} />}
      {pdf.error && <ErrorMessage error={pdf.error} />}
      {remind.error && <ErrorMessage error={remind.error} />}
      {credit.error && <ErrorMessage error={credit.error} />}
      {paymentLink.error && <ErrorMessage error={paymentLink.error} />}

      {remind.data && (
        <Notice tone="info">
          Påminnelse skickad.{' '}
          {remind.data.feeCharged
            ? 'Lagstadgad påminnelseavgift 60,00 SEK har lagts till.'
            : 'Avgiften var redan debiterad och läggs inte till igen.'}
        </Notice>
      )}

      {confirmCredit && (
        <Card className="mb-6 border-red-200 p-6">
          <h2 className="font-semibold text-slate-900">Kreditera faktura {invoice.invoiceNumber}?</h2>
          <p className="mt-2 text-sm text-slate-600">
            En skickad faktura kan inte ändras eller raderas. En kreditfaktura är ett nytt
            dokument med nästa nummer i serien som upphäver den här i sin helhet, inklusive
            eventuell ränta och påminnelseavgift. Det går inte att ångra.
          </p>
          <div className="mt-4 flex gap-3">
            <Button variant="danger" onClick={() => credit.mutate()} isLoading={credit.isPending}>
              Ja, skapa kreditfaktura
            </Button>
            <Button variant="secondary" onClick={() => setConfirmCredit(false)}>
              Avbryt
            </Button>
          </div>
        </Card>
      )}

      {invoice.status === 'DRAFT' && (
        <Notice tone="warning">
          Detta är ett utkast. Det har ännu inget bokfört nummer och kan ändras eller raderas.
          När fakturan skickas blir den ett låst underlag.
        </Notice>
      )}

      {isCreditNote && invoice.creditsInvoice && (
        <Notice tone="info">
          Krediterar{' '}
          <Link to={`/invoices/${invoice.creditsInvoice.id}`} className="font-medium underline">
            faktura {invoice.creditsInvoice.invoiceNumber}
          </Link>{' '}
          i sin helhet.
        </Notice>
      )}

      {invoice.status === 'CREDITED' && invoice.creditNotes[0] && (
        <Notice tone="warning">
          Fakturan är krediterad genom{' '}
          <Link to={`/invoices/${invoice.creditNotes[0].id}`} className="font-medium underline">
            kreditfaktura {invoice.creditNotes[0].invoiceNumber}
          </Link>
          . Inget är längre att betala.
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-6 lg:col-span-2">
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-slate-500">
            Rader
          </h2>

          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Beskrivning</th>
                <th className="pb-2 text-right font-medium">Antal</th>
                <th className="pb-2 text-right font-medium">À-pris</th>
                <th className="pb-2 text-right font-medium">Moms</th>
                <th className="pb-2 text-right font-medium">Belopp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoice.items.map((item) => (
                <tr key={item.id}>
                  <td className="py-3 text-slate-900">{item.description}</td>
                  <td className="tabular py-3 text-right text-slate-600">{item.quantity}</td>
                  <td className="tabular py-3 text-right text-slate-600">{plain(item.unitPriceOre)}</td>
                  {/* The rate the line was invoiced at, not today's rate —
                      it is stored per line for exactly this reason. */}
                  <td className="tabular py-3 text-right text-slate-600">{item.vatRate / 100} %</td>
                  <td className="tabular py-3 text-right font-medium text-slate-900">
                    {plain(item.netOre)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="space-y-6">
          <Card className="p-6">
            <dl className="space-y-2 text-sm">
              <Row label="Netto" value={invoice.formatted.netTotal} />
              <Row label="Moms" value={invoice.formatted.vatTotal} />

              {invoice.lateFeeOre > 0 && (
                <Row label="Dröjsmålsränta" value={formatOre(invoice.lateFeeOre, invoice.currency)} tone="danger" />
              )}
              {invoice.reminderFeeOre > 0 && (
                <Row label="Påminnelseavgift" value={formatOre(invoice.reminderFeeOre, invoice.currency)} tone="danger" />
              )}

              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
                <dt className="text-slate-900">
                  {invoice.status === 'PAID'
                    ? 'Betalt'
                    : isCreditNote
                      ? 'Tillgodo'
                      : invoice.status === 'CREDITED'
                        ? 'Krediterat'
                        : 'Att betala'}
                </dt>
                <dd className="tabular text-slate-900">
                  {isCreditNote || invoice.status === 'CREDITED'
                    ? invoice.formatted.grossTotal
                    : invoice.formatted.totalDue}
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="p-6">
            <dl className="space-y-3 text-sm">
              <Row label="Fakturadatum" value={formatDate(invoice.issueDate)} />
              {!isCreditNote && <Row label="Förfallodatum" value={formatDate(invoice.dueDate)} />}
              {invoice.sentAt && <Row label="Skickad" value={formatDate(invoice.sentAt)} />}
              {invoice.reminderSentAt && (
                <Row label="Påmind" value={formatDate(invoice.reminderSentAt)} />
              )}
              {invoice.paidAt && <Row label="Betald" value={formatDate(invoice.paidAt)} />}
            </dl>
          </Card>
        </div>
      </div>

      {/* ── The ledger ──────────────────────────────────────── */}
      {invoice.ledger.length > 0 && (
        <Card className="mt-6">
          <div className="border-b border-slate-200 px-6 py-4">
            <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">Huvudbok</h2>
            <p className="mt-1 text-xs text-slate-500">
              Varje händelse är en egen rad som aldrig ändras. Summan av raderna är vad som
              är utestående.
            </p>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {invoice.ledger.map((row) => (
                <tr key={row.id}>
                  <td className="px-6 py-3 text-slate-500">{formatDateTime(row.createdAt)}</td>
                  <td className="px-6 py-3">
                    <p className="font-medium text-slate-900">{LEDGER_LABELS[row.type] ?? row.type}</p>
                    <p className="text-xs text-slate-500">{row.description}</p>
                  </td>
                  <td
                    className={`tabular px-6 py-3 text-right font-medium ${
                      row.type === 'PAYMENT_RECEIVED'
                        ? 'text-green-700'
                        : row.amountOre < 0
                          ? 'text-amber-800'
                          : 'text-slate-900'
                    }`}
                  >
                    {/* A payment is stored positive (money that arrived) but
                        REDUCES what is owed, so it is shown with a minus. */}
                    {row.type === 'PAYMENT_RECEIVED' ? '−' : ''}
                    {formatOre(row.amountOre, invoice.currency)}
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50">
                <td className="px-6 py-3" />
                <td className="px-6 py-3 font-semibold text-slate-900">Utestående enligt huvudboken</td>
                <td className="tabular px-6 py-3 text-right font-semibold text-slate-900">
                  {formatOre(ledgerBalance(invoice), invoice.currency)}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      {isAdmin && id && <AuditTrail invoiceId={id} />}

      <Link
        to="/invoices"
        className="mt-6 inline-block text-sm font-medium text-brand-600 hover:underline"
      >
        Tillbaka till fakturor
      </Link>
    </>
  )
}

/**
 * Charges minus receipts. Charges are the positive rows and the write-offs
 * are negative; a payment is recorded positive but REDUCES the balance, so
 * it is subtracted. For a paid invoice this is zero, which is the check.
 */
function ledgerBalance(invoice: Invoice): number {
  return invoice.ledger.reduce(
    (balance, row) => balance + (row.type === 'PAYMENT_RECEIVED' ? -row.amountOre : row.amountOre),
    0
  )
}

/** Everything the audit log recorded about this invoice. Admin only. */
function AuditTrail({ invoiceId }: { invoiceId: string }) {
  const trail = useQuery({
    queryKey: ['audit', invoiceId],
    queryFn: () => api.get<AuditLogResponse>(`/audit-log?resourceId=${invoiceId}&limit=50`)
  })

  if (!trail.data || trail.data.entries.length === 0) return null

  return (
    <Card className="mt-6">
      <div className="border-b border-slate-200 px-6 py-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">Händelser</h2>
        <p className="mt-1 text-xs text-slate-500">
          Revisionsloggen: vem gjorde vad, när och varifrån.
        </p>
      </div>
      <ul className="divide-y divide-slate-100 text-sm">
        {trail.data.entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-6 py-3">
            <span className="w-32 shrink-0 text-slate-500">{formatDateTime(entry.createdAt)}</span>
            <span className="font-mono text-xs text-slate-900">{entry.action}</span>
            <span className="text-slate-600">{entry.actorEmail ?? 'systemet'}</span>
            {entry.ipAddress && <span className="font-mono text-xs text-slate-400">{entry.ipAddress}</span>}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  const color = tone === 'danger' ? 'text-red-700' : ''
  return (
    <div className={`flex justify-between ${color}`}>
      <dt className={tone ? '' : 'text-slate-600'}>{label}</dt>
      <dd className={`tabular ${tone ? '' : 'text-slate-900'}`}>{value}</dd>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'info' | 'warning'; children: React.ReactNode }) {
  const styles =
    tone === 'warning'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-blue-200 bg-blue-50 text-blue-900'
  return (
    <div className={`mb-6 rounded-md border p-4 text-sm ${styles}`} role="status">
      {children}
    </div>
  )
}
