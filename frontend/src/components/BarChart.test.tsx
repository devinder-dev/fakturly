// BarChart.test.tsx — the dashboard chart draws what it is given.

import { describe, test, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BarChart } from './BarChart.tsx'
import { formatOre } from './ui.tsx'
import type { MonthlyRow } from '../lib/types.ts'

const months: MonthlyRow[] = Array.from({ length: 12 }, (_, i) => ({
  month: `2026-${String(i + 1).padStart(2, '0')}`,
  invoicedOre: (i + 1) * 100_000,
  receivedOre: i * 80_000
}))

describe('BarChart', () => {
  test('renders one group per month, each with an accessible description', () => {
    render(<BarChart months={months} title="Senaste tolv månaderna" />)
    const chart = screen.getByRole('img', { name: /senaste tolv månaderna/i })
    const groups = chart.querySelectorAll('g[tabindex="0"]')
    expect(groups).toHaveLength(12)
    expect(groups[2]).toHaveAttribute('aria-label', expect.stringContaining('mar'))
    expect(groups[2]).toHaveAttribute('aria-label', expect.stringContaining(formatOre(300_000)))
  })

  test('always shows a legend, so identity is never colour alone', () => {
    render(<BarChart months={months} title="T" />)
    const legend = screen.getByRole('list', { name: 'Serier' })
    expect(within(legend).getByText('Fakturerat')).toBeInTheDocument()
    expect(within(legend).getByText('Inbetalt')).toBeInTheDocument()
  })

  test('shows exact figures on hover, not on every bar', async () => {
    render(<BarChart months={months} title="T" />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    const group = screen.getByRole('img').querySelectorAll('g[tabindex="0"]')[4]!
    await userEvent.hover(group)

    const tooltip = screen.getByRole('status')
    expect(tooltip).toHaveTextContent('2026-05')
    // toHaveTextContent collapses whitespace, including the non-breaking
    // space formatOre emits — so compare the raw text against the formatter.
    expect(tooltip.textContent).toContain(formatOre(500_000))
  })

  test('offers the same data as a table', async () => {
    render(<BarChart months={months} title="T" />)
    await userEvent.click(screen.getByRole('button', { name: 'Visa tabell' }))

    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(13) // header + 12
    expect(within(table).getByText('2026-12')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  test('says so when there is nothing to show', () => {
    const empty = months.map((m) => ({ ...m, invoicedOre: 0, receivedOre: 0 }))
    render(<BarChart months={empty} title="T" />)
    expect(screen.getByText(/inga transaktioner/i)).toBeInTheDocument()
  })
})
