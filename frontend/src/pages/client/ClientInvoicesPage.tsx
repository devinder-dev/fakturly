// ClientInvoicesPage.tsx — the customer's own invoices.
//
// Calls exactly the same endpoint the admin list does: GET /invoices.
//
// There is no filter here, and no clientId in the request. The API scopes the
// QUERY by the caller's role, so a client's rows are the only ones ever
// loaded. Filtering client-side would mean another customer's invoices had
// already been sent to this browser — and one forgotten filter later, shown.

import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api.ts'
import type { InvoiceListResponse } from '../../lib/types.ts'
import {
  Card,
  PageHeader,
  Spinner,
  ErrorMessage,
  EmptyState,
  StatusBadge,
  formatDate,
  formatOre
} from '../../components/ui.tsx'

export function ClientInvoicesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => api.get<InvoiceListResponse>('/invoices?limit=100')
  })

  // A credit note is also SENT, with a negative total; it is not something
  // to pay. What is owed is the API's totalDueOre per open invoice.
  const unpaid =
    data?.invoices.filter(
      (invoice) =>
        invoice.type === 'INVOICE' && (invoice.status === 'SENT' || invoice.status === 'OVERDUE')
    ) ?? []

  const outstandingOre = unpaid.reduce((total, invoice) => total + invoice.totalDueOre, 0)

  return (
    <>
      <PageHeader title="Mina fakturor" subtitle="Dina fakturor, med status och vad som är kvar att betala." />

      {isLoading && <Spinner />}
      {error && <ErrorMessage error={error} />}

      {data && unpaid.length > 0 && (
        <Card className="mb-6 p-6">
          <p className="text-sm text-slate-600">Att betala</p>
          <p className="tabular mt-1 text-3xl font-semibold text-slate-900">
            {formatOre(outstandingOre)}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {unpaid.length} obetald{unpaid.length === 1 ? ' faktura' : 'a fakturor'}
          </p>
        </Card>
      )}

      {data && (
        <Card>
          {data.invoices.length === 0 ? (
            <EmptyState
              title="Inga fakturor"
              description="Här visas dina fakturor när de skickas."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-6 py-3 font-medium">Nummer</th>
                    <th className="px-6 py-3 font-medium">Förfaller</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 text-right font-medium">Belopp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.invoices.map((invoice) => (
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
                        {formatDate(invoice.dueDate)}
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge status={invoice.status} type={invoice.type} />
                      </td>
                      <td className="tabular px-6 py-4 text-right font-medium text-slate-900">
                        {invoice.formatted.totalDue}
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
