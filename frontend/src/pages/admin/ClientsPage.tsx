// ClientsPage.tsx — admin: list customers and add one.

import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api.ts'
import type { Client, ClientListResponse } from '../../lib/types.ts'
import {
  Button,
  Card,
  Field,
  PageHeader,
  Spinner,
  ErrorMessage,
  EmptyState,
  formatDate
} from '../../components/ui.tsx'

export function ClientsPage() {
  const [isCreating, setIsCreating] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<ClientListResponse>('/clients?limit=100')
  })

  return (
    <>
      <PageHeader
        title="Kunder"
        subtitle="Varje kund får ett konto och en inbjudan att välja lösenord."
        action={
          <Button onClick={() => setIsCreating(true)} disabled={isCreating}>
            Ny kund
          </Button>
        }
      />

      {isCreating && <NewClientForm onDone={() => setIsCreating(false)} />}

      {isLoading && <Spinner />}
      {error && <ErrorMessage error={error} />}

      {data && (
        <Card>
          {data.clients.length === 0 ? (
            <EmptyState
              title="Inga kunder ännu"
              description="Lägg till din första kund för att kunna skapa fakturor."
            />
          ) : (
            <ClientTable clients={data.clients} />
          )}
        </Card>
      )}
    </>
  )
}

function ClientTable({ clients }: { clients: Client[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-6 py-3 font-medium">Namn</th>
            <th className="px-6 py-3 font-medium">E-post</th>
            <th className="px-6 py-3 font-medium">Telefon</th>
            <th className="px-6 py-3 font-medium">Kund sedan</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {clients.map((client) => (
            <tr key={client.id} className="hover:bg-slate-50">
              <td className="px-6 py-4 font-medium text-slate-900">{client.name}</td>
              <td className="px-6 py-4 text-slate-600">{client.email}</td>
              <td className="px-6 py-4 text-slate-600">{client.phone ?? '—'}</td>
              <td className="px-6 py-4 text-slate-500">{formatDate(client.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function NewClientForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ email: '', name: '', phone: '', address: '' })

  const mutation = useMutation({
    mutationFn: (input: typeof form) =>
      api.post<{ client: Client }>('/clients', {
        email: input.email,
        name: input.name,
        // Empty optional fields are omitted rather than sent as "". The
        // schema treats them as optional, and an empty string is a value.
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.address ? { address: input.address } : {})
      }),
    onSuccess: () => {
      // Refetch the list so the new client appears, rather than pushing it in
      // locally — the server row is the truth and carries fields we did not send.
      void queryClient.invalidateQueries({ queryKey: ['clients'] })
      onDone()
    }
  })

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    mutation.mutate(form)
  }

  const fieldError = (name: string) =>
    mutation.error instanceof ApiError
      ? mutation.error.fieldErrors.find((issue) => issue.field === name)?.message
      : undefined

  return (
    <Card className="mb-6 p-6">
      <h2 className="mb-4 text-lg font-medium text-slate-900">Ny kund</h2>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Företagsnamn"
            name="name"
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            error={fieldError('name')}
          />
          <Field
            label="E-postadress"
            name="email"
            type="email"
            required
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
            error={fieldError('email')}
            hint="Kunden får en inbjudan hit för att välja lösenord."
          />
          <Field
            label="Telefon"
            name="phone"
            value={form.phone}
            onChange={(event) => setForm({ ...form, phone: event.target.value })}
            error={fieldError('phone')}
          />
          <Field
            label="Adress"
            name="address"
            value={form.address}
            onChange={(event) => setForm({ ...form, address: event.target.value })}
            error={fieldError('address')}
          />
        </div>

        {/*
          A 409 means the email is taken — but the API deliberately does not
          say so, because confirming an address is registered lets someone
          enumerate the customer base. We show its vague message as-is.
        */}
        {mutation.error && !fieldError('email') && <ErrorMessage error={mutation.error} />}

        <div className="flex gap-3">
          <Button type="submit" isLoading={mutation.isPending}>
            Skapa kund
          </Button>
          <Button type="button" variant="secondary" onClick={onDone}>
            Avbryt
          </Button>
        </div>
      </form>
    </Card>
  )
}
