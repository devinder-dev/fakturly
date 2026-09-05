// BarChart.tsx — grouped bars, twelve months, two series. Plain SVG.
//
// No chart library. The dashboard has exactly one chart, and a library
// would add 100 kB to explain nothing — every line here can be read.
//
// What the SVG does and does not do:
//   - draws in a fixed 720x240 coordinate space and lets the viewBox scale
//     it, so it is responsive without measuring the container
//   - keeps the grid and axes recessive: the data is the ink
//   - shows the exact figure on hover, and NOT on every bar — a number on
//     every mark is a table drawn badly
//   - carries a legend AND a table view, so identity is never colour alone
//
// Money arrives as öre and stays öre until the label is formatted.

import { useState } from 'react'
import type { MonthlyRow } from '../lib/types.ts'
import { formatOre } from './ui.tsx'

/**
 * Two categorical slots from a validated palette: blue and orange, which
 * survive every common colour-vision deficiency at a wide margin (CVD ΔE 24.7
 * where 8 is the target). The app's own brand blue is close to slot one but
 * was not validated against the orange, so the reference pair is used as is.
 */
const SERIES = {
  invoiced: { label: 'Fakturerat', color: '#2a78d6' },
  received: { label: 'Inbetalt', color: '#eb6834' }
} as const

const WIDTH = 720
const HEIGHT = 240
const PAD = { top: 12, right: 8, bottom: 28, left: 52 }

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

function monthLabel(key: string): string {
  const month = Number(key.slice(5, 7))
  return MONTH_NAMES[month - 1] ?? key
}

/** "120 tkr" for an axis. Öre in, a short label out. Never fed back. */
function axisLabel(ore: number): string {
  const kronor = ore / 100
  if (kronor >= 1_000_000) return `${(kronor / 1_000_000).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} mkr`
  if (kronor >= 1_000) return `${Math.round(kronor / 1_000)} tkr`
  return `${Math.round(kronor)} kr`
}

/** A "nice" axis maximum: 1, 2 or 5 times a power of ten, at or above the data. */
function niceMax(value: number): number {
  if (value <= 0) return 100
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 5, 10]) {
    if (step * magnitude >= value) return step * magnitude
  }
  return 10 * magnitude
}

