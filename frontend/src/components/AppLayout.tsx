// AppLayout.tsx — the shell every authenticated page renders inside.
//
// A sidebar rather than a top bar. Finance software is used for hours at a
// time with many sections; a vertical list of sections with icons scans
// faster than a row of words, and it leaves the full width for tables.
//
// The navigation hides admin sections from clients for tidiness, not
// security. A client who types /reports is redirected by the route guard,
// and the API refuses them regardless.

import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth.tsx'
import { Logo } from './Logo.tsx'

type Item = { to: string; label: string; icon: React.ReactNode; admin?: boolean; end?: boolean }

const ITEMS: Item[] = [
  { to: '/dashboard', label: 'Översikt', icon: <IconGrid />, admin: true },
  { to: '/invoices', label: 'Fakturor', icon: <IconDoc />, end: true },
  { to: '/clients', label: 'Kunder', icon: <IconPeople />, admin: true },
  { to: '/reports', label: 'Rapporter', icon: <IconChart />, admin: true },
  { to: '/audit', label: 'Revisionslogg', icon: <IconShield />, admin: true }
]

export function AppLayout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const isAdmin = user?.role === 'ADMIN'

  async function handleLogout() {
    // Clearing the user is enough: the route guard around this layout sees
    // no user and redirects to /login itself. Navigating here as well would
    // race it.
    await logout()
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
    (isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white')

  return (
    <div className="min-h-screen bg-slate-50 font-sans antialiased lg:flex">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside className="flex items-center justify-between bg-ink-950 px-4 py-3 text-white lg:sticky lg:top-0 lg:h-screen lg:w-64 lg:flex-col lg:items-stretch lg:justify-start lg:px-4 lg:py-6">
        {/* The wordmark goes to the app's start page, not the public landing
            page — a logged-in user clicking the logo expects their own screen. */}
        <Link to="/app" className="lg:mb-8 lg:px-2">
          <Logo tone="light" />
        </Link>

        <nav className="flex gap-1 lg:flex-col" aria-label="Huvudmeny">
          {ITEMS.filter((item) => !item.admin || isAdmin).map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={linkClass}>
              <span className="hidden lg:inline">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden lg:mt-auto lg:block">
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="truncate text-sm font-medium text-white">{user?.email}</p>
            <p className="text-xs text-slate-400">{isAdmin ? 'Administratör' : 'Kund'}</p>
            <button
              type="button"
              onClick={handleLogout}
              className="mt-3 w-full rounded-lg border border-white/15 px-3 py-1.5 text-sm text-slate-200 transition hover:bg-white/10"
            >
              Logga ut
            </button>
          </div>
          {isAdmin && (
            <p className="mt-4 px-2 text-[11px] leading-relaxed text-slate-500">
              Demodata. Återställs varje natt kl 03:00.
            </p>
          )}
        </div>

        <button type="button" onClick={handleLogout} className="text-sm text-slate-300 lg:hidden">
          Logga ut
        </button>
      </aside>

      {/* ── Content ─────────────────────────────────────────── */}
      <main className="min-w-0 flex-1">
        <div key={location.pathname} className="rise mx-auto max-w-6xl px-6 py-8 lg:px-10 lg:py-10">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

// ── Icons: 20px, 1.5px stroke, hand-drawn so there is no icon package ──

function IconGrid() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="11" y="3" width="6" height="6" rx="1.5" />
      <rect x="3" y="11" width="6" height="6" rx="1.5" /><rect x="11" y="11" width="6" height="6" rx="1.5" />
    </svg>
  )
}
function IconDoc() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M5 3h7l4 4v10H5z" /><path d="M8 10h5M8 13h5" />
    </svg>
  )
}
function IconPeople() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <circle cx="8" cy="7" r="3" /><path d="M2.5 17c.6-3 3-4.5 5.5-4.5s4.9 1.5 5.5 4.5" /><path d="M13.5 4.5a3 3 0 0 1 0 5.5M17.5 17c-.4-2.2-1.7-3.6-3.5-4.2" />
    </svg>
  )
}
function IconChart() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M3 17h14" /><path d="M5 14v-4M9 14V6M13 14v-3M17 14V8" />
    </svg>
  )
}
function IconShield() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 2.5 4 5v5c0 3.5 2.5 6 6 7.5 3.5-1.5 6-4 6-7.5V5z" /><path d="m7.5 10 1.8 1.8L12.8 8" />
    </svg>
  )
}
