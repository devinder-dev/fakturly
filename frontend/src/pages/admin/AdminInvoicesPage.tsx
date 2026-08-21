// AdminInvoicesPage.tsx — admin: every invoice.

import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api.ts'
import type { InvoiceListResponse, ClientListResponse } from '../../lib/types.ts'
import {
  Button,
  Card,
  PageHeader,
  Spinner,
  ErrorMessage,
  EmptyState,
  StatusBadge,
  formatDate
} from '../../components/ui.tsx'

export function AdminInvoicesPage() {
  const invoices = useQuery({
    queryKey: ['invoices'],
    queryFn: () => api.get<InvoiceListResponse>('/invoices?limit=100')
  })

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

      {invoices.isLoading && <Spinner />}
      {invoices.error && <ErrorMessage error={invoices.error} />}

      {invoices.data && (
        <Card>
          {invoices.data.invoices.length === 0 ? (
            <EmptyState
              title="Inga fakturor ännu"
              description="Skapa din första faktura för en av dina kunder."
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
                            {(invoice.lateFeeOre / 100).toFixed(2).replace('.', ',')} SEK
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
