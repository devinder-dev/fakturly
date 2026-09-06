// ReportsPage.tsx — admin: the three reports an accountant asks for.
//
// Every figure is computed by the API. This page picks parameters, shows the
// result, and offers the same report as a file. The CSV and SIE downloads go
// through the authenticated fetch, because a plain link carries no token.

import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api.ts'
import type { AgingReport, VatReport } from '../../lib/types.ts'
import {
  Button,
  Card,
  PageHeader,
  Spinner,
  ErrorMessage,
  formatDate,
  formatOre,
  downloadFromApi
} from '../../components/ui.tsx'

type Tab = 'aging' | 'vat' | 'sie'

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>('aging')

  return (
    <>
      <PageHeader title="Rapporter" subtitle="Det en revisor ber om: kundreskontra, momsrapport och SIE-fil." />

      <div className="mb-6 flex gap-2">
        {(
          [
            ['aging', 'Kundreskontra'],
            ['vat', 'Momsrapport'],
            ['sie', 'SIE-export']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              'rounded-full px-4 py-1.5 text-sm transition-colors ' +
              (tab === key
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50')
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'aging' && <Aging />}
      {tab === 'vat' && <Vat />}
      {tab === 'sie' && <Sie />}
    </>
  )
}

// ─────────────────────────────────────────────────────────────

function Aging() {
  const [asOf, setAsOf] = useState(today())

  const report = useQuery({
    queryKey: ['reports', 'aging', asOf],
    queryFn: () => api.get<{ report: AgingReport }>(`/reports/aging?asOf=${asOf}`)
  })

  const download = useMutation({
    mutationFn: () =>
      downloadFromApi(api.getBlob, `/reports/aging?asOf=${asOf}&format=csv`, `kundreskontra-${asOf}.csv`)
  })

  return (
    <Card>
      <Toolbar
        title="Kundreskontra"
        description="Vem som är skyldig vad, och hur länge det varit förfallet. Ränta och avgifter ingår i beloppen."
        controls={
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Per den
            <input
              type="date"
              value={asOf}
              onChange={(event) => setAsOf(event.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
        }
        onDownload={() => download.mutate()}
        downloading={download.isPending}
      />

      {report.isLoading && <Spinner />}
      {report.error && <div className="p-6"><ErrorMessage error={report.error} /></div>}
      {download.error && <div className="p-6"><ErrorMessage error={download.error} /></div>}

      {report.data && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-3 font-medium">Kund</th>
                <th className="px-6 py-3 font-medium">Äldsta förfall</th>
                {report.data.report.buckets.map((bucket) => (
                  <th key={bucket.key} className="px-4 py-3 text-right font-medium">
                    {bucket.label}
                  </th>
                ))}
                <th className="px-6 py-3 text-right font-medium">Totalt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.data.report.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-slate-500">
                    Inga utestående fakturor.
                  </td>
                </tr>
              )}
              {report.data.report.rows.map((row) => (
                <tr key={row.clientId} className="hover:bg-slate-50">
                  <td className="px-6 py-3">
                    <Link
                      to={`/invoices?clientId=${row.clientId}`}
                      className="font-medium text-brand-600 hover:underline"
                    >
                      {row.clientName}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {row.invoiceCount} faktur{row.invoiceCount === 1 ? 'a' : 'or'}
                    </p>
                  </td>
                  <td className="px-6 py-3 text-slate-600">{formatDate(row.oldestDueDate)}</td>
                  {report.data!.report.buckets.map((bucket) => (
                    <td
                      key={bucket.key}
                      className={`tabular px-4 py-3 text-right ${
                        row[bucket.key] === 0
                          ? 'text-slate-300'
                          : bucket.key === 'over90' || bucket.key === 'days61to90'
                            ? 'text-red-700'
                            : 'text-slate-900'
                      }`}
                    >
                      {row[bucket.key] === 0 ? '–' : formatOre(row[bucket.key], '').trim()}
                    </td>
                  ))}
                  <td className="tabular px-6 py-3 text-right font-medium text-slate-900">
                    {formatOre(row.totalOre)}
                  </td>
                </tr>
              ))}
            </tbody>
            {report.data.report.rows.length > 0 && (
              <tfoot className="border-t border-slate-200 bg-slate-50 font-semibold">
                <tr>
                  <td className="px-6 py-3" colSpan={2}>Summa</td>
                  {report.data.report.buckets.map((bucket) => (
                    <td key={bucket.key} className="tabular px-4 py-3 text-right">
                      {formatOre(report.data!.report.totals[bucket.key], '').trim()}
                    </td>
                  ))}
                  <td className="tabular px-6 py-3 text-right">{report.data.report.formatted.total}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────

function Vat() {
  const [from, setFrom] = useState(startOfQuarter())
  const [to, setTo] = useState(startOfNextQuarter())

  const report = useQuery({
    queryKey: ['reports', 'vat', from, to],
    queryFn: () => api.get<{ report: VatReport }>(`/reports/vat?from=${from}&to=${to}`),
    enabled: from < to
  })

  const download = useMutation({
    mutationFn: () =>
      downloadFromApi(api.getBlob, `/reports/vat?from=${from}&to=${to}&format=csv`, `momsrapport-${from}-${to}.csv`)
  })

  return (
    <Card>
      <Toolbar
        title="Momsrapport"
        description="Beskattningsunderlag och utgående moms per momssats för perioden. Kreditfakturor minskar underlaget. Slutdatumet är exklusivt."
        controls={
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
            <span>till</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
          </div>
        }
        onDownload={() => download.mutate()}
        downloading={download.isPending}
      />

      {report.isLoading && <Spinner />}
      {report.error && <div className="p-6"><ErrorMessage error={report.error} /></div>}

      {report.data && (
        <>
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-3 font-medium">Momssats</th>
                <th className="px-6 py-3 text-right font-medium">Beskattningsunderlag</th>
                <th className="px-6 py-3 text-right font-medium">Utgående moms</th>
                <th className="px-6 py-3 text-right font-medium">Rader</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.data.report.rows.map((row) => (
                <tr key={row.vatRate}>
                  <td className="px-6 py-3 text-slate-900">{row.vatRate / 100} %</td>
                  <td className="tabular px-6 py-3 text-right text-slate-900">{formatOre(row.netOre)}</td>
                  <td className="tabular px-6 py-3 text-right text-slate-900">{formatOre(row.vatOre)}</td>
                  <td className="tabular px-6 py-3 text-right text-slate-500">{row.lineCount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-200 bg-slate-50 font-semibold">
              <tr>
                <td className="px-6 py-3">Summa</td>
                <td className="tabular px-6 py-3 text-right">{report.data.report.formatted.net}</td>
                <td className="tabular px-6 py-3 text-right">{report.data.report.formatted.vat}</td>
                <td className="px-6 py-3 text-right text-slate-500">
                  {report.data.report.documentCount} dokument
                </td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────

function Sie() {
  const [year, setYear] = useState(new Date().getFullYear())

  const download = useMutation({
    mutationFn: () => downloadFromApi(api.getBlob, `/reports/sie?year=${year}`, `fakturly-${year}.se`)
  })

  return (
    <Card className="p-6">
      <h2 className="text-lg font-medium text-slate-900">SIE 4-export</h2>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Hela huvudboken för ett räkenskapsår som verifikationer, i det filformat Fortnox, Visma,
        Bokio och revisorns program läser in. Varje faktura blir en verifikation med
        kundfordran mot försäljning och utgående moms per momssats; varje betalning, ränta
        och avgift blir en egen. Filen är kodad i PC8 (CP437) enligt SIE-standarden.
      </p>

      <div className="mt-6 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Räkenskapsår
          <input
            type="number"
            min={2000}
            max={2100}
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
            className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <Button onClick={() => download.mutate()} isLoading={download.isPending}>
          Ladda ner fakturly-{year}.se
        </Button>
      </div>

      {download.error && <div className="mt-4"><ErrorMessage error={download.error} /></div>}
      {download.isSuccess && (
        <p className="mt-4 text-sm text-green-700">Filen är nedladdad. Exporten är loggad i revisionsloggen.</p>
      )}

      <dl className="mt-8 grid gap-4 text-sm sm:grid-cols-2">
        <Account number="1510" name="Kundfordringar" note="debiteras vid faktura, krediteras vid betalning" />
        <Account number="1930" name="Företagskonto" note="debiteras när pengarna kommer in" />
        <Account number="3001–3004" name="Försäljning per momssats" note="25 %, 12 %, 6 %, momsfri" />
        <Account number="2611–2631" name="Utgående moms per sats" note="det som redovisas till Skatteverket" />
        <Account number="8313" name="Ränteintäkter" note="dröjsmålsränta enligt räntelagen" />
        <Account number="3590" name="Påminnelseavgifter" note="60 kr enligt lag (1981:739)" />
      </dl>
    </Card>
  )
}

function Account({ number, name, note }: { number: string; name: string; note: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 font-mono text-slate-900">{number}</dt>
      <dd>
        <p className="font-medium text-slate-900">{name}</p>
        <p className="text-slate-500">{note}</p>
      </dd>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function Toolbar({
  title,
  description,
  controls,
  onDownload,
  downloading
}: {
  title: string
  description: string
  controls: React.ReactNode
  onDownload: () => void
  downloading: boolean
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <h2 className="text-lg font-medium text-slate-900">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {controls}
        <Button variant="secondary" onClick={onDownload} isLoading={downloading}>
          Ladda ner CSV
        </Button>
      </div>
    </div>
  )
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function startOfQuarter(): string {
  const now = new Date()
  const month = Math.floor(now.getMonth() / 3) * 3
  return new Date(Date.UTC(now.getFullYear(), month, 1)).toISOString().slice(0, 10)
}

function startOfNextQuarter(): string {
  const now = new Date()
  const month = Math.floor(now.getMonth() / 3) * 3 + 3
  return new Date(Date.UTC(now.getFullYear(), month, 1)).toISOString().slice(0, 10)
}
