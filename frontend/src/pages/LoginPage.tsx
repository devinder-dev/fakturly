// LoginPage.tsx

import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.tsx'
import { ApiError } from '../lib/api.ts'
import { Button, Field, Card } from '../components/ui.tsx'
import { FullPageSpinner } from '../components/RequireAuth.tsx'
import { DemoLogins } from '../components/DemoLogins.tsx'

export function LoginPage() {
  const { user, isLoading, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Wait for the session restore before deciding anything, or an already
  // logged-in user sees the login form flash before being redirected.
  if (isLoading) return <FullPageSpinner />

  if (user) {
    // '/app' is the role-aware start page. NOT '/': that is the public
    // landing page now, and sending a freshly logged-in user there looked
    // like the login had silently failed.
    const from = (location.state as { from?: string } | null)?.from
    return <Navigate to={from ?? '/app'} replace />
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)

    try {
      const loggedIn = await login(email, password)
      const from = (location.state as { from?: string } | null)?.from
      navigate(from ?? (loggedIn.role === 'ADMIN' ? '/dashboard' : '/invoices'), {
        replace: true
      })
    } catch (caught) {
      /**
       * Show the API's message verbatim.
       *
       * It is deliberately vague — the same text for a wrong password, an
       * unknown email and a locked account — because distinguishing them
       * would let anyone enumerate customers. Rewriting it here to be more
       * "helpful" would undo that work, and it is tempting to.
       */
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Kunde inte nå servern. Försök igen.'
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-slate-900">Fakturly</h1>
          <p className="mt-1 text-sm text-slate-500">Logga in för att fortsätta</p>
        </div>

        <Card className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Field
              label="E-postadress"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />

            <Field
              label="Lösenord"
              name="password"
              type="password"
              // Tells a password manager this is a login, not a new password.
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />

            {error && (
              <div className="rounded-md bg-red-50 p-3" role="alert">
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}

            <Button type="submit" isLoading={isSubmitting} className="w-full">
              Logga in
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-xs text-slate-500">
          Konton skapas av administratören. Du får en inbjudan via e-post.
        </p>

        {/* Renders nothing unless the API is in demo mode. */}
        <DemoLogins className="mt-8" />

        <p className="mt-6 text-center text-xs">
          <Link to="/" className="text-slate-500 hover:text-slate-900 hover:underline">
            Om Fakturly
          </Link>
        </p>
      </div>
    </div>
  )
}
