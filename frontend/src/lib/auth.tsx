// auth.tsx — who is logged in, and how that survives a page refresh.
//
// THE PROBLEM THIS SOLVES:
//
// The access token lives in memory, so pressing F5 loses it. That is the
// deliberate cost of keeping it out of localStorage, where any XSS could read
// it. The refresh token, meanwhile, is in an httpOnly cookie the browser
// keeps and page JavaScript cannot touch.
//
// So on every page load the app asks /auth/refresh first:
//
//   cookie still valid  -> new access token, straight back to where they were
//   cookie gone         -> show the login page
//
// Until that answer arrives we render NOTHING. Showing the login screen for
// half a second before redirecting to the dashboard is the flicker every
// app with this design has, and it is entirely avoidable.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode
} from 'react'
import { api, setAccessToken } from './api.ts'
import type { LoginResponse, User } from './types.ts'

type AuthState = {
  user: User | null
  /** True until the initial refresh attempt has settled. */
  isLoading: boolean
  /**
   * True after the user pressed "log out", until the next login.
   *
   * The route guard remembers where an unauthenticated visitor was heading
   * so login can send them back — right for an expired session or a deep
   * link, wrong after a deliberate logout, where the next person to log in
   * may be someone else entirely. This flag is how the guard tells the two
   * apart.
   */
  hasLoggedOut: boolean
  login: (email: string, password: string) => Promise<User>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasLoggedOut, setHasLoggedOut] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function restoreSession() {
      const refreshed = await api.refresh()

      if (cancelled) return

      if (!refreshed) {
        setIsLoading(false)
        return
      }

      // We have a token, but not the user. Ask the API rather than decoding
      // the JWT: the token carries only an id and a role by design, and
      // reading it fresh means a role changed five minutes ago is correct now.
      try {
        const data = await api.get<{ user: User }>('/auth/me')
        if (!cancelled) setUser(data.user)
      } catch {
        if (!cancelled) setAccessToken(null)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void restoreSession()

    // Guards against setting state after unmount, which React 19 still warns
    // about and which hides real bugs in development.
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<LoginResponse>('/auth/login', { email, password })
    setAccessToken(data.accessToken)
    setUser(data.user)
    setHasLoggedOut(false)
    return data.user
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout')
    } finally {
      // Clear local state even if the request failed. The user asked to log
      // out; leaving them looking logged in because the network hiccuped is
      // the wrong answer, and the server-side revocation can be retried.
      setAccessToken(null)
      setUser(null)
      setHasLoggedOut(true)
    }
  }, [])

  return (
    <AuthContext.Provider value={{ user, isLoading, hasLoggedOut, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)

  // A clear error beats `Cannot read properties of null`, which is what a
  // component rendered outside the provider would otherwise produce.
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider')
  }

  return context
}
