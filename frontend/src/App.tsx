// App.tsx — the route table.

import { Routes, Route, Navigate } from 'react-router-dom'
import { RequireAuth } from './components/RequireAuth.tsx'
import { AppLayout } from './components/AppLayout.tsx'
import { useAuth } from './lib/auth.tsx'
import { LandingPage } from './pages/LandingPage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { SetPasswordPage } from './pages/SetPasswordPage.tsx'
import { DashboardPage } from './pages/admin/DashboardPage.tsx'
import { ClientsPage } from './pages/admin/ClientsPage.tsx'
import { ReportsPage } from './pages/admin/ReportsPage.tsx'
import { AuditLogPage } from './pages/admin/AuditLogPage.tsx'
import { AdminInvoicesPage } from './pages/admin/AdminInvoicesPage.tsx'
import { NewInvoicePage } from './pages/admin/NewInvoicePage.tsx'
import { InvoiceDetailPage } from './pages/InvoiceDetailPage.tsx'
import { ClientInvoicesPage } from './pages/client/ClientInvoicesPage.tsx'

/**
 * Sends each role to its own start page.
 *
 * An admin lands on the dashboard; a client lands on their invoices, which
 * is the only thing they came for.
 */
function HomeRedirect() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return <Navigate to={user.role === 'ADMIN' ? '/dashboard' : '/invoices'} replace />
}

export function App() {
  return (
    <Routes>
      {/*
        Public. The landing page is the root: it is what a link in a CV or
        a search result should open, and it works whether or not you are
        logged in. The app itself lives under its own paths.
      */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />

      {/* Authenticated */}
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/app" element={<HomeRedirect />} />

        {/* Admin only */}
        <Route
          path="/dashboard"
          element={
            <RequireAuth role="ADMIN">
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/clients"
          element={
            <RequireAuth role="ADMIN">
              <ClientsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/reports"
          element={
            <RequireAuth role="ADMIN">
              <ReportsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/audit"
          element={
            <RequireAuth role="ADMIN">
              <AuditLogPage />
            </RequireAuth>
          }
        />
        <Route
          path="/invoices/new"
          element={
            <RequireAuth role="ADMIN">
              <NewInvoicePage />
            </RequireAuth>
          }
        />

        {/*
          Both roles, different data. The API scopes the query by role, so a
          client's list contains only their own invoices — the frontend does
          not filter, and could not be trusted to.
        */}
        <Route path="/invoices" element={<InvoicesRoute />} />
        <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

/** Same URL, different screen per role. */
function InvoicesRoute() {
  const { user } = useAuth()
  return user?.role === 'ADMIN' ? <AdminInvoicesPage /> : <ClientInvoicesPage />
}
