// Logo.tsx — the wordmark, with a mark that is a ledger row.
//
// Hand-drawn SVG rather than an image file: it scales, it takes the text
// colour, and there is nothing to load. The mark is three lines of unequal
// length ending in a full one — an invoice's rows and its total.

export function Logo({ tone = 'dark', className = '' }: { tone?: 'dark' | 'light'; className?: string }) {
  const text = tone === 'light' ? 'text-white' : 'text-slate-900'
  return (
    <span className={`inline-flex items-center gap-2.5 ${text} ${className}`}>
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <rect width="26" height="26" rx="7" className="fill-brand-600" />
        <path d="M7 8.5h8M7 13h12M7 17.5h5" stroke="white" strokeWidth="2" strokeLinecap="round" />
        <circle cx="18" cy="17.5" r="1.6" className="fill-mint-400" />
      </svg>
      <span className="text-lg font-bold tracking-tight">Fakturly</span>
    </span>
  )
}
