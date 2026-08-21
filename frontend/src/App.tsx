// App.tsx — the route table.

import { Routes, Route, Navigate } from 'react-router-dom'
import { RequireAuth } from './components/RequireAuth.tsx'
import { AppLayout } from './components/AppLayout.tsx'
import { useAuth } from './lib/auth.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { SetPasswordPage } from './pages/SetPasswordPage.tsx'
import { ClientsPage } from './pages/admin/ClientsPage.tsx'
import { AdminInvoicesPage } from './pages/admin/AdminInvoicesPage.tsx'
import { NewInvoicePage } from './pages/admin/NewInvoicePage.tsx'
import { InvoiceDetailPage } from './pages/InvoiceDetailPage.tsx'
import { ClientInvoicesPage } from './pages/client/ClientInvoicesPage.tsx'

/**
 * Sends each role to its own start page.
 *
 * An admin lands on clients (their first action is usually adding one); a
 * client lands on their invoices, which is the only thing they came for.
 */
function HomeRedirect() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return <Navigate to={user.role === 'ADMIN' ? '/clients' : '/invoices'} replace />
}

export function App() {
  return (
    <Routes>
      {/* Public */}
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
        <Route path="/" element={<HomeRedirect />} />

        {/* Admin only */}
        <Route
          path="/clients"
          element={
            <RequireAuth role="ADMIN">
              <ClientsPage />
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
