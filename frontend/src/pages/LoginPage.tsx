// LoginPage.tsx — split layout: the form on one side, the product on the other.
//
// The dark panel is not decoration for its own sake. Someone who lands here
// from a link has not seen the landing page, and the panel tells them in two
// sentences what they are logging into.

import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth.tsx'
import { ApiError } from '../lib/api.ts'
import { Button, Field } from '../components/ui.tsx'
import { FullPageSpinner } from '../components/RequireAuth.tsx'
import { DemoLogins } from '../components/DemoLogins.tsx'
import { Logo } from '../components/Logo.tsx'

export function LoginPage() {
  const { user, isLoading, login } = useAuth()
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
      await login(email, password)
      // No navigate() here. Setting the user re-renders this page, and the
      // `if (user)` branch above sends them on — to where they were going,
      // or to the role-aware start page. One redirect rule, not two racing.
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
    <div className="grid min-h-screen font-sans antialiased lg:grid-cols-[1fr_1fr]">
      {/* ── Brand panel ─────────────────────────────────────── */}
      <aside className="hero-glow grid-paper relative hidden flex-col justify-between bg-ink-950 p-12 text-white lg:flex">
        <Link to="/"><Logo tone="light" /></Link>
        <div>
          <h2 className="max-w-md text-3xl font-bold leading-tight tracking-tight">
            Fakturering byggd som ett finansiellt system.
          </h2>
          <p className="mt-4 max-w-md text-slate-400">
            Pengar i heltal. Skickade fakturor som aldrig ändras. En huvudbok där varje öre går att
            förklara.
          </p>
        </div>
        <p className="text-xs text-slate-500">
          Ett studieprojekt av Devinder Singh · Chas Academy Stockholm
        </p>
      </aside>

      {/* ── Form ────────────────────────────────────────────── */}
      <main className="flex items-center justify-center bg-white px-6 py-16">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-10 inline-block lg:hidden"><Logo /></Link>

          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Logga in</h1>
          <p className="mt-1 text-sm text-slate-500">
            Konton skapas av administratören. Du får en inbjudan via e-post.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4" noValidate>
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
              <div className="rounded-lg bg-red-50 p-3" role="alert">
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}

            <Button type="submit" isLoading={isSubmitting} className="w-full">
              Logga in
            </Button>
          </form>

          {/* Renders nothing unless the API is in demo mode. */}
          <div className="mt-10 border-t border-slate-100 pt-8">
            <DemoLogins />
          </div>

          <p className="mt-10 text-xs">
            <Link to="/" className="text-slate-500 hover:text-slate-900 hover:underline">
              ← Om Fakturly
            </Link>
          </p>
        </div>
      </main>
    </div>
  )
}
