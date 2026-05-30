import { ApiConnection, AppState, ExpenseLine, RevenueOperator, ExpenseAssignment, NonGbpCurrency, Territory } from './types'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export async function fetchState(): Promise<AppState> {
  const res = await fetch('/api/state')
  if (!res.ok) throw new Error(`GET /api/state ${res.status}`)
  return res.json()
}

export async function seedState(snapshot: Partial<AppState>): Promise<{ seeded: boolean }> {
  const res = await fetch('/api/state/seed', {
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
  await fetch('/api/expenses', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ expenses, excelFileName, lastImportedAt }),
  })
}

export async function createManualExpense(line: ExpenseLine) {
  await fetch('/api/expenses/manual', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(line),
  })
}

export async function patchExpense(id: string, patch: Partial<ExpenseLine>) {
  await fetch(`/api/expenses/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
}

export async function removeExpense(id: string) {
  await fetch(`/api/expenses/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function putAssignment(id: string, assignment: ExpenseAssignment) {
  await fetch(`/api/assignments/${encodeURIComponent(id)}`, {
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
  await fetch('/api/assignments/bulk', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ patches }),
  })
}

export async function createOperator(op: RevenueOperator) {
  await fetch('/api/operators', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(op),
  })
}

export async function patchOperator(id: string, patch: Partial<RevenueOperator>) {
  await fetch(`/api/operators/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
}

export async function deleteOperator(id: string) {
  await fetch(`/api/operators/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function reorderOperators(ids: string[]) {
  await fetch('/api/operators/reorder', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids }),
  })
}

export async function putFxRate(currency: NonGbpCurrency, rate: number) {
  await fetch(`/api/fx/${currency}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ rate }),
  })
}

export async function resetServer() {
  await fetch('/api/reset', { method: 'POST' })
}

export async function createCustomGroup(name: string) {
  await fetch('/api/groups', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  })
}

export async function renameCustomGroup(oldName: string, newName: string) {
  await fetch(`/api/groups/${encodeURIComponent(oldName)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: newName }),
  })
}

export async function deleteCustomGroup(name: string) {
  await fetch(`/api/groups/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function createTerritory(t: Territory) {
  await fetch('/api/territories', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(t),
  })
}

export async function patchTerritory(id: string, patch: Partial<Territory>) {
  await fetch(`/api/territories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
}

export async function removeTerritory(id: string) {
  await fetch(`/api/territories/${encodeURIComponent(id)}`, { method: 'DELETE' })
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
  const res = await fetch('/api/connections')
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
  const res = await fetch('/api/connections', {
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
  await fetch(`/api/connections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
}

export async function deleteConnection(id: string) {
  await fetch(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function testConnection(id: string) {
  const res = await fetch(`/api/connections/${encodeURIComponent(id)}/test`, { method: 'POST' })
  return res.json() as Promise<{ ok: boolean; status: number; data?: unknown; error?: string; url?: string }>
}

export async function fetchBillingMonthly(id: string, year: string): Promise<BillingMonthlyResponse> {
  const res = await fetch(
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
  const res = await fetch(
    `/api/connections/${encodeURIComponent(id)}/billing/refresh?${params.toString()}`,
    { method: 'POST' },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `refresh ${res.status}`)
  }
  return res.json()
}
