import { ApiConnection, AppState, ExpenseLine, RevenueOperator, ExpenseAssignment, NonGbpCurrency, Territory } from './types'
import { loadTokens, saveTokens } from './auth/tokens'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

// All data routes are protected by Cognito auth on the server. This wrapper
// attaches the current access token and, on a 401, transparently refreshes the
// token once and retries the request. Uses window.fetch internally so the call
// sites below can route through apiFetch without self-recursion.
async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const tokens = loadTokens()
  const headers: Record<string, string> = { ...(options.headers as Record<string, string>) }
  if (tokens?.accessToken) headers.Authorization = `Bearer ${tokens.accessToken}`

  let res = await window.fetch(url, { ...options, headers })

  if (res.status === 401 && tokens?.refreshToken) {
    const refresh = await window.fetch('/api/auth/refresh', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    })
    if (refresh.ok) {
      const data = await refresh.json()
      const updated = {
        ...tokens,
        accessToken: data.tokens.accessToken,
        idToken: data.tokens.idToken,
        expiresIn: data.tokens.expiresIn,
      }
      saveTokens(updated)
      headers.Authorization = `Bearer ${updated.accessToken}`
      res = await window.fetch(url, { ...options, headers })
    } else {
      saveTokens(null)
    }
  }

  return res
}

export async function fetchState(): Promise<AppState> {
  const res = await apiFetch('/api/state')
  if (!res.ok) throw new Error(`GET /api/state ${res.status}`)
  return res.json()
}

export async function seedState(snapshot: Partial<AppState>): Promise<{ seeded: boolean }> {
  const res = await apiFetch('/api/state/seed', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(snapshot),
  })
  if (res.status === 409) return { seeded: false }
  if (!res.ok) throw new Error(`seed failed ${res.status}`)
  return { seeded: true }
}

export async function pushExpenses(
  expenses: ExpenseLine[],
  excelFileName?: string,
  lastImportedAt?: string,
) {
  await apiFetch('/api/expenses', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ expenses, excelFileName, lastImportedAt }),
  })
}

export async function createManualExpense(line: ExpenseLine) {
  await apiFetch('/api/expenses/manual', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(line),
  })
}

export async function patchExpense(id: string, patch: Partial<ExpenseLine>) {
  await apiFetch(`/api/expenses/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
}

export async function removeExpense(id: string) {
  await apiFetch(`/api/expenses/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function putAssignment(id: string, assignment: ExpenseAssignment) {
  await apiFetch(`/api/assignments/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(assignment),
  })
}

export async function bulkAssignments(
  patches: {
    id: string
    classification: ExpenseAssignment['classification']
    group?: string
    currencyOverride?: ExpenseAssignment['currencyOverride']
    territoryId?: ExpenseAssignment['territoryId']
  }[],
) {
  await apiFetch('/api/assignments/bulk', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ patches }),
  })
}

export async function createOperator(op: RevenueOperator) {
  await apiFetch('/api/operators', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(op),
  })
}

export async function patchOperator(id: string, patch: Partial<RevenueOperator>) {
  await apiFetch(`/api/operators/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
}

export async function deleteOperator(id: string) {
  await apiFetch(`/api/operators/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function reorderOperators(ids: string[]) {
  await apiFetch('/api/operators/reorder', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids }),
  })
}

export async function putFxRate(currency: NonGbpCurrency, rate: number) {
  await apiFetch(`/api/fx/${currency}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ rate }),
  })
}


export async function createCustomGroup(name: string) {
  await apiFetch('/api/groups', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  })
}

export async function renameCustomGroup(oldName: string, newName: string) {
  await apiFetch(`/api/groups/${encodeURIComponent(oldName)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: newName }),
  })
}

export async function deleteCustomGroup(name: string) {
  await apiFetch(`/api/groups/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function createTerritory(t: Territory) {
  await apiFetch('/api/territories', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(t),
  })
}

export async function patchTerritory(id: string, patch: Partial<Territory>) {
  await apiFetch(`/api/territories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
}

export async function removeTerritory(id: string) {
  await apiFetch(`/api/territories/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export type BillingSource = 'billing' | 'gateway'

export interface BillingMonth {
  month: string
  monthIndex: number
  from: string
  to: string
  ok: boolean
  status: number
  data?: unknown
  error?: string
  fetchedAt?: string | null
}

export interface BillingMonthlyResponse {
  year: string
  connectionId: string
  sources: Record<BillingSource, BillingMonth[]>
}

export interface RefreshSummaryItem {
  source: BillingSource
  month: string
  monthIndex: number
  ok: boolean
  status: number
  error?: string
}

export interface RefreshResponse {
  year: string
  connectionId: string
  refreshed: RefreshSummaryItem[]
}

export async function listConnections(): Promise<ApiConnection[]> {
  const res = await apiFetch('/api/connections')
  if (!res.ok) throw new Error(`GET /api/connections ${res.status}`)
  const body = await res.json()
  return body.connections ?? []
}

export async function createConnection(input: {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  clientId?: string
}) {
  const res = await apiFetch('/api/connections', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `create failed ${res.status}`)
  }
}

export async function patchConnection(
  id: string,
  patch: { name?: string; baseUrl?: string; apiKey?: string; clientId?: string },
) {
  await apiFetch(`/api/connections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
}

export async function deleteConnection(id: string) {
  await apiFetch(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function testConnection(id: string) {
  const res = await apiFetch(`/api/connections/${encodeURIComponent(id)}/test`, { method: 'POST' })
  return res.json() as Promise<{ ok: boolean; status: number; data?: unknown; error?: string; url?: string }>
}

export async function fetchBillingMonthly(id: string, year: string): Promise<BillingMonthlyResponse> {
  const res = await apiFetch(
    `/api/connections/${encodeURIComponent(id)}/billing/monthly?year=${encodeURIComponent(year)}`,
  )
  if (!res.ok) throw new Error(`billing/monthly ${res.status}`)
  return res.json()
}

export async function refreshBilling(
  id: string,
  opts: { year: string; month?: number; source?: BillingSource | 'all' },
): Promise<RefreshResponse> {
  const params = new URLSearchParams({ year: opts.year })
  if (opts.month !== undefined) params.set('month', String(opts.month))
  if (opts.source) params.set('source', opts.source)
  const res = await apiFetch(
    `/api/connections/${encodeURIComponent(id)}/billing/refresh?${params.toString()}`,
    { method: 'POST' },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `refresh ${res.status}`)
  }
  return res.json()
}
