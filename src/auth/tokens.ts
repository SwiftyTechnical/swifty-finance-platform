// Single source of truth for auth token storage, shared by the React auth
// context and the API client so both read/write the same localStorage entry.

export interface Tokens {
  accessToken: string
  idToken: string
  refreshToken?: string
  expiresIn?: number
}

const TOKEN_KEY = 'swifty_tokens'

export function loadTokens(): Tokens | null {
  try {
    const stored = localStorage.getItem(TOKEN_KEY)
    return stored ? (JSON.parse(stored) as Tokens) : null
  } catch {
    return null
  }
}

export function saveTokens(tokens: Tokens | null) {
  if (tokens) {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens))
  } else {
    localStorage.removeItem(TOKEN_KEY)
  }
}
