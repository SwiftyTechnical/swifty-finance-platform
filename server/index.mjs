import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getFullState,
  replaceExpenses,
  upsertAssignment,
  bulkUpsertAssignments,
  insertOperator,
  updateOperator,
  deleteOperator,
  setFxRate,
  replaceAllFromSnapshot,
  addCustomGroup,
  removeCustomGroup,
  renameCustomGroup,
  reorderOperators,
  insertManualExpense,
  updateManualExpense,
  deleteManualExpense,
  addTerritory,
  updateTerritory,
  deleteTerritory,
  listApiConnections,
  getApiConnectionWithKey,
  createApiConnection,
  updateApiConnection,
  deleteApiConnection,
  getBillingCacheForYear,
  upsertBillingCache,
  ensureSchema,
  pool,
} from './db.mjs'
import { authRouter, requireAuth, requireGroup } from './auth.mjs'

const app = express()
app.use(express.json({ limit: '10mb' }))

// Health check + auth routes are public; everything else under /api requires a
// valid Cognito access token whose user belongs to the FinanceAdmin group.
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
app.use('/api/auth', authRouter)
app.use('/api', requireAuth, requireGroup('FinanceAdmin'))

// Wraps an async route so an uncaught rejection turns into a 500 instead of an
// unhandled promise rejection.
const asyncRoute = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[route]', req.method, req.url, e)
    if (!res.headersSent) res.status(500).json({ error: e?.message ?? String(e) })
  })
}

app.get('/api/state', asyncRoute(async (_req, res) => {
  res.json(await getFullState())
}))

app.post('/api/state/seed', asyncRoute(async (req, res) => {
  const current = await getFullState()
  const hasData =
    current.expenses.length > 0 ||
    current.operators.length > 0 ||
    Object.keys(current.assignments).length > 0
  if (hasData) {
    return res.status(409).json({ seeded: false, reason: 'server already has data' })
  }
  await replaceAllFromSnapshot(req.body ?? {})
  res.json({ seeded: true, state: await getFullState() })
}))

app.put('/api/expenses', asyncRoute(async (req, res) => {
  const { expenses, excelFileName, lastImportedAt } = req.body ?? {}
  if (!Array.isArray(expenses)) return res.status(400).json({ error: 'expenses must be array' })
  await replaceExpenses(expenses, excelFileName, lastImportedAt)
  res.json({ ok: true })
}))

app.post('/api/expenses/manual', asyncRoute(async (req, res) => {
  const line = req.body
  if (!line?.id || !line?.name) return res.status(400).json({ error: 'id and name required' })
  await insertManualExpense(line)
  res.json({ ok: true })
}))

app.patch('/api/expenses/:id', asyncRoute(async (req, res) => {
  await updateManualExpense(req.params.id, req.body ?? {})
  res.json({ ok: true })
}))

app.delete('/api/expenses/:id', asyncRoute(async (req, res) => {
  await deleteManualExpense(req.params.id)
  res.json({ ok: true })
}))

app.put('/api/assignments/:id', asyncRoute(async (req, res) => {
  const { classification, group, currencyOverride, territoryId } = req.body ?? {}
  await upsertAssignment(
    req.params.id,
    classification ?? 'Unassigned',
    group ?? '',
    currencyOverride ?? null,
    territoryId ?? null,
  )
  res.json({ ok: true })
}))

app.post('/api/assignments/bulk', asyncRoute(async (req, res) => {
  const { patches } = req.body ?? {}
  if (!Array.isArray(patches)) return res.status(400).json({ error: 'patches must be array' })
  await bulkUpsertAssignments(patches)
  res.json({ ok: true })
}))

app.post('/api/operators', asyncRoute(async (req, res) => {
  const op = req.body
  if (!op?.id) return res.status(400).json({ error: 'id required' })
  await insertOperator(op)
  res.json({ ok: true })
}))

app.patch('/api/operators/:id', asyncRoute(async (req, res) => {
  await updateOperator(req.params.id, req.body ?? {})
  res.json({ ok: true })
}))

