// main.tsx — mounts the app and wires the three providers it needs.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './lib/auth.tsx'
import { App } from './App.tsx'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * Do not retry a 4xx.
       *
       * TanStack Query retries failed queries by default, which is right for
       * a network blip and wrong for a 403 — the answer will not change, and
       * retrying just delays showing the user why. Only 5xx and network
       * errors are worth a second attempt.
       */
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status
        if (status !== undefined && status >= 400 && status < 500) return false
        return failureCount < 2
      },

      /**
       * Treat data as fresh for 30 seconds.
       *
       * Without this, every remount refetches — switching tabs, opening a
       * detail view and going back. Invoices do not change second to second,
       * and a list that flickers on every navigation feels broken.
       */
      staleTime: 30_000,
      refetchOnWindowFocus: false
    }
  }
})

const root = document.getElementById('root')
if (!root) throw new Error('#root not found in index.html')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* AuthProvider inside the router, because logout needs to navigate. */}
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
)
