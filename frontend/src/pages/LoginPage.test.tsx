// LoginPage.test.tsx — the login form, against a faked API.
//
// fetch is replaced, not the auth module: the test exercises the real
// AuthProvider, the real api.ts (including its silent-refresh attempt on
// mount) and the real page. Only the network is fake.

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '../lib/auth.tsx'
import { LoginPage } from './LoginPage.tsx'

type Handler = (url: string, init?: RequestInit) => Response

function fakeFetch(handler: Handler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init))
  )
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function renderLogin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/app" element={<p>start page</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('LoginPage', () => {
  test('shows the API error verbatim — it is deliberately vague', async () => {
    fakeFetch((url) => {
      if (url.endsWith('/auth/refresh')) return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } })
      if (url.endsWith('/demo')) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x', requestId: 'r' } })
      if (url.endsWith('/auth/login')) {
        return jsonResponse(401, {
          error: { code: 'INVALID_CREDENTIALS', message: 'Ogiltig e-postadress eller lösenord', requestId: 'req-1' }
        })
      }
      throw new Error(`unexpected ${url}`)
    })

    renderLogin()
    await userEvent.type(await screen.findByLabelText('E-postadress'), 'anna@example.se')
    await userEvent.type(screen.getByLabelText('Lösenord'), 'fel lösenord')
    await userEvent.click(screen.getByRole('button', { name: 'Logga in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Ogiltig e-postadress eller lösenord')
    // Same message for a wrong password, an unknown email and a locked
    // account. The page must not "improve" it.
  })

  test('sends the token where it belongs and lands on the start page', async () => {
    let loginBody: unknown = null
    fakeFetch((url, init) => {
      if (url.endsWith('/auth/refresh')) return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } })
      if (url.endsWith('/demo')) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x', requestId: 'r' } })
      if (url.endsWith('/auth/login')) {
        loginBody = JSON.parse(String(init?.body))
        return jsonResponse(200, { accessToken: 'token-123', user: { id: 'u1', email: 'admin@x.se', role: 'ADMIN' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    renderLogin()
    await userEvent.type(await screen.findByLabelText('E-postadress'), 'admin@x.se')
    await userEvent.type(screen.getByLabelText('Lösenord'), 'ett riktigt långt lösenord')
    await userEvent.click(screen.getByRole('button', { name: 'Logga in' }))

    // /app is the role-aware start page in the real app; here it is a stub.
    await waitFor(() => expect(screen.getByText('start page')).toBeInTheDocument())
    expect(loginBody).toEqual({ email: 'admin@x.se', password: 'ett riktigt långt lösenord' })
    // The token is now in memory in api.ts — not in localStorage, which any
    // script on the page could read.
    expect(localStorage.getItem('accessToken')).toBeNull()
  })

  test('shows demo buttons only when the API says it is a demo', async () => {
    fakeFetch((url) => {
      if (url.endsWith('/auth/refresh')) return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } })
      if (url.endsWith('/demo')) {
        return jsonResponse(200, {
          accounts: [{ role: 'ADMIN', email: 'a@demo', password: 'p', label: 'Admin' }],
          resetsNightly: true
        })
      }
      throw new Error(`unexpected ${url}`)
    })

    renderLogin()
    expect(await screen.findByRole('button', { name: 'Som administratör' })).toBeInTheDocument()
  })
})