app.delete('/api/operators/:id', asyncRoute(async (req, res) => {
  await deleteOperator(req.params.id)
  res.json({ ok: true })
}))

app.post('/api/operators/reorder', asyncRoute(async (req, res) => {
  const ids = req.body?.ids
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be array' })
  await reorderOperators(ids)
  res.json({ ok: true })
}))

app.put('/api/fx/:currency', asyncRoute(async (req, res) => {
  const rate = Number(req.body?.rate)
  if (!Number.isFinite(rate)) return res.status(400).json({ error: 'rate must be number' })
  await setFxRate(req.params.currency, rate)
  res.json({ ok: true })
}))

app.post('/api/groups', asyncRoute(async (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'name required' })
  await addCustomGroup(name)
  res.json({ ok: true })
}))

app.patch('/api/groups/:name', asyncRoute(async (req, res) => {
  const newName = String(req.body?.name ?? '').trim()
  if (!newName) return res.status(400).json({ error: 'name required' })
  await renameCustomGroup(req.params.name, newName)
  res.json({ ok: true })
}))

app.delete('/api/groups/:name', asyncRoute(async (req, res) => {
  await removeCustomGroup(req.params.name)
  res.json({ ok: true })
}))

app.post('/api/territories', asyncRoute(async (req, res) => {
  const t = req.body
  if (!t?.id || !t?.name || !t?.currency) return res.status(400).json({ error: 'id, name, currency required' })
  await addTerritory(t)
  res.json({ ok: true })
}))

app.patch('/api/territories/:id', asyncRoute(async (req, res) => {
  await updateTerritory(req.params.id, req.body ?? {})
  res.json({ ok: true })
}))

app.delete('/api/territories/:id', asyncRoute(async (req, res) => {
  await deleteTerritory(req.params.id)
  res.json({ ok: true })
}))

// --- API connections (billing API keys) ---

app.get('/api/connections', asyncRoute(async (_req, res) => {
  res.json({ connections: await listApiConnections() })
}))

app.post('/api/connections', asyncRoute(async (req, res) => {
  const { id, name, baseUrl, apiKey, clientId } = req.body ?? {}
  if (!id || !name || !baseUrl || !apiKey) {
    return res.status(400).json({ error: 'id, name, baseUrl, apiKey required' })
  }
  try {
    await createApiConnection({ id, name, baseUrl, apiKey, clientId })
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  res.json({ ok: true })
}))

app.patch('/api/connections/:id', asyncRoute(async (req, res) => {
  await updateApiConnection(req.params.id, req.body ?? {})
  res.json({ ok: true })
}))

app.delete('/api/connections/:id', asyncRoute(async (req, res) => {
  await deleteApiConnection(req.params.id)
  res.json({ ok: true })
}))

const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL ?? 'https://gateway-api.nixxe.io'
const GATEWAY_MODE = process.env.GATEWAY_MODE ?? 'prod'

function buildUrl(baseUrl, path) {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return `${trimmed}/${path}`
}

async function httpJson(url, apiKey, timeoutMs = 90000) {
  let res
  try {
    res = await fetch(url, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message ?? e), url }
  }
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { ok: res.ok, status: res.status, data, url }
}

