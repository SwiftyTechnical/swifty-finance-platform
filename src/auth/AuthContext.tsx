import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react'
import { loadTokens, saveTokens, type Tokens } from './tokens'

interface AuthUser {
  email: string
  groups: string[]
}

interface AuthContextValue {
  tokens: Tokens | null
  user: AuthUser | null
  isAuthenticated: boolean
  loading: boolean
  login: (tokens: Tokens) => void
  logout: () => Promise<void>
  refresh: () => Promise<boolean>
  authFetch: (url: string, options?: RequestInit) => Promise<Response>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens] = useState<Tokens | null>(loadTokens)
  const [loading, setLoading] = useState(true)

  const isAuthenticated = !!tokens?.accessToken

  const user: AuthUser | null = (() => {
    if (!tokens?.idToken) return null
    try {
      const payload = JSON.parse(atob(tokens.idToken.split('.')[1]))
      return { email: payload.email || payload.sub, groups: payload['cognito:groups'] || [] }
    } catch {
      return null
    }
  })()

  const logout = useCallback(async () => {
    if (tokens?.accessToken) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: tokens.accessToken }),
        })
      } catch {
        // ignore
      }
    }
    setTokens(null)
    saveTokens(null)
  }, [tokens])

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!tokens?.refreshToken) {
      setLoading(false)
      return false
    }

    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      })

      if (!res.ok) {
        setTokens(null)
        saveTokens(null)
        setLoading(false)
        return false
      }

      const data = await res.json()
      const updated: Tokens = {
        ...tokens,
        accessToken: data.tokens.accessToken,
        idToken: data.tokens.idToken,
        expiresIn: data.tokens.expiresIn,
      }
      setTokens(updated)
      saveTokens(updated)
      setLoading(false)
      return true
    } catch {
      setTokens(null)
      saveTokens(null)
      setLoading(false)
      return false
    }
  }, [tokens])

  // Validate token on mount
  useEffect(() => {
    if (!tokens?.accessToken) {
      setLoading(false)
      return
    }

    fetch('/api/health', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
      .then((res) => {
        if (res.status === 401) {
          refresh()
        } else {
          setLoading(false)
        }
      })
      .catch(() => {
        setLoading(false)
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback((newTokens: Tokens) => {
    setTokens(newTokens)
    saveTokens(newTokens)
  }, [])

  const authFetch = useCallback(
    async (url: string, options: RequestInit = {}) => {
      if (!tokens?.accessToken) throw new Error('Not authenticated')

      const headers: Record<string, string> = {
        ...(options.headers as Record<string, string>),
        Authorization: `Bearer ${tokens.accessToken}`,
      }

      let res = await fetch(url, { ...options, headers })

      if (res.status === 401 && tokens.refreshToken) {
        const refreshed = await refresh()
        if (refreshed) {
          const updatedTokens = loadTokens()
          if (updatedTokens) {
            headers.Authorization = `Bearer ${updatedTokens.accessToken}`
            res = await fetch(url, { ...options, headers })
          }
        }
      }

      return res
    },
    [tokens, refresh]
  )

  return (
    <AuthContext.Provider
      value={{
        tokens,
        user,
        isAuthenticated,
        loading,
        login,
        logout,
        refresh,
        authFetch,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