export function BarChart({ months, title }: { months: MonthlyRow[]; title: string }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  const maxOre = niceMax(
    Math.max(0, ...months.flatMap((m) => [m.invoicedOre, m.receivedOre]))
  )

  const plotWidth = WIDTH - PAD.left - PAD.right
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const groupWidth = plotWidth / months.length
  // Two bars per group, a 2px surface gap between them, breathing room at
  // the sides of the group.
  const barWidth = Math.max(4, (groupWidth - 14) / 2)
  const gap = 2

  const y = (ore: number) => PAD.top + plotHeight - (ore / maxOre) * plotHeight
  const gridSteps = [0, 0.25, 0.5, 0.75, 1]

  const isEmpty = months.every((m) => m.invoicedOre === 0 && m.receivedOre === 0)

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">{title}</h2>

        <div className="flex items-center gap-4">
          <ul className="flex items-center gap-4 text-xs text-slate-600" aria-label="Serier">
            {Object.values(SERIES).map((series) => (
              <li key={series.label} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: series.color }}
                  aria-hidden
                />
                {series.label}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setShowTable((value) => !value)}
            className="text-xs font-medium text-brand-600 hover:underline"
          >
            {showTable ? 'Visa diagram' : 'Visa tabell'}
          </button>
        </div>
      </div>

      {showTable ? (
        <MonthTable months={months} />
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="h-auto w-full"
            role="img"
            aria-label={`${title}: fakturerat och inbetalt per månad`}
            onMouseLeave={() => setHovered(null)}
          >
            {/* Grid — light, behind the data. */}
            {gridSteps.map((step) => {
              const value = maxOre * step
              return (
                <g key={step}>
                  <line
                    x1={PAD.left}
                    x2={WIDTH - PAD.right}
                    y1={y(value)}
                    y2={y(value)}
                    stroke={step === 0 ? '#cbd5e1' : '#f1f5f9'}
                    strokeWidth={1}
                  />
                  <text
                    x={PAD.left - 8}
                    y={y(value)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-slate-500"
                    fontSize={10}
                  >
                    {axisLabel(value)}
                  </text>
                </g>
              )
            })}

            {months.map((month, index) => {
              const groupX = PAD.left + index * groupWidth
              const centre = groupX + groupWidth / 2
              const invoicedX = centre - barWidth - gap / 2
              const receivedX = centre + gap / 2
              const isHovered = hovered === index

              return (
                <g
                  key={month.month}
                  onMouseEnter={() => setHovered(index)}
                  onFocus={() => setHovered(index)}
                  onBlur={() => setHovered(null)}
                  tabIndex={0}
                  aria-label={`${monthLabel(month.month)}: fakturerat ${formatOre(month.invoicedOre)}, inbetalt ${formatOre(month.receivedOre)}`}
                >
                  {/* Hit target: the whole column, wider than the bars. */}
                  <rect
                    x={groupX}
                    y={PAD.top}
                    width={groupWidth}
                    height={plotHeight}
                    fill={isHovered ? '#f8fafc' : 'transparent'}
                  />

                  <Bar x={invoicedX} width={barWidth} top={y(month.invoicedOre)} bottom={y(0)} color={SERIES.invoiced.color} />
                  <Bar x={receivedX} width={barWidth} top={y(month.receivedOre)} bottom={y(0)} color={SERIES.received.color} />

                  <text
                    x={centre}
                    y={HEIGHT - 10}
                    textAnchor="middle"
                    fontSize={10}
                    className={isHovered ? 'fill-slate-900' : 'fill-slate-500'}
                  >
                    {monthLabel(month.month)}
                  </text>
                </g>
              )
            })}
          </svg>

          {isEmpty && (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">
              Inga transaktioner de senaste tolv månaderna
            </p>
          )}

          {hovered !== null && months[hovered] && (
            <Tooltip month={months[hovered]} index={hovered} count={months.length} />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One bar. Rounded at the data end only, square at the baseline — a bar
 * that is rounded at both ends floats, and reads as shorter than it is.
 * Drawn as a path so the two corners can differ.
 */
function Bar({ x, width, top, bottom, color }: { x: number; width: number; top: number; bottom: number; color: string }) {
  const height = bottom - top
  if (height <= 0) return null
  const r = Math.min(4, width / 2, height)

  const d = [
    `M ${x} ${bottom}`,
    `V ${top + r}`,
    `Q ${x} ${top} ${x + r} ${top}`,
    `H ${x + width - r}`,
    `Q ${x + width} ${top} ${x + width} ${top + r}`,
    `V ${bottom}`,
    'Z'
  ].join(' ')

  return <path d={d} fill={color} />
}

function Tooltip({ month, index, count }: { month: MonthlyRow; index: number; count: number }) {
  // Positioned in percent of the chart width, so it follows the responsive
  // SVG without measuring anything. Flips to the left for the last months
  // so it never runs off the right edge.
  const left = ((PAD.left + (index + 0.5) * ((WIDTH - PAD.left - PAD.right) / count)) / WIDTH) * 100
  const flip = index > count / 2

  return (
    <div
      className="pointer-events-none absolute top-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm"
      style={{ left: `${left}%`, transform: flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}
      role="status"
    >
      <p className="mb-1 font-medium text-slate-900">{month.month}</p>
      <p className="tabular flex justify-between gap-4 text-slate-700">
        <span>{SERIES.invoiced.label}</span>
        <span>{formatOre(month.invoicedOre)}</span>
      </p>
      <p className="tabular flex justify-between gap-4 text-slate-700">
        <span>{SERIES.received.label}</span>
        <span>{formatOre(month.receivedOre)}</span>
      </p>
    </div>
  )
}

function MonthTable({ months }: { months: MonthlyRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2 font-medium">Månad</th>
            <th className="py-2 text-right font-medium">{SERIES.invoiced.label}</th>
            <th className="py-2 text-right font-medium">{SERIES.received.label}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {months.map((month) => (
            <tr key={month.month}>
              <td className="py-2 text-slate-700">{month.month}</td>
              <td className="tabular py-2 text-right text-slate-900">{formatOre(month.invoicedOre)}</td>
              <td className="tabular py-2 text-right text-slate-900">{formatOre(month.receivedOre)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
