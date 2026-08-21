// InvoiceDetailPage.tsx — one invoice, for either role.
//
// Shared deliberately. The API decides what this caller may see: an admin
// gets any invoice, a client gets only their own, and someone else's returns
// 404 — identical to one that never existed. So the page does not check
// ownership, because it could not be trusted to and does not need to.
//
// The only role-dependent thing here is which BUTTONS appear, and those are
// a convenience: the API refuses a client who calls the endpoints anyway.

import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../lib/api.ts'
import { useAuth } from '../lib/auth.tsx'
import type { Invoice } from '../lib/types.ts'
import {
  Button,
  Card,
  PageHeader,
  Spinner,
  ErrorMessage,
  StatusBadge,
  formatDate
} from '../components/ui.tsx'

export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get<{ invoice: Invoice }>(`/invoices/${id}`),
    enabled: Boolean(id)
  })

  const send = useMutation({
    mutationFn: () => api.post<{ invoice: Invoice }>(`/invoices/${id}/send`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoice', id] })
      void queryClient.invalidateQueries({ queryKey: ['invoices'] })
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
  const totalDueOre = invoice.grossTotalOre + invoice.lateFeeOre

  return (
    <>
      <PageHeader
        title={`Faktura ${invoice.invoiceNumber}`}
        action={
          <div className="flex items-center gap-3">
            <StatusBadge status={invoice.status} />

            {isAdmin && invoice.status === 'DRAFT' && (
              <Button onClick={() => send.mutate()} isLoading={send.isPending}>
                Skicka faktura
              </Button>
            )}

            {isAdmin && (invoice.status === 'SENT' || invoice.status === 'OVERDUE') && (
              <Button
                variant="secondary"
                onClick={() => paymentLink.mutate()}
                isLoading={paymentLink.isPending}
              >
                Betallänk
              </Button>
            )}
          </div>
        }
      />

      {send.error && <ErrorMessage error={send.error} />}
      {paymentLink.error && <ErrorMessage error={paymentLink.error} />}

      {invoice.status === 'DRAFT' && (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            Detta är ett utkast. Det har ännu inget bokfört nummer och kan ändras eller
            raderas. När fakturan skickas blir den ett låst underlag.
          </p>
        </div>
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
                  <td className="tabular py-3 text-right text-slate-600">
                    {(item.unitPriceOre / 100).toFixed(2).replace('.', ',')}
                  </td>
                  {/* The rate the line was invoiced at, not today's rate —
                      it is stored per line for exactly this reason. */}
                  <td className="tabular py-3 text-right text-slate-600">
                    {item.vatRate / 100} %
                  </td>
                  <td className="tabular py-3 text-right font-medium text-slate-900">
                    {(item.netOre / 100).toFixed(2).replace('.', ',')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="space-y-6">
          <Card className="p-6">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-600">Netto</dt>
                <dd className="tabular text-slate-900">{invoice.formatted.netTotal}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">Moms</dt>
                <dd className="tabular text-slate-900">{invoice.formatted.vatTotal}</dd>
              </div>

              {invoice.lateFeeOre > 0 && (
                <div className="flex justify-between text-red-700">
                  <dt>Dröjsmålsränta</dt>
                  <dd className="tabular">
                    {(invoice.lateFeeOre / 100).toFixed(2).replace('.', ',')} SEK
                  </dd>
                </div>
              )}

              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
                <dt className="text-slate-900">Att betala</dt>
                <dd className="tabular text-slate-900">
                  {(totalDueOre / 100).toFixed(2).replace('.', ',')} SEK
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="p-6">
            <dl className="space-y-3 text-sm">
              <Row label="Fakturadatum" value={formatDate(invoice.issueDate)} />
              <Row label="Förfallodatum" value={formatDate(invoice.dueDate)} />
              {invoice.sentAt && <Row label="Skickad" value={formatDate(invoice.sentAt)} />}
              {invoice.paidAt && <Row label="Betald" value={formatDate(invoice.paidAt)} />}
            </dl>
          </Card>
        </div>
      </div>

      <Link
        to="/invoices"
        className="mt-6 inline-block text-sm font-medium text-brand-600 hover:underline"
      >
        Tillbaka till fakturor
      </Link>
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-600">{label}</dt>
      <dd className="text-slate-900">{value}</dd>
    </div>
  )
}
