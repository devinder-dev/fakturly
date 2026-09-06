// LandingPage.tsx — the public front door.
//
// The only page anyone sees without logging in. It has thirty seconds to make
// a recruiter understand what Fakturly is and one click to let them try it.
//
// Everything on it is built from the app's own components and plain CSS —
// no illustration library, no stock image. The "product" in the hero is a
// real invoice card whose ledger writes itself in, because the ledger IS the
// product. If a reviewer asks "what does it actually do", the hero is the
// answer.
//
// The demo accounts come from the API and disappear when it is not in demo
// mode; the rest of the page is static.

import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth.tsx'
import { Button, formatOre } from '../components/ui.tsx'
import { DemoLogins, useDemoAccounts } from '../components/DemoLogins.tsx'
import { Logo } from '../components/Logo.tsx'

const GITHUB_URL = 'https://github.com/devinder-dev/fakturly'
const ADR_URL = `${GITHUB_URL}/blob/main/docs/architecture-decisions.md`
const API_DOCS_URL = `${import.meta.env.VITE_API_URL ?? 'http://localhost:3000'}/docs`

export function LandingPage() {
  const { user } = useAuth()
  const demo = useDemoAccounts()

  return (
    <div className="min-h-screen bg-white font-sans text-slate-900 antialiased">
      {/* ── Nav ─────────────────────────────────────────────── */}
      <header className="absolute inset-x-0 top-0 z-10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Logo tone="light" />
          <nav className="flex items-center gap-7 text-sm text-slate-300">
            <a href="#funktioner" className="hidden hover:text-white sm:block">Funktioner</a>
            <a href="#sa-funkar-det" className="hidden hover:text-white sm:block">Så funkar det</a>
            <a href="#arkitektur" className="hidden hover:text-white sm:block">Arkitektur</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-white">GitHub</a>
            <Link
              to={user ? '/app' : '/login'}
              className="rounded-full border border-white/20 px-4 py-1.5 text-white transition hover:bg-white/10"
            >
              {user ? 'Till appen' : 'Logga in'}
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────── */}
      <section className="hero-glow grid-paper relative overflow-hidden bg-ink-950 text-white">
        <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 pb-24 pt-32 lg:grid-cols-[1.05fr_0.95fr] lg:pb-32 lg:pt-40">
          <div className="rise">
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-slate-200">
              <span className="h-1.5 w-1.5 rounded-full bg-mint-400" />
              Öppen källkod · Byggt för svensk bokföring
            </p>
            <h1 className="text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
              Fakturering byggd som ett{' '}
              <span className="bg-gradient-to-r from-brand-200 to-mint-400 bg-clip-text text-transparent">
                finansiellt system.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-300">
              Fakturor med moms per rad, Stripe-betalningar, dröjsmålsränta enligt räntelagen och
              kreditfakturor som gör rätt. Pengar i heltal. Historik som aldrig skrivs om.
            </p>

            <div className="mt-9 max-w-md">
              {demo.data ? (
                <DemoLogins tone="dark" />
              ) : (
                <Link to="/login">
                  <Button className="bg-white text-ink-950 hover:bg-slate-100">Logga in</Button>
                </Link>
              )}
            </div>

            <dl className="mt-12 grid grid-cols-3 gap-6 border-t border-white/10 pt-8 text-sm">
              <HeroStat value="420+" label="tester mot riktig databas" />
              <HeroStat value="48" label="dokumenterade beslut" />
              <HeroStat value="0" label="flyttal i pengar" />
            </dl>
          </div>

          <div className="rise" style={{ animationDelay: '150ms' }}>
            <HeroInvoice />
          </div>
        </div>
      </section>

      {/* ── Feature bento ───────────────────────────────────── */}
      <section id="funktioner" className="mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">Funktioner</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Det som svensk bokföring faktiskt kräver.
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            Inte en att-göra-lista med "betalningar" på. Varje del följer den lag eller praxis som
            en ekonomiavdelning kommer att fråga om.
          </p>
        </div>

        <div className="mt-14 grid gap-5 md:grid-cols-6">
          <Tile className="md:col-span-4" eyebrow="Kreditfaktura" title="En skickad faktura ändras aldrig. Den krediteras.">
            <p className="text-slate-600">
              Rättelsen är ett nytt dokument med nästa nummer i samma serie. Originalets huvudbok
              summerar till noll, och inget raderas.
            </p>
            <CreditNoteVisual />
          </Tile>

          <Tile className="md:col-span-2" eyebrow="Moms" title="Per rad, avrundad per rad.">
            <VatVisual />
          </Tile>

          <Tile className="md:col-span-2" eyebrow="Dröjsmålsränta" title="Referensränta + 8 %, per dag.">
            <p className="text-sm text-slate-600">
              Ett nattligt jobb med retry-logik. Varje dags ränta är en egen rad — förklarbar öre
              för öre.
            </p>
            <InterestVisual />
          </Tile>

          <Tile className="md:col-span-2" eyebrow="Stripe" title="Betalning med idempotens i tre lager.">
            <p className="text-sm text-slate-600">
              Stripe skickar samma webhook flera gånger. Händelsen bokas innan arbetet görs; samma
              betalning kan aldrig bokföras två gånger.
            </p>
          </Tile>

          <Tile className="md:col-span-2" eyebrow="Säkerhet" title="Fel läcker ingenting.">
            <pre className="mt-3 rounded-lg bg-ink-950 p-4 font-mono text-xs leading-relaxed text-slate-200">
{`GET /invoices/2026-0007
→ 404  // inte 403.
   403 säger "finns, men inte din"
   404 säger ingenting.`}
            </pre>
          </Tile>

          <Tile className="md:col-span-3" eyebrow="Rapporter" title="Kundreskontra, momsrapport, SIE 4.">
            <p className="text-sm text-slate-600">
              Filerna en revisor faktiskt läser in: CSV som svensk Excel öppnar rätt, och SIE-export
              på BAS-kontoplanen där varje verifikation balanserar.
            </p>
            <AgingVisual />
          </Tile>

          <Tile className="md:col-span-3" eyebrow="PDF" title="Allt lagen kräver, plus OCR-nummer.">
            <p className="text-sm text-slate-600">
              Org.nr, momsreg.nr, F-skatt, moms per sats, bankgiro — och en OCR-referens med Luhn-kontrollsiffra som kundens bank kontrollerar innan pengarna lämnar kontot.
            </p>
            <div className="mt-5 flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">OCR / referens</p>
                <p className="tabular mt-1 font-mono text-xl font-semibold tracking-wider text-slate-900">2026 0007 08</p>
              </div>
              <div className="ml-auto text-right">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Bankgiro</p>
                <p className="mt-1 font-semibold text-slate-900">123-4567</p>
              </div>
            </div>
          </Tile>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────── */}
      <section id="sa-funkar-det" className="border-y border-slate-100 bg-slate-50">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">Så funkar det</p>
          <h2 className="mt-3 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
            Från utkast till betald, med huvudboken som vittne.
          </h2>

          <ol className="mt-14 grid gap-8 md:grid-cols-3">
            <Step n="1" title="Skriv och skicka">
              Rader med antal, à-pris och momssats. Totalerna räknas på servern — aldrig från
              klienten. Vid "skicka" får fakturan sitt nummer i serien, blir låst och kunden får
              mejl.
            </Step>
            <Step n="2" title="Låt systemet jaga">
              Förfaller den, räknar nattjobbet ränta enligt räntelagen. En påminnelse lägger till den
              lagstadgade avgiften på 60 kr — en gång, garanterat av databasen.
            </Step>
            <Step n="3" title="Ta betalt, eller kreditera">
              Kunden betalar via Stripe; webhooken bokför betalningen exakt en gång. Blev det fel?
              En kreditfaktura upphäver allt och huvudboken summerar till noll.
            </Step>
          </ol>
        </div>
      </section>

      {/* ── Principles ──────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">Principer</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Fyra regler som varje CRUD-tutorial bryter.
            </h2>
            <p className="mt-4 text-lg text-slate-600">
              Alla 48 arkitekturbeslut finns nedskrivna, vart och ett med alternativet som valdes
              bort.
            </p>
            <a
              href={ADR_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex items-center gap-2 font-medium text-brand-600 hover:underline"
            >
              Läs besluten <Arrow />
            </a>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Principle code="amountOre: 9999" title="Pengar är heltal">
              Öre, inte kronor med decimaler. 0,1 + 0,2 blir inte 0,3 i flyttal, och ett
              faktureringssystem som tappar ett öre per rad tappar riktiga pengar.
            </Principle>
            <Principle code="type: 'CREDIT_NOTE_ISSUED'" title="Historik skrivs aldrig om">
              Transaktioner och revisionslogg är append-only. En rättelse är en ny rad med negativt
              belopp, aldrig en ändring.
            </Principle>
            <Principle code="401 · 'Ogiltig e-post eller lösenord'" title="Alla autentiseringsfel ser likadana ut">
              Fel lösenord, okänd e-post och låst konto: samma svar, samma tid. Annars går kundlistan
              att räkna upp.
            </Principle>
            <Principle code="WHERE status IN ('SENT','OVERDUE')" title="Idempotens i databasen">
              Statusvillkoret ligger i UPDATE-satsen, inte i en kontroll före. Två klick samtidigt kan
              inte båda lyckas.
            </Principle>
          </div>
        </div>
      </section>

      {/* ── Architecture ────────────────────────────────────── */}
      <section id="arkitektur" className="grid-paper bg-ink-950 text-white">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="grid gap-12 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wider text-brand-200">Arkitektur</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Varje lager anropar bara lagret under sig.</h2>
              <p className="mt-4 text-lg text-slate-400">
                Affärslogiken vet inget om HTTP. Det är därför nattjobbet, demo-seeden och API:et kör
                exakt samma kod — och därför den går att testa utan att mocka något.
              </p>
              <div className="mt-8 flex flex-wrap gap-2 text-xs text-slate-300">
                {['Bun', 'Fastify 5', 'TypeScript strict', 'Prisma 7', 'PostgreSQL 16', 'Redis 7', 'BullMQ', 'Stripe', 'Argon2id', 'Zod', 'React 19', 'Tailwind 4', 'Playwright'].map((item) => (
                  <span key={item} className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{item}</span>
                ))}
              </div>
              <div className="mt-8 flex flex-wrap gap-6 text-sm">
                <a href={API_DOCS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-brand-200 hover:underline">
                  API-referens <Arrow />
                </a>
                <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-brand-200 hover:underline">
                  Källkod <Arrow />
                </a>
              </div>
            </div>

            <ol className="space-y-2 font-mono text-sm">
              {[
                ['rate limiter', 'per IP och per konto, i Redis'],
                ['zod', 'validerar formen — aldrig totaler från klienten'],
                ['authenticate → authorize', 'vem är du → får du'],
                ['controller', 'läser request, formar svar'],
                ['service', 'affärsregler, transaktioner, revisionslogg'],
                ['repository', 'bara databasfrågor'],
                ['postgres', 'fakturor · huvudbok · revisionslogg']
              ].map(([layer, note], i, all) => (
                <li key={layer} className="relative flex items-center gap-4 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
                  <span className="w-6 text-xs text-slate-500">{String(i + 1).padStart(2, '0')}</span>
                  <span className="font-semibold text-white">{layer}</span>
                  <span className="ml-auto hidden text-xs text-slate-400 sm:block">{note}</span>
                  {i < all.length - 1 && <span className="absolute -bottom-3 left-7 text-slate-600">↓</span>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ── CTA + footer ────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-24 text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Prova det. Bryt det. Det återställs i natt.</h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-slate-600">
          Logga in som administratör, skicka en påminnelse, kreditera en faktura och läs huvudboken.
          Allt du gör försvinner klockan tre.
        </p>
        <div className="mx-auto mt-8 max-w-md">
          {demo.data ? <DemoLogins /> : <Link to="/login"><Button>Logga in</Button></Link>}
        </div>
      </section>

      <footer className="border-t border-slate-100">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-6 py-10 text-sm text-slate-500 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <Logo tone="dark" />
            <span className="text-slate-300">·</span>
            <span>Ett studieprojekt i att göra finansiell mjukvara rätt.</span>
          </div>
          <p>
            Byggt av <span className="font-medium text-slate-700">Devinder Singh</span>, Chas Academy Stockholm.
          </p>
        </div>
      </footer>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Hero: a real-looking invoice whose ledger writes itself in
// ─────────────────────────────────────────────────────────────

const HERO_LEDGER = [
  { at: '24 jul', label: 'Faktura utfärdad', amount: 5_075_000 },
  { at: '24 aug', label: 'Dröjsmålsränta, 12 dagar', amount: 16_685 },
  { at: '04 sep', label: 'Påminnelseavgift', amount: 6_000 },
  { at: '04 sep', label: 'Krediterad genom 2026-0023', amount: -5_075_000 },
  { at: '04 sep', label: 'Ränta avskriven', amount: -16_685 },
  { at: '04 sep', label: 'Avgift avskriven', amount: -6_000 }
]

function HeroInvoice() {
  const balance = HERO_LEDGER.reduce((sum, row) => sum + row.amount, 0)

  return (
    <div className="relative">
      {/* The card behind, for depth. */}
      <div className="absolute inset-0 translate-x-4 translate-y-4 rounded-2xl bg-white/5" aria-hidden />

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white text-slate-900 shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Faktura</p>
            <p className="text-lg font-bold">2026-0018</p>
          </div>
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">Krediterad</span>
        </div>

        <div className="grid grid-cols-2 gap-4 px-6 py-4 text-sm">
          <div>
            <p className="text-slate-500">Nordström Bygg AB</p>
            <p className="text-slate-500">Industrivägen 14, Huddinge</p>
          </div>
          <dl className="text-right">
            <div className="flex justify-between gap-3"><dt className="text-slate-500">Netto</dt><dd className="tabular">42 200,00</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-slate-500">Moms 25 %</dt><dd className="tabular">8 550,00</dd></div>
            <div className="flex justify-between gap-3 font-semibold"><dt>Summa</dt><dd className="tabular">50 750,00 SEK</dd></div>
          </dl>
        </div>

        <div className="border-t border-slate-100 bg-slate-50 px-6 py-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Huvudbok</p>
          <ul className="space-y-2 text-sm">
            {HERO_LEDGER.map((row, i) => (
              <li
                key={row.label}
                className="ledger-row flex items-baseline gap-3"
                style={{ animationDelay: `${600 + i * 350}ms` }}
              >
                <span className="w-12 shrink-0 text-xs text-slate-400">{row.at}</span>
                <span className="truncate text-slate-700">{row.label}</span>
                <span className={`tabular ml-auto shrink-0 font-medium ${row.amount < 0 ? 'text-amber-700' : 'text-slate-900'}`}>
                  {formatOre(row.amount, '').trim()}
                </span>
              </li>
            ))}
            <li
              className="ledger-row flex items-baseline gap-3 border-t border-slate-200 pt-2 font-semibold"
              style={{ animationDelay: `${600 + HERO_LEDGER.length * 350 + 200}ms` }}
            >
              <span className="w-12 shrink-0" />
              <span>Utestående</span>
              <span className="tabular ml-auto text-mint-600">{formatOre(balance)}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}

function HeroStat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dt className="tabular text-2xl font-bold text-white">{value}</dt>
      <dd className="mt-1 text-xs text-slate-400">{label}</dd>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Feature tiles and their small visuals
// ─────────────────────────────────────────────────────────────

function Tile({
  eyebrow,
  title,
  className = '',
  children
}: {
  eyebrow: string
  title: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-7 shadow-sm ${className}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">{eyebrow}</p>
      <h3 className="mt-2 text-xl font-semibold tracking-tight">{title}</h3>
      <div className="mt-3 space-y-3">{children}</div>
    </div>
  )
}

function CreditNoteVisual() {
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
      <MiniDoc number="2026-0018" status="Krediterad" tone="amber" amount="50 750,00" />
      <span className="hidden text-slate-300 sm:block">→</span>
      <MiniDoc number="2026-0023" status="Kreditfaktura" tone="violet" amount="−50 750,00" />
    </div>
  )
}

function MiniDoc({ number, status, tone, amount }: { number: string; status: string; tone: 'amber' | 'violet'; amount: string }) {
  const pill = tone === 'amber' ? 'bg-amber-100 text-amber-900' : 'bg-violet-100 text-violet-900'
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{number}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${pill}`}>{status}</span>
      </div>
      <p className="tabular mt-3 text-lg font-semibold">{amount} <span className="text-xs font-normal text-slate-500">SEK</span></p>
    </div>
  )
}

function VatVisual() {
  const rows = [
    ['Konsult', '25 %', '25 000,00'],
    ['Handbok', '6 %', '4 482,00'],
    ['Utbildning', '0 %', '0,00']
  ]
  return (
    <table className="mt-2 w-full text-sm">
      <tbody className="divide-y divide-slate-100">
        {rows.map(([name, rate, vat]) => (
          <tr key={name}>
            <td className="py-2 text-slate-700">{name}</td>
            <td className="py-2 text-right text-slate-500">{rate}</td>
            <td className="tabular py-2 text-right font-medium">{vat}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function InterestVisual() {
  const bars = [4, 6, 9, 12, 15, 19, 24]
  return (
    <div className="mt-4 flex h-16 items-end gap-1.5" aria-hidden>
      {bars.map((h, i) => (
        <div key={i} className="flex-1 rounded-t bg-gradient-to-t from-brand-600 to-brand-400" style={{ height: `${h * 4}%` }} />
      ))}
    </div>
  )
}

function AgingVisual() {
  const buckets = [
    ['Ej förfallet', 34_975_60, 'bg-slate-300'],
    ['1–30', 27_184_93, 'bg-brand-400'],
    ['31–60', 15_228_49, 'bg-brand-600'],
    ['> 60', 0, 'bg-red-500']
  ] as const
  const total = buckets.reduce((n, b) => n + b[1], 0)
  return (
    <div className="mt-5">
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        {buckets.map(([label, value, color]) => (
          <div key={label} className={color} style={{ width: `${(value / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
        {buckets.map(([label, , color]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${color}`} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
      <span className="tabular inline-flex h-9 w-9 items-center justify-center rounded-full bg-ink-950 text-sm font-semibold text-white">
        {n}
      </span>
      <h3 className="mt-5 text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{children}</p>
    </li>
  )
}

function Principle({ code, title, children }: { code: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 p-6">
      <code className="inline-block max-w-full truncate rounded-md bg-ink-950 px-2 py-1 font-mono text-[11px] text-slate-100">
        {code}
      </code>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{children}</p>
    </div>
  )
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8h10m0 0L9 4m4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
