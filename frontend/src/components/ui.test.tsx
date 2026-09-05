// ui.test.tsx — the shared components, and the one function that touches money.

import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button, StatusBadge, formatOre, ErrorMessage, Field } from './ui.tsx'

describe('formatOre', () => {
  test('formats öre as Swedish kronor with a non-breaking space', () => {
    // The space is U+00A0, so a line break can never split the figure.
    expect(formatOre(1_234_567)).toBe('12 345,67 SEK')
    expect(formatOre(5)).toBe('0,05 SEK')
    expect(formatOre(-6_000)).toBe('-60,00 SEK')
    expect(formatOre(100_000_000)).toBe('1 000 000,00 SEK')
  })

  test('matches the backend byte for byte', () => {
    // Copied from backend/tests/unit/money.test.ts. If the two ever differ,
    // an amount the API formatted and one the browser formatted would not
    // look the same on one screen.
    expect(formatOre(1_250_000)).toBe('12 500,00 SEK')
  })

  test('takes a currency, and can omit it', () => {
    expect(formatOre(100, 'EUR')).toBe('1,00 EUR')
    expect(formatOre(100, '').trim()).toBe('1,00')
  })
})

describe('StatusBadge', () => {
  test('shows a Swedish word, never colour alone', () => {
    render(<StatusBadge status="OVERDUE" />)
    expect(screen.getByText('Förfallen')).toBeInTheDocument()
  })

  test('a credit note is labelled by kind, not by its SENT status', () => {
    render(<StatusBadge status="SENT" type="CREDIT_NOTE" />)
    expect(screen.getByText('Kreditfaktura')).toBeInTheDocument()
    expect(screen.queryByText('Skickad')).not.toBeInTheDocument()
  })

  test('knows every status', () => {
    for (const [status, label] of [
      ['DRAFT', 'Utkast'],
      ['SENT', 'Skickad'],
      ['PAID', 'Betald'],
      ['CREDITED', 'Krediterad']
    ] as const) {
      const { unmount } = render(<StatusBadge status={status} />)
      expect(screen.getByText(label)).toBeInTheDocument()
      unmount()
    }
  })
})

describe('Button', () => {
  test('is disabled while loading, so a double click cannot send twice', async () => {
    const onClick = vi.fn()
    render(
      <Button isLoading onClick={onClick}>
        Skicka
      </Button>
    )
    const button = screen.getByRole('button', { name: /skicka/i })
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  test('calls onClick when enabled', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Spara</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Spara' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('Field', () => {
  test('links the error message to the input for screen readers', () => {
    render(<Field label="E-post" name="email" error="Ogiltig e-postadress" />)
    const input = screen.getByLabelText('E-post')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Ogiltig e-postadress')
  })
})

describe('ErrorMessage', () => {
  test('shows the request id so the user can quote it', () => {
    const error = Object.assign(new Error('Något gick fel'), { requestId: 'req-42' })
    render(<ErrorMessage error={error} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Något gick fel')
    expect(screen.getByText(/req-42/)).toBeInTheDocument()
  })
})
