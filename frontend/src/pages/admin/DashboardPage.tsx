// DashboardPage.tsx — admin: the state of the business on one screen.
//
// Every figure comes from GET /dashboard, which sums the ledger server-side.
// Nothing is added up here: a frontend that computes its own totals from a
// page of invoices is wrong the moment there is a second page.

import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api.ts'
import type { Dashboard, InvoiceListResponse } from '../../lib/types.ts'
import { Card, PageHeader, Spinner, ErrorMessage, formatDate, formatOre } from '../../components/ui.tsx'
import { BarChart } from '../../components/BarChart.tsx'

export function DashboardPage() {
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<{ dashboard: Dashboard }>('/dashboard')
  })

  // The overdue list is the same endpoint the invoice page uses, filtered.
  // The dashboard endpoint returns totals, not rows — keeping "which
  // invoices" in one place means one ownership rule and one pagination.
  const overdue = useQuery({
    queryKey: ['invoices', { status: 'OVERDUE' }],
    queryFn: () => api.get<InvoiceListResponse>('/invoices?status=OVERDUE&limit=10')
  })

  if (dashboard.isLoading) return <Spinner />
  if (dashboard.error) return <ErrorMessage error={dashboard.error} />
  if (!dashboard.data) return null

  const d = dashboard.data.dashboard

  return (
    <>
      <PageHeader title="Översikt" />

      {/* ── Stat tiles ──────────────────────────────────────── */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Utestående"
          value={d.formatted.outstanding}
          detail={`${d.outstanding.count} obetald${d.outstanding.count === 1 ? ' faktura' : 'a fakturor'}`}
        />
        <Stat
          label="Förfallet"
          value={d.formatted.overdue}
          detail={`${d.overdue.count} förfall${d.overdue.count === 1 ? 'en faktura' : 'na fakturor'}`}
          tone={d.overdue.count > 0 ? 'warning' : 'neutral'}
        />
        <Stat label="Fakturerat denna månad" value={d.formatted.invoicedThisMonth} />
        <Stat label="Inbetalt denna månad" value={d.formatted.receivedThisMonth} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-6 lg:col-span-2">
          <BarChart months={d.months} title="Senaste tolv månaderna" />
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-slate-500">
            Största fordringar
          </h2>
          {d.topClients.length === 0 ? (
            <p className="text-sm text-slate-500">Inga utestående fakturor.</p>
          ) : (
            <ol className="space-y-3">
              {d.topClients.map((client) => (
                <li key={client.clientId} className="flex items-baseline justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <Link
                      to={`/invoices?clientId=${client.clientId}`}
                      className="block truncate font-medium text-slate-900 hover:underline"
                    >
                      {client.name}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {client.invoiceCount} faktur{client.invoiceCount === 1 ? 'a' : 'or'}
                    </p>
                  </div>
                  <span className="tabular shrink-0 text-slate-900">
                    {formatOre(client.outstandingOre)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      {/* ── Overdue ─────────────────────────────────────────── */}
      <Card className="mt-6">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            Förfallna fakturor
          </h2>
          <Link to="/invoices" className="text-sm font-medium text-brand-600 hover:underline">
            Alla fakturor
          </Link>
        </div>

        {overdue.isLoading && <Spinner />}
        {overdue.error && <div className="p-6"><ErrorMessage error={overdue.error} /></div>}

        {overdue.data && overdue.data.invoices.length === 0 && (
          <p className="px-6 py-8 text-center text-sm text-slate-500">
            Inget förfallet. Bra läge.
          </p>
        )}

        {overdue.data && overdue.data.invoices.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3 font-medium">Nummer</th>
                  <th className="px-6 py-3 font-medium">Förföll</th>
                  <th className="px-6 py-3 text-right font-medium">Varav ränta</th>
                  <th className="px-6 py-3 text-right font-medium">Att betala</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overdue.data.invoices.map((invoice) => (
                  <tr key={invoice.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3">
                      <Link to={`/invoices/${invoice.id}`} className="font-medium text-brand-600 hover:underline">
                        {invoice.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-slate-600">{formatDate(invoice.dueDate)}</td>
                    <td className="tabular px-6 py-3 text-right text-red-700">
                      {formatOre(invoice.lateFeeOre)}
                    </td>
                    <td className="tabular px-6 py-3 text-right font-medium text-slate-900">
                      {formatOre(invoice.grossTotalOre + invoice.lateFeeOre)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

/**
 * A stat tile. The value is the largest thing on the screen; the label is
 * small and above it, the way a finance report is read: number first,
 * then what it means.
 */
function Stat({
  label,
  value,
  detail,
  tone = 'neutral'
}: {
  label: string
  value: string
  detail?: string
  tone?: 'neutral' | 'warning'
}) {
  return (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={`tabular mt-2 text-2xl font-semibold ${tone === 'warning' ? 'text-red-700' : 'text-slate-900'}`}
      >
        {value}
      </p>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </Card>
  )
}
