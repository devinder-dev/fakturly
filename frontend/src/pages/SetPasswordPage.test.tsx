// SetPasswordPage.test.tsx — where the invite token is read from, and that
// it does not stay in the URL.
//
// The page reads window.location directly (the token is in the fragment,
// which the router does not model), so each test sets the real jsdom URL.

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SetPasswordPage } from './SetPasswordPage.tsx'

const PASSWORD = 'en lång och bra lösenfras'

function renderAt(url: string) {
  window.history.replaceState(null, '', url)
  const sent: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(null, { status: 204 })
    })
  )
  render(
    <MemoryRouter>
      <SetPasswordPage />
    </MemoryRouter>
  )
  return sent
}

async function submit() {
  await userEvent.type(screen.getByLabelText('Nytt lösenord'), PASSWORD)
  await userEvent.type(screen.getByLabelText('Upprepa lösenordet'), PASSWORD)
  await userEvent.click(screen.getByRole('button', { name: 'Spara lösenord' }))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('SetPasswordPage', () => {
  test('🔑 reads the token from the fragment and wipes it from the address bar', async () => {
    const sent = renderAt('/set-password#token=abc-123')

    // Cleaned straight away — before the user has typed anything.
    await waitFor(() => expect(window.location.href).not.toContain('abc-123'))
    expect(window.location.pathname).toBe('/set-password')

    // ...and the token still reaches the API, in the body.
    await submit()
    await waitFor(() => expect(sent).toEqual([{ token: 'abc-123', password: PASSWORD }]))
  })

  test('still accepts an older ?token= link, and cleans that too', async () => {
    const sent = renderAt('/set-password?token=old-link')

    await waitFor(() => expect(window.location.search).toBe(''))
    await submit()
    await waitFor(() => expect(sent).toEqual([{ token: 'old-link', password: PASSWORD }]))
  })

  test('without a token, says the link is broken', () => {
    renderAt('/set-password')
    expect(screen.getByText('Ogiltig länk')).toBeTruthy()
  })
})