async function runInBatches(items, concurrency, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      results[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

app.post('/api/connections/:id/test', asyncRoute(async (req, res) => {
  const conn = await getApiConnectionWithKey(req.params.id)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  const url = buildUrl(conn.baseUrl, 'api/v1/external/test')
  const result = await httpJson(url, conn.apiKey)
  res.status(result.ok ? 200 : 502).json(result)
}))

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const SOURCES = ['billing', 'gateway']

function pad2(n) { return String(n).padStart(2, '0') }

function monthDateRange(year, monthIndex) {
  const y = Number(year)
  const start = new Date(Date.UTC(y, monthIndex, 1))
  const end = new Date(Date.UTC(y, monthIndex + 1, 0))
  const ymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  return { startDate: ymd(start), endDate: ymd(end) }
}

async function fetchBillingMonth(conn, year, monthIdx) {
  const { startDate, endDate } = monthDateRange(year, monthIdx)
  return fetchBillingRange(conn, startDate, endDate, 0)
}

const MAX_CHUNK_DEPTH = 3 // splits per recursion: 1 → 2 → 4 → 8 chunks max

async function fetchBillingRange(conn, startDate, endDate, depth) {
  const from = `${startDate} 00:00:00`
  const to = `${endDate} 23:59:59`
  const url =
    buildUrl(conn.baseUrl, 'api/v1/billing') +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  const result = await httpJson(url, conn.apiKey)

  if (result.ok) return result

  // Only retry by chunking on upstream gateway timeouts or our own abort.
  const isTimeout = result.status === 504 || result.status === 0
  if (!isTimeout || depth >= MAX_CHUNK_DEPTH) return result
  if (daysBetween(startDate, endDate) < 2) return result

  const mid = midpoint(startDate, endDate)
  const [left, right] = await Promise.all([
    fetchBillingRange(conn, startDate, mid.left, depth + 1),
    fetchBillingRange(conn, mid.right, endDate, depth + 1),
  ])
  if (!left.ok || !right.ok) {
    const fail = !left.ok ? left : right
    return {
      ...fail,
      error: `chunked retry failed (${fail.status}${fail.error ? ': ' + fail.error : ''})`,
    }
  }
  const merged = mergeBillingResponses(left.data, right.data, { from, to })
  return { ok: true, status: 200, data: merged, url }
}

function parseYmd(s) {
  // s like '2026-01-15'
  const [y, m, d] = s.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function fmtYmd(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

function daysBetween(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000) + 1
}

function midpoint(startDate, endDate) {
  const days = daysBetween(startDate, endDate)
  const half = Math.floor(days / 2)
  const leftEndMs = parseYmd(startDate) + (half - 1) * 86400000
  const rightStartMs = leftEndMs + 86400000
  return { left: fmtYmd(leftEndMs), right: fmtYmd(rightStartMs) }
}

// Deep numeric merge: sums numbers and numeric strings; preserves equal
// non-numeric strings; merges objects key-by-key. Used to combine two billing
// responses covering adjacent date ranges back into one month-shaped object.
function deepSum(a, b) {
  if (a === undefined || a === null) return b
  if (b === undefined || b === null) return a
  if (typeof a === 'number' && typeof b === 'number') return a + b
  if (typeof a === 'string' && typeof b === 'string') {
    const re = /^-?\d+(\.\d+)?$/
    if (re.test(a.trim()) && re.test(b.trim())) {
      return String(Number(a) + Number(b))
    }
    return a // non-numeric strings like currency/definition: take one
  }
  if (Array.isArray(a) || Array.isArray(b)) return a
  if (typeof a === 'object' && typeof b === 'object') {
    const out = {}
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) out[k] = deepSum(a[k], b[k])
    return out
  }
  return a
}

function mergeBillingResponses(left, right, originalPeriod) {
  if (!left || typeof left !== 'object') return right
  if (!right || typeof right !== 'object') return left
  const merged = deepSum(left, right)
  // Restore period range to original month, drop pagination/control fields.
  if (merged && typeof merged === 'object' && merged.data && typeof merged.data === 'object') {
    merged.data.period = {
      ...((left.data && left.data.period) || {}),
      from: originalPeriod.from,
      to: originalPeriod.to,
    }
  }
  merged.success = true
  merged.code = ''
  merged.message = ''
  merged.chunked = true
  return merged
}

async function fetchGatewayMonth(conn, year, monthIdx) {
  const gatewayKey = process.env.GATEWAY_API_KEY
  if (!gatewayKey) {
    return { ok: false, status: 0, error: 'GATEWAY_API_KEY env var not set on server' }
  }
  if (!conn.clientId) {
    return { ok: false, status: 0, error: 'connection has no client_id' }
  }
  const { startDate, endDate } = monthDateRange(year, monthIdx)
  const url =
    `${GATEWAY_BASE_URL.replace(/\/+$/, '')}/v1/back-office/reporting/billing-summary` +
    `?client_id=${encodeURIComponent(conn.clientId)}` +
    `&from=${encodeURIComponent(startDate)}` +
    `&to=${encodeURIComponent(endDate)}` +
    `&mode=${encodeURIComponent(GATEWAY_MODE)}`
  return httpJson(url, gatewayKey)
}

async function refreshOne(conn, source, year, monthIdx) {
  const fetcher = source === 'gateway' ? fetchGatewayMonth : fetchBillingMonth
  const result = await fetcher(conn, year, monthIdx)
  await upsertBillingCache({
    connectionId: conn.id,
    source,
    year,
    month: monthIdx,
    ok: result.ok,
    status: result.status,
    data: result.data ?? null,
    error: result.error ?? null,
  })
  return result
}

function buildEmptyMonths(year) {
  return MONTH_NAMES.map((name, idx) => {
    const { startDate, endDate } = monthDateRange(year, idx)
    return {
      month: name,
      monthIndex: idx,
      from: startDate,
      to: endDate,
      ok: false,
      status: 0,
      data: null,
      error: 'not fetched',
      fetchedAt: null,
    }
  })
}

app.get('/api/connections/:id/billing/monthly', asyncRoute(async (req, res) => {
  const conn = await getApiConnectionWithKey(req.params.id)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  const year = String(req.query.year ?? new Date().getUTCFullYear())
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'year must be YYYY' })

  const cached = await getBillingCacheForYear(conn.id, year)
  const out = {}
  for (const source of SOURCES) {
    const empty = buildEmptyMonths(year)
    for (const row of cached.filter((c) => c.source === source)) {
      const slot = empty[row.month]
      if (!slot) continue
      empty[row.month] = {
        ...slot,
        ok: row.ok,
        status: row.status,
        data: row.data,
        error: row.ok ? undefined : row.error ?? `HTTP ${row.status}`,
        fetchedAt: row.fetchedAt,
      }
    }
    out[source] = empty
  }
  res.json({ year, connectionId: conn.id, sources: out })
}))

