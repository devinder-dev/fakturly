// AdminInvoicesPage.tsx — admin: every invoice.

import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api.ts'
import type { InvoiceListResponse, ClientListResponse, InvoiceStatus } from '../../lib/types.ts'
import {
  Button,
  Card,
  PageHeader,
  Spinner,
  ErrorMessage,
  EmptyState,
  StatusBadge,
  formatDate,
  formatOre
} from '../../components/ui.tsx'

const STATUSES: Array<{ value: InvoiceStatus | ''; label: string }> = [
  { value: '', label: 'Alla' },
  { value: 'DRAFT', label: 'Utkast' },
  { value: 'SENT', label: 'Skickade' },
  { value: 'OVERDUE', label: 'Förfallna' },
  { value: 'PAID', label: 'Betalda' }
]

export function AdminInvoicesPage() {
  /**
   * Filters live in the URL, not in component state. A filtered list can
   * then be linked to — the dashboard's "largest debtors" does exactly that —
   * and survives a page refresh.
   */
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get('status') ?? ''
  const clientId = searchParams.get('clientId') ?? ''

  const query = new URLSearchParams({ limit: '100' })
  if (status) query.set('status', status)
  if (clientId) query.set('clientId', clientId)

  const invoices = useQuery({
    queryKey: ['invoices', { status, clientId }],
    queryFn: () => api.get<InvoiceListResponse>(`/invoices?${query.toString()}`)
  })

  function setFilter(key: 'status' | 'clientId', value: string) {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    setSearchParams(next, { replace: true })
  }

  // Fetched separately so the table can show client names rather than ids.
  // The invoice endpoint returns clientId only — it does not embed the
  // client, and adding that server-side would mean every invoice response
  // carrying data most callers do not need.
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<ClientListResponse>('/clients?limit=100')
  })

  const clientName = (clientId: string) =>
    clients.data?.clients.find((client) => client.id === clientId)?.name ?? '—'

  return (
    <>
      <PageHeader
        title="Fakturor"
        action={
          <Link to="/invoices/new">
            <Button>Ny faktura</Button>
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {STATUSES.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter('status', option.value)}
            className={
              'rounded-full px-3 py-1 text-sm transition-colors ' +
              (status === option.value
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50')
            }
          >
            {option.label}
          </button>
        ))}

        <select
          aria-label="Kund"
          value={clientId}
          onChange={(event) => setFilter('clientId', event.target.value)}
          className="ml-auto rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">Alla kunder</option>
          {clients.data?.clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </div>

      {invoices.isLoading && <Spinner />}
      {invoices.error && <ErrorMessage error={invoices.error} />}

      {invoices.data && (
        <Card>
          {invoices.data.invoices.length === 0 ? (
            <EmptyState
              title={status || clientId ? 'Inga fakturor matchar' : 'Inga fakturor ännu'}
              description={
                status || clientId
                  ? 'Prova ett annat filter.'
                  : 'Skapa din första faktura för en av dina kunder.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-6 py-3 font-medium">Nummer</th>
                    <th className="px-6 py-3 font-medium">Kund</th>
                    <th className="px-6 py-3 font-medium">Förfaller</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    {/* Money right-aligned, so the decimal points line up. */}
                    <th className="px-6 py-3 text-right font-medium">Belopp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invoices.data.invoices.map((invoice) => (
                    <tr key={invoice.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4">
                        <Link
                          to={`/invoices/${invoice.id}`}
                          className="font-medium text-brand-600 hover:underline"
                        >
                          {invoice.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        {clientName(invoice.clientId)}
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        {formatDate(invoice.dueDate)}
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge status={invoice.status} />
                      </td>
                      <td className="tabular px-6 py-4 text-right font-medium text-slate-900">
                        {invoice.formatted.grossTotal}
                        {invoice.lateFeeOre > 0 && (
                          <span className="block text-xs font-normal text-red-600">
                            varav ränta{' '}
                            {/* Shown separately so the customer can see why the
                                figure grew, rather than a number that changed. */}
                            {formatOre(invoice.lateFeeOre, invoice.currency)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  )
}
