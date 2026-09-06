// DemoLogins.tsx — one-click sign-in for the public showcase.
//
// Asks the API for its demo accounts. A real deployment has no such route
// (it is only registered under DEMO_MODE), so the request 404s and this
// component renders nothing at all. The frontend has no demo flag of its own
// to keep in sync — the API decides.

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { api, ApiError } from '../lib/api.ts'
import { useAuth } from '../lib/auth.tsx'
import type { DemoAccount, DemoResponse } from '../lib/types.ts'
import { Button } from './ui.tsx'

export function useDemoAccounts() {
  return useQuery({
    queryKey: ['demo'],
    queryFn: async () => {
      try {
        return await api.get<DemoResponse>('/demo')
      } catch (error) {
        // Not in demo mode. That is the normal case, not a failure.
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      }
    },
    staleTime: Infinity,
    retry: false
  })
}

export function DemoLogins({ className = '', tone = 'light' }: { className?: string; tone?: 'light' | 'dark' }) {
  const demo = useDemoAccounts()
  const { login } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!demo.data) return null

  async function signIn(account: DemoAccount) {
    setBusy(account.email)
    setError(null)
    try {
      const user = await login(account.email, account.password)
      navigate(user.role === 'ADMIN' ? '/dashboard' : '/invoices', { replace: true })
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Kunde inte nå servern.')
      setBusy(null)
    }
  }

  return (
    <div className={className}>
      <p className={`mb-3 text-xs font-semibold uppercase tracking-wider ${tone === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>
        Prova demot
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {demo.data.accounts.map((account, index) => (
          <Button
            key={account.email}
            // On the dark hero the first button is the bright one.
            variant={tone === 'dark' ? (index === 0 ? 'inverted' : 'ghost') : index === 0 ? 'primary' : 'secondary'}
            onClick={() => signIn(account)}
            isLoading={busy === account.email}
            disabled={busy !== null}
            className="w-full"
          >
            {account.role === 'ADMIN' ? 'Som administratör' : 'Som kund'}
          </Button>
        ))}
      </div>
      {error && (
        <p className="mt-2 text-sm text-red-500" role="alert">
          {error}
        </p>
      )}
      <p className={`mt-3 text-xs ${tone === 'dark' ? 'text-slate-500' : 'text-slate-500'}`}>
        Inget konto behövs. Demodata återställs varje natt kl 03:00.
      </p>
    </div>
  )
}
