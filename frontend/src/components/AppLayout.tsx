// AppLayout.tsx — the shell every authenticated page renders inside.

import { Link, NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth.tsx'
import { Button } from './ui.tsx'

export function AppLayout() {
  const { user, logout } = useAuth()

  async function handleLogout() {
    // Clearing the user is enough: the route guard around this layout sees
    // no user and redirects to /login itself. Navigating here as well would
    // race it.
    await logout()
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    'rounded-md px-3 py-2 text-sm font-medium transition-colors ' +
    (isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:text-slate-900')

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            {/* The wordmark goes to the app's start page, not the public
                landing page — a logged-in user clicking the logo expects
                their dashboard, not marketing. */}
            <Link to="/app" className="text-lg font-semibold text-slate-900">
              Fakturly
            </Link>

            <nav className="flex items-center gap-1">
              {/*
                The admin link is hidden from clients — for tidiness, not
                security. A client who types /clients gets redirected by the
                route guard, and the API refuses them regardless.
              */}
              {user?.role === 'ADMIN' && (
                <>
                  <NavLink to="/dashboard" className={navLinkClass}>
                    Översikt
                  </NavLink>
                  <NavLink to="/clients" className={navLinkClass}>
                    Kunder
                  </NavLink>
                </>
              )}
              <NavLink to="/invoices" className={navLinkClass} end>
                Fakturor
              </NavLink>
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-slate-900">{user?.email}</p>
              <p className="text-xs text-slate-500">
                {user?.role === 'ADMIN' ? 'Administratör' : 'Kund'}
              </p>
            </div>
            <Button variant="secondary" onClick={handleLogout}>
              Logga ut
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