app.post('/api/connections/:id/billing/refresh', asyncRoute(async (req, res) => {
  const conn = await getApiConnectionWithKey(req.params.id)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  const year = String(req.query.year ?? new Date().getUTCFullYear())
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'year must be YYYY' })

  const monthParam = req.query.month
  const sourceParam = String(req.query.source ?? 'all')
  const sources = sourceParam === 'all' ? SOURCES : [sourceParam]
  for (const s of sources) {
    if (!SOURCES.includes(s)) return res.status(400).json({ error: `unknown source ${s}` })
  }

  let monthIdxs
  if (monthParam !== undefined) {
    const m = Number(monthParam)
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      return res.status(400).json({ error: 'month must be 1..12' })
    }
    monthIdxs = [m - 1]
  } else {
    monthIdxs = MONTH_NAMES.map((_, i) => i)
  }

  const tasks = []
  for (const source of sources) {
    for (const idx of monthIdxs) {
      tasks.push({ source, idx })
    }
  }
  const results = await runInBatches(tasks, 3, (t) => refreshOne(conn, t.source, year, t.idx))
  const summary = tasks.map((t, i) => ({
    source: t.source,
    month: MONTH_NAMES[t.idx],
    monthIndex: t.idx,
    ok: results[i].ok,
    status: results[i].status,
    error: results[i].error,
  }))
  res.json({ year, connectionId: conn.id, refreshed: summary })
}))

// --- Scheduler: monthly auto-refresh -----------------------------------------
//
// On server startup (and once every 24 h thereafter) refresh any month whose
// cache is missing or stale. We only ever touch the *previous* month and the
// *current* month — older months are immutable, so re-fetching them is wasted
// work. The previous month is rechecked for ~10 days into the new month so
// late-arriving settlements get picked up.

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const PREV_MONTH_RECHECK_WINDOW_DAYS = 10
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000 // 6h: don't hammer the upstream on quick restarts

function previousMonth(year, monthIdx) {
  if (monthIdx === 0) return { year: String(Number(year) - 1), monthIdx: 11 }
  return { year, monthIdx: monthIdx - 1 }
}

