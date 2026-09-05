// NewInvoicePage.tsx — admin: write an invoice.
//
// The one screen where money is entered by hand, so the input rules matter.
//
// The user types kronor. We send öre. That conversion happens in exactly one
// place (toOre below) and is the only arithmetic on this page — the totals
// shown are computed for PREVIEW only, and the API recalculates everything
// from the line items. If the preview and the created invoice ever disagree,
// the API is right.

import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api.ts'
import type { ClientListResponse, Invoice } from '../../lib/types.ts'
import {
  Button,
  Card,
  Field,
  PageHeader,
  ErrorMessage,
  formatOre
} from '../../components/ui.tsx'

/** The rates the backend accepts. Anything else is rejected server-side. */
const VAT_RATES = [
  { value: 2500, label: '25 % — standard' },
  { value: 1200, label: '12 % — livsmedel, hotell' },
  { value: 600, label: '6 % — böcker, transport' },
  { value: 0, label: '0 % — momsfritt' }
]

type LineDraft = {
  description: string
  quantity: string
  /** Kronor, as typed. Converted to öre on submit. */
  unitPrice: string
  vatRate: number
}

const emptyLine = (): LineDraft => ({
  description: '',
  quantity: '1',
  unitPrice: '',
  vatRate: 2500
})

/**
 * Kronor as typed -> integer öre.
 *
 * Accepts a comma, because a Swedish keyboard produces one and telling the
 * user their decimal separator is wrong is a poor experience.
 *
 * Math.round, not truncation: "10.999" typed into a price field means the
 * user meant 11 kronor, and silently dropping the last öre is exactly the
 * kind of quiet loss the whole öre design exists to prevent.
 */
function toOre(input: string): number {
  const normalised = input.replace(',', '.').trim()
  const kronor = Number.parseFloat(normalised)
  if (!Number.isFinite(kronor)) return 0
  return Math.round(kronor * 100)
}

export function NewInvoicePage() {
  const navigate = useNavigate()

  const [clientId, setClientId] = useState('')
  const [dueDate, setDueDate] = useState(defaultDueDate())
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()])

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<ClientListResponse>('/clients?limit=100')
  })

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ invoice: Invoice }>('/invoices', {
        clientId,
        dueDate: new Date(dueDate).toISOString(),
        items: lines.map((line) => ({
          description: line.description,
          quantity: Number.parseInt(line.quantity, 10) || 0,
          unitPriceOre: toOre(line.unitPrice),
          vatRate: line.vatRate
        }))
        // No totals sent. They are derived server-side from these items —
        // sending grossTotalOre would be ignored, and rightly so.
      }),
    onSuccess: (data) => navigate(`/invoices/${data.invoice.id}`)
  })

  // Preview only. Mirrors the backend: round VAT per line, then sum.
  const preview = lines.reduce(
    (totals, line) => {
      const net = (Number.parseInt(line.quantity, 10) || 0) * toOre(line.unitPrice)
      const vat = Math.round((net * line.vatRate) / 10_000)
      return { net: totals.net + net, vat: totals.vat + vat }
    },
    { net: 0, vat: 0 }
  )

  function updateLine(index: number, patch: Partial<LineDraft>) {
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    mutation.mutate()
  }

  const canSubmit =
    clientId !== '' &&
    lines.length > 0 &&
    lines.every((line) => line.description.trim() !== '' && toOre(line.unitPrice) > 0)

  return (
    <>
      <PageHeader title="Ny faktura" />

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        <Card className="p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="client" className="block text-sm font-medium text-slate-700">
                Kund
              </label>
              <select
                id="client"
                required
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Välj kund…</option>
                {clients.data?.clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </div>

            <Field
              label="Förfallodatum"
              name="dueDate"
              type="date"
              required
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 text-lg font-medium text-slate-900">Fakturarader</h2>

          <div className="space-y-4">
            {lines.map((line, index) => (
              <div
                key={index}
                className="grid gap-3 border-b border-slate-100 pb-4 last:border-0 sm:grid-cols-12"
              >
                <div className="sm:col-span-5">
                  <Field
                    label="Beskrivning"
                    name={`description-${index}`}
                    value={line.description}
                    onChange={(event) =>
                      updateLine(index, { description: event.target.value })
                    }
                  />
                </div>

                <div className="sm:col-span-2">
                  <Field
                    label="Antal"
                    name={`quantity-${index}`}
                    type="number"
                    step="1"
                    value={line.quantity}
                    onChange={(event) => updateLine(index, { quantity: event.target.value })}
                  />
                </div>

                <div className="sm:col-span-2">
                  <Field
                    label="À-pris (ex moms)"
                    name={`price-${index}`}
                    // Not type="number": it rejects a comma on some locales,
                    // and a Swedish keyboard produces one. We parse it instead.
                    inputMode="decimal"
                    placeholder="0,00"
                    value={line.unitPrice}
                    onChange={(event) => updateLine(index, { unitPrice: event.target.value })}
                  />
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor={`vat-${index}`}
                    className="block text-sm font-medium text-slate-700"
                  >
                    Moms
                  </label>
                  <select
                    id={`vat-${index}`}
                    value={line.vatRate}
                    onChange={(event) =>
                      updateLine(index, { vatRate: Number(event.target.value) })
                    }
                    className="mt-1.5 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    {VAT_RATES.map((rate) => (
                      <option key={rate.value} value={rate.value}>
                        {rate.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-end sm:col-span-1">
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setLines(lines.filter((_, i) => i !== index))}
                      className="pb-2 text-sm text-red-600 hover:underline"
                      aria-label={`Ta bort rad ${index + 1}`}
                    >
                      Ta bort
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="secondary"
            className="mt-4"
            onClick={() => setLines([...lines, emptyLine()])}
          >
            Lägg till rad
          </Button>
        </Card>

        <Card className="p-6">
          <dl className="ml-auto max-w-xs space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">Netto</dt>
              <dd className="tabular text-slate-900">{formatOre(preview.net)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Moms</dt>
              <dd className="tabular text-slate-900">{formatOre(preview.vat)}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-2 font-medium">
              <dt className="text-slate-900">Att betala</dt>
              <dd className="tabular text-slate-900">{formatOre(preview.net + preview.vat)}</dd>
            </div>
          </dl>
        </Card>

        {mutation.error && <ErrorMessage error={mutation.error} />}
        {mutation.error instanceof ApiError &&
          mutation.error.fieldErrors.map((issue) => (
            <p key={issue.field} className="text-sm text-red-600">
              {issue.field}: {issue.message}
            </p>
          ))}

        <div className="flex gap-3">
          <Button type="submit" isLoading={mutation.isPending} disabled={!canSubmit}>
            Skapa utkast
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate('/invoices')}>
            Avbryt
          </Button>
        </div>

        <p className="text-sm text-slate-500">
          Fakturan skapas som ett utkast. Den får sitt nummer och skickas i nästa steg.
        </p>
      </form>
    </>
  )
}

/** 30 days out, the common Swedish default. */
function defaultDueDate(): string {
  const date = new Date()
  date.setDate(date.getDate() + 30)
  return date.toISOString().slice(0, 10)
}
