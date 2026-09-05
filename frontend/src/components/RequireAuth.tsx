// RequireAuth.tsx — route guards.
//
// IMPORTANT: this is a USABILITY control, not a security one.
//
// Everything here runs in the browser, where the user can edit it. A guard
// stops someone accidentally landing on a page they cannot use; it does not
// stop a determined person from rendering it. The API is what protects the
// data — every endpoint checks the token and the role again, and the
// ownership checks make a client's invoice unreachable regardless of what
// the frontend believes.
//
// Worth being clear about, because "the frontend hides the admin button" is
// a sentence that has preceded a great many breaches.

import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth.tsx'
import type { Role } from '../lib/types.ts'

export function RequireAuth({
  children,
  role
}: {
  children: ReactNode
  /** When set, only this role may see the route. */
  role?: Role
}) {
  const { user, isLoading, hasLoggedOut } = useAuth()
  const location = useLocation()

  // Render nothing while the initial refresh is still in flight. Redirecting
  // to /login here would flash the login page on every reload of an
  // authenticated session — the classic bug in this pattern.
  if (isLoading) {
    return <FullPageSpinner />
  }

  if (!user) {
    // `state` remembers where they were going, so login can send them back
    // rather than dumping everyone on the dashboard. Not after a deliberate
    // logout: the next login may be a different person, and "return to the
    // invoice the previous user was reading" is not a feature.
    return (
      <Navigate
        to="/login"
        replace
        state={hasLoggedOut ? undefined : { from: location.pathname }}
      />
    )
  }

  if (role && user.role !== role) {
    // Their own start page, not a 403 screen. They are logged in and fine —
    // they simply took a wrong turn.
    return <Navigate to={user.role === 'ADMIN' ? '/dashboard' : '/invoices'} replace />
  }

  return <>{children}</>
}

/** Shown only while the session is being restored. */
export function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"
        role="status"
        aria-label="Laddar"
      />
    </div>
  )
}