function pickAutoRefreshTargets(now) {
  const year = String(now.getUTCFullYear())
  const cur = now.getUTCMonth()
  const prev = previousMonth(year, cur)
  const dayOfMonth = now.getUTCDate()

  const targets = [{ year, monthIdx: cur }]
  if (dayOfMonth <= PREV_MONTH_RECHECK_WINDOW_DAYS) {
    targets.push({ year: prev.year, monthIdx: prev.monthIdx })
  } else if (dayOfMonth === PREV_MONTH_RECHECK_WINDOW_DAYS + 1) {
    // One last sweep on day 11 to lock in the previous month's final number.
    targets.push({ year: prev.year, monthIdx: prev.monthIdx })
  }
  return targets
}

function isStaleOrMissing(cacheRow, now) {
  if (!cacheRow) return true
  if (!cacheRow.fetchedAt) return true
  if (!cacheRow.ok) return true // last attempt failed; retry
  return now - new Date(cacheRow.fetchedAt).getTime() > STALE_THRESHOLD_MS
}

async function runAutoRefresh() {
  const now = new Date()
  const nowMs = now.getTime()
  const targets = pickAutoRefreshTargets(now)

  const conns = await listApiConnections()
  if (conns.length === 0) return

  let fetched = 0
  for (const summary of conns) {
    const conn = await getApiConnectionWithKey(summary.id)
    if (!conn) continue
    for (const { year, monthIdx } of targets) {
      const cacheForYear = await getBillingCacheForYear(conn.id, year)
      for (const source of SOURCES) {
        if (source === 'gateway' && !conn.clientId) continue
        if (source === 'gateway' && !process.env.GATEWAY_API_KEY) continue
        const row = cacheForYear.find((r) => r.source === source && r.month === monthIdx)
        if (!isStaleOrMissing(row, nowMs)) continue
        try {
          const result = await refreshOne(conn, source, year, monthIdx)
          fetched++
          console.log(
            `[scheduler] ${conn.name} · ${source} ${year}-${pad2(monthIdx + 1)} → ${result.ok ? 'ok' : 'fail (' + (result.error ?? result.status) + ')'}`,
          )
        } catch (e) {
          console.warn(`[scheduler] ${conn.name} · ${source} ${year}-${pad2(monthIdx + 1)} threw`, e)
        }
      }
    }
  }
  if (fetched === 0) {
    console.log('[scheduler] nothing to refresh — cache is up to date')
  }
}

function startScheduler() {
  // Run once shortly after boot (give the server a beat to bind), then daily.
  setTimeout(() => { runAutoRefresh().catch((e) => console.warn('[scheduler] error', e)) }, 5000)
  setInterval(() => { runAutoRefresh().catch((e) => console.warn('[scheduler] error', e)) }, ONE_DAY_MS)
}

// In production the server also serves the built frontend (Vite output in
// ../dist) and falls back to index.html for client-side routes. Registered
// after the API routes above, so /api/* is matched first. Express 5 dropped
// the "*" path string, so the SPA fallback is a final catch-all middleware.
if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  app.use(express.static(distDir))
  app.use((_req, res) => res.sendFile(path.join(distDir, 'index.html')))
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000

;(async () => {
  try {
    await ensureSchema()
  } catch (e) {
    console.error('[db] schema check failed — is DATABASE_URL reachable?', e)
    process.exit(1)
  }
  app.listen(PORT, () => {
    const safeUrl = String(process.env.DATABASE_URL ?? '').replace(/:[^:@/]+@/, ':***@')
    console.log(`[api] listening on http://localhost:${PORT} (db: ${safeUrl || '(no DATABASE_URL!)'})`)
    if (process.env.SWIFTY_DISABLE_SCHEDULER === '1') {
      console.log('[scheduler] disabled via SWIFTY_DISABLE_SCHEDULER=1')
    } else {
      startScheduler()
    }
  })
})()

process.on('SIGTERM', async () => { try { await pool.end() } catch {}; process.exit(0) })
process.on('SIGINT', async () => { try { await pool.end() } catch {}; process.exit(0) })
