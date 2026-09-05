// AuditLogPage.tsx — admin: the revision log.
//
// Read-only by construction: the API has no endpoint that writes or deletes
// an entry, so there is nothing this page could offer even if it wanted to.

import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api.ts'
import type { AuditLogResponse } from '../../lib/types.ts'
import { Button, Card, PageHeader, Spinner, ErrorMessage } from '../../components/ui.tsx'

const PAGE_SIZE = 50

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'medium' })

/** Actions that are security signals, worth a colour. Everything else is routine. */
const HIGHLIGHT: Record<string, string> = {
  LOGIN_FAILED: 'text-amber-800',
  LOGIN_BLOCKED_RATE_LIMIT: 'text-red-700',
  TOKEN_THEFT_DETECTED: 'text-red-700 font-semibold',
  CREDIT_NOTE_ISSUED: 'text-violet-800',
  PAYMENT_RECEIVED: 'text-green-700'
}

export function AuditLogPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const action = searchParams.get('action') ?? ''
  const page = Number(searchParams.get('page') ?? '0')

  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
  if (action) query.set('action', action)

  const log = useQuery({
    queryKey: ['audit', { action, page }],
    queryFn: () => api.get<AuditLogResponse>(`/audit-log?${query.toString()}`)
  })

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setSearchParams(next, { replace: true })
  }

  const total = log.data?.pagination.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)

  return (
    <>
      <PageHeader
        title="Revisionslogg"
        action={
          <select
            aria-label="Händelse"
            value={action}
            onChange={(event) => update({ action: event.target.value, page: '' })}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">Alla händelser</option>
            {log.data?.actions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        }
      />

      <p className="mb-4 text-sm text-slate-500">
        Varje säkerhetsrelevant händelse, skriven i en egen transaktion så att den överlever
        en rollback. Raderna kan inte ändras eller tas bort — inte heller av en administratör.
      </p>

      <Card>
        {log.isLoading && <Spinner />}
        {log.error && <div className="p-6"><ErrorMessage error={log.error} /></div>}

        {log.data && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-6 py-3 font-medium">Tidpunkt</th>
                    <th className="px-6 py-3 font-medium">Händelse</th>
                    <th className="px-6 py-3 font-medium">Vem</th>
                    <th className="px-6 py-3 font-medium">Resurs</th>
                    <th className="px-6 py-3 font-medium">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {log.data.entries.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                        Inga händelser.
                      </td>
                    </tr>
                  )}
                  {log.data.entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-6 py-2.5 text-slate-500">
                        {formatDateTime(entry.createdAt)}
                      </td>
                      <td className={`px-6 py-2.5 font-mono text-xs ${HIGHLIGHT[entry.action] ?? 'text-slate-900'}`}>
                        {entry.action}
                      </td>
                      <td className="px-6 py-2.5 text-slate-700">
                        {entry.actorEmail ?? entry.email ?? <span className="text-slate-400">systemet</span>}
                      </td>
                      <td className="px-6 py-2.5 text-slate-500">
                        {entry.resource}
                        {entry.resourceId && (
                          <span className="ml-1 font-mono text-xs text-slate-400">{entry.resourceId.slice(-8)}</span>
                        )}
                      </td>
                      <td className="px-6 py-2.5 font-mono text-xs text-slate-400">{entry.ipAddress ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 px-6 py-3 text-sm text-slate-500">
              <span>
                {total} händelse{total === 1 ? '' : 'r'}
                {total > PAGE_SIZE && ` · sida ${page + 1} av ${lastPage + 1}`}
              </span>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page === 0} onClick={() => update({ page: String(page - 1) })}>
                  Nyare
                </Button>
                <Button variant="secondary" disabled={page >= lastPage} onClick={() => update({ page: String(page + 1) })}>
                  Äldre
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  )
}
