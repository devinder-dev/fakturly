// SetPasswordPage.tsx — where an invited client chooses their first password.
//
// The token arrives in the URL, because that is the only way an email link
// can carry it. We read it, then send it in the request BODY — the API takes
// it there deliberately, so it does not end up in server access logs.
//
// It arrives in the FRAGMENT (#token=), which browsers never send to any
// server — a ?token= reached the hosting provider's logs with the page load.
// Links sent before that change used the query string and are still read,
// until they expire on their own (7 days at most).

import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api.ts'
import { Button, Field, Card } from '../components/ui.tsx'

/** Reads the token from the fragment, or the query string of an older link. No side effects. */
function readTokenFromUrl(): string | null {
  const fromFragment = new URLSearchParams(window.location.hash.slice(1)).get('token')
  const fromQuery = new URLSearchParams(window.location.search).get('token')
  return fromFragment ?? fromQuery
}

/** Mirrors the backend policy, so a user is told before a round trip. */
const MIN_LENGTH = 12

export function SetPasswordPage() {
  const navigate = useNavigate()
  // useState keeps the token after the URL is cleaned below; a plain call
  // would read the now-empty URL on the next render.
  const [token] = useState(readTokenFromUrl)

  // Then wipe it from the address bar. replaceState rewrites the current
  // history entry, so the token is not left in history or visible over a
  // shoulder. In an effect, not the initialiser: StrictMode runs initialisers
  // twice in development, and the second run would find the URL already empty.
  useEffect(() => {
    if (window.location.hash || window.location.search) {
      window.history.replaceState(window.history.state, '', window.location.pathname)
    }
  }, [])

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  if (!token) {
    return (
      <Centered>
        <Card className="p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Ogiltig länk</h1>
          <p className="mt-2 text-sm text-slate-600">
            Länken saknar en token. Kontrollera att du kopierade hela adressen från mejlet.
          </p>
          <Link
            to="/login"
            className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline"
          >
            Till inloggningen
          </Link>
        </Card>
      </Centered>
    )
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)

    // Checked here purely so the user is not made to wait for a round trip
    // to be told the two fields differ. The API is still the authority on
    // everything else — length, breach status, normalisation.
    if (password !== confirm) {
      setError('Lösenorden matchar inte')
      return
    }

    setIsSubmitting(true)

    try {
      await api.post('/auth/set-password', { token, password })
      setDone(true)
    } catch (caught) {
      if (caught instanceof ApiError) {
        // A 400 carries field-level detail (too short); a 401 means the link
        // is unknown, expired or already used — deliberately one message for
        // all three, so a stale link reveals nothing about the account.
        const fieldError = caught.fieldErrors[0]
        setError(fieldError ? fieldError.message : caught.message)
      } else {
        setError('Kunde inte nå servern. Försök igen.')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  if (done) {
    return (
      <Centered>
        <Card className="p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Lösenordet är satt</h1>
          <p className="mt-2 text-sm text-slate-600">Du kan nu logga in med din e-postadress.</p>
          <Button className="mt-4 w-full" onClick={() => navigate('/login')}>
            Logga in
          </Button>
        </Card>
      </Centered>
    )
    // Note: setting a password does NOT log you in. The API returns 204 and
    // no session — proving you can read an inbox is not proving you know the
    // password, so the next step goes through the normal rate-limited login.
  }

  const tooShort = password.length > 0 && password.length < MIN_LENGTH

  return (
    <Centered>
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">Välj ditt lösenord</h1>
        <p className="mt-1 text-sm text-slate-500">Välkommen till Fakturly</p>
      </div>

      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Field
            label="Nytt lösenord"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={tooShort ? `Minst ${MIN_LENGTH} tecken` : undefined}
            // No "must contain a capital and a symbol". The backend follows
            // NIST: length beats complexity, and composition rules reliably
            // produce "Sommar2026!".
            hint={`Minst ${MIN_LENGTH} tecken. En lång fras är starkare än ett kort krångligt lösenord.`}
          />

          <Field
            label="Upprepa lösenordet"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />

          {error && (
            <div className="rounded-md bg-red-50 p-3" role="alert">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          <Button
            type="submit"
            isLoading={isSubmitting}
            disabled={password.length < MIN_LENGTH || confirm.length === 0}
            className="w-full"
          >
            Spara lösenord
          </Button>
        </form>
      </Card>
    </Centered>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
