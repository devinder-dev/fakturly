// LandingPage.tsx — the public front door.
//
// The only page anyone sees without logging in. Its job is to let a visitor
// understand what Fakturly is in thirty seconds and try it in one click,
// which is why the demo buttons sit in the hero rather than behind a login.
//
// Everything on it is static except the demo accounts, which come from the
// API and disappear when the API is not in demo mode.

import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth.tsx'
import { Button } from '../components/ui.tsx'
import { DemoLogins, useDemoAccounts } from '../components/DemoLogins.tsx'

const GITHUB_URL = 'https://github.com/devinder-dev/fakturly'
const ADR_URL = `${GITHUB_URL}/blob/main/docs/architecture-decisions.md`

export function LandingPage() {
  const { user } = useAuth()
  const demo = useDemoAccounts()

  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* ── Nav ─────────────────────────────────────────────── */}
      <header className="border-b border-slate-100">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <span className="text-lg font-semibold">Fakturly</span>
          <nav className="flex items-center gap-6 text-sm">
            <a href="#funktioner" className="hidden text-slate-600 hover:text-slate-900 sm:block">
              Funktioner
            </a>
            <a href="#arkitektur" className="hidden text-slate-600 hover:text-slate-900 sm:block">
              Arkitektur
            </a>
            <a href={GITHUB_URL} className="text-slate-600 hover:text-slate-900" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <Link to={user ? '/app' : '/login'}>
              <Button variant="secondary">{user ? 'Till appen' : 'Logga in'}</Button>
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-20 sm:pt-28">
        <div className="max-w-3xl">
          <p className="mb-4 text-sm font-medium uppercase tracking-wide text-brand-600">
            Fakturering för småföretag
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Fakturering byggd som ett finansiellt system, inte som en CRUD-app.
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-slate-600">
            Fakturor med moms per rad, obruten nummerserie, Stripe-betalningar, lagstadgad
            dröjsmålsränta och en huvudbok som aldrig skrivs om. Två portaler: en för den som
            fakturerar och en för den som betalar.
          </p>

          <div className="mt-10 max-w-md">
            {demo.data ? (
              <DemoLogins />
            ) : (
              <Link to="/login">
                <Button>Logga in</Button>
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* ── Three principles ────────────────────────────────── */}
      <section className="border-y border-slate-100 bg-slate-50">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 md:grid-cols-3">
          <Principle
            title="Pengar är heltal"
            code="amount: 9999  // 99,99 SEK"
            text="Varje belopp lagras i öre. Flyttal tappar ören; heltal gör det aldrig. Konvertering till kronor sker på en enda plats, vid visning."
          />
          <Principle
            title="Historik skrivs aldrig om"
            code="type: 'ADJUSTMENT', amountOre: -500"
            text="Transaktioner och revisionsloggen är append-only. En rättelse är en ny rad med negativt belopp, aldrig en ändring av en gammal."
          />
          <Principle
            title="Fel läcker ingenting"
            code="404  // inte 403"
            text="Någon annans faktura ser ut som en som aldrig funnits. Fel lösenord, okänd e-post och låst konto ger samma svar, på samma tid."
          />
        </div>
      </section>

      {/* ── Features ────────────────────────────────────────── */}
      <section id="funktioner" className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="text-2xl font-semibold">Vad systemet gör</h2>
        <p className="mt-2 max-w-2xl text-slate-600">
          Hela flödet från kund till betald faktura, med det som svensk bokföring faktiskt kräver.
        </p>

        <div className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          <Feature
            title="Fakturor som håller för Skatteverket"
            text="Moms per rad med blandade satser, avrundning per rad, netto/moms/brutto redovisat separat och en obruten nummerserie per år."
          />
          <Feature
            title="PDF med OCR-referens"
            text="Ett dokument med allt lagen kräver: organisationsnummer, momsregistreringsnummer, F-skatt, betalningsuppgifter och ett OCR-nummer banken kan kontrollera."
          />
          <Feature
            title="Stripe-betalning med idempotens"
            text="Kunden betalar via en hostad sida. Webhooken verifieras kryptografiskt och samma betalning kan aldrig bokföras två gånger, hur många gånger Stripe än skickar den."
          />
          <Feature
            title="Dröjsmålsränta enligt räntelagen"
            text="Referensränta plus åtta procentenheter, beräknad per dag av ett nattligt jobb med retry-logik. Varje dags ränta är en egen rad i huvudboken."
          />
          <Feature
            title="Kundportal"
            text="Kunden ser sina egna fakturor, status och kan ladda ner PDF. Bara sina egna: urvalet görs i databasfrågan, inte i webbläsaren."
          />
          <Feature
            title="Revisionslogg"
            text="Varje inloggning, faktura, betalning och misslyckat försök loggas med IP och tidpunkt, i en separat transaktion som överlever en rollback."
          />
        </div>
      </section>

      {/* ── Architecture ────────────────────────────────────── */}
      <section id="arkitektur" className="border-t border-slate-100 bg-slate-950 text-slate-100">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <h2 className="text-2xl font-semibold">Hur en förfrågan går</h2>
          <p className="mt-2 max-w-2xl text-slate-400">
            Varje lager får bara anropa lagret under sig. Affärslogiken vet inget om HTTP, vilket
            är det som låter samma kod köras från ett bakgrundsjobb.
          </p>

          <ol className="mt-10 flex flex-wrap items-center gap-2 font-mono text-sm">
            {[
              'rate limiter',
              'zod',
              'route',
              'authenticate',
              'authorize',
              'controller',
              'service',
              'repository',
              'postgres'
            ].map((layer, index, all) => (
              <li key={layer} className="flex items-center gap-2">
                <span className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5">
                  {layer}
                </span>
                {index < all.length - 1 && <span className="text-slate-600">→</span>}
              </li>
            ))}
          </ol>

          <dl className="mt-14 grid gap-8 sm:grid-cols-3">
            <Metric value="350+" label="tester mot riktig PostgreSQL och Redis, i CI vid varje push" />
            <Metric value="35" label="dokumenterade arkitekturbeslut, med det alternativ som valdes bort" />
            <Metric value="0" label="flyttal i någon beräkning som rör pengar" />
          </dl>

          <div className="mt-14 flex flex-wrap gap-2 text-xs text-slate-400">
            {['Bun', 'Fastify 5', 'TypeScript strict', 'Prisma 7', 'PostgreSQL 16', 'Redis 7', 'BullMQ', 'Stripe', 'Argon2id', 'Zod', 'React 19', 'Tailwind 4'].map((item) => (
              <span key={item} className="rounded-full border border-slate-800 px-3 py-1">
                {item}
              </span>
            ))}
          </div>

          <div className="mt-10 flex flex-wrap gap-4 text-sm">
            <a href={ADR_URL} className="text-brand-100 underline-offset-4 hover:underline" target="_blank" rel="noreferrer">
              Läs arkitekturbesluten
            </a>
            <a href={GITHUB_URL} className="text-brand-100 underline-offset-4 hover:underline" target="_blank" rel="noreferrer">
              Källkoden på GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 py-10 text-sm text-slate-500 sm:flex-row sm:items-center">
        <p>
          Byggt av <span className="font-medium text-slate-700">Devinder Singh</span>, Fullstack Developer
          Open Source, Chas Academy Stockholm.
        </p>
        <p>Ett studieprojekt i att göra finansiell mjukvara rätt.</p>
      </footer>
    </div>
  )
}

function Principle({ title, code, text }: { title: string; code: string; text: string }) {
  return (
    <div>
      <code className="inline-block rounded bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100">
        {code}
      </code>
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
    </div>
  )
}

function Feature({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
    </div>
  )
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dt className="text-4xl font-semibold tabular">{value}</dt>
      <dd className="mt-2 text-sm text-slate-400">{label}</dd>
    </div>
  )
}
