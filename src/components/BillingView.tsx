import { Fragment, useEffect, useMemo, useState } from 'react'
import { AppState, MONTHS } from '../types'
import { fetchBillingMonthly, refreshBilling, BillingMonth, BillingSource } from '../api'

interface Props {
  state: AppState
  year: string
}

interface ConnectionFetchState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  sources?: Record<BillingSource, BillingMonth[]>
  error?: string
}

export function BillingView({ state, year }: Props) {
  const connections = state.apiConnections
  const [byConn, setByConn] = useState<Record<string, ConnectionFetchState>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [openMonth, setOpenMonth] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, boolean>>({}) // pending[`${source}:${monthIdx}`]

  useEffect(() => {
    if (connections.length === 0) {
      setActiveId(null)
      return
    }
    if (!activeId || !connections.find((c) => c.id === activeId)) {
      setActiveId(connections[0].id)
    }
  }, [connections, activeId])

  function load(connectionId: string) {
    setByConn((m) => ({ ...m, [connectionId]: { status: 'loading' } }))
    fetchBillingMonthly(connectionId, year)
      .then((res) =>
        setByConn((m) => ({ ...m, [connectionId]: { status: 'ready', sources: res.sources } })),
      )
      .catch((e) =>
        setByConn((m) => ({
          ...m,
          [connectionId]: { status: 'error', error: e?.message ?? String(e) },
        })),
      )
  }

  useEffect(() => {
    if (activeId) load(activeId)
    setOpenMonth(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, year])

  async function refresh(opts: { source?: BillingSource | 'all'; month?: number }) {
    if (!activeId) return
    const key = `${opts.source ?? 'all'}:${opts.month ?? 'all'}`
    setPending((p) => ({ ...p, [key]: true }))
    try {
      await refreshBilling(activeId, { year, ...opts })
      load(activeId)
    } finally {
      setPending((p) => ({ ...p, [key]: false }))
    }
  }

  if (connections.length === 0) {
    return (
      <div className="card">
        <h2>Billing</h2>
        <p className="subtle">
          No API connections yet. Add one under <strong>Settings → Billing API Connections</strong> to fetch monthly billing data.
        </p>
      </div>
    )
  }

  const active = activeId ? connections.find((c) => c.id === activeId) ?? null : null
  const fetchState = activeId ? byConn[activeId] : undefined
  const yearKey = `all:all`
  const isRefreshingYear = pending[yearKey] === true
  const hasClientId = !!active?.clientId

  return (
    <div>
      <div className="card">
        <h2 style={{ marginBottom: 8 }}>Billing</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="subtle" style={{ fontSize: 11 }}>Connection</label>
          <select value={activeId ?? ''} onChange={(e) => setActiveId(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {active && (
            <span className="subtle" style={{ fontSize: 12 }}>
              {active.baseUrl} · year {year}
              {hasClientId ? ` · client_id ${active.clientId}` : ' · no gateway client_id'}
            </span>
          )}
          <button
            className="btn secondary"
            onClick={() => refresh({})}
            disabled={!activeId || isRefreshingYear}
            style={{ marginLeft: 'auto' }}
            title="Re-fetch all 12 months from upstream and overwrite cache"
          >
            {isRefreshingYear ? 'Refreshing year…' : 'Refresh year'}
          </button>
        </div>
      </div>

      {fetchState?.status === 'error' && (
        <div className="card">
          <p style={{ color: 'var(--danger)', margin: 0 }}>Error: {fetchState.error}</p>
        </div>
      )}

      {fetchState?.status === 'loading' && (
        <div className="card">
          <p className="subtle">Loading {year}…</p>
        </div>
      )}

      {fetchState?.status === 'ready' && fetchState.sources && (
        <>
          <SourceSection
            title="Billing API"
            description="Operator back-office billing endpoint (per-tenant key)."
            source="billing"
            months={fetchState.sources.billing}
            year={year}
            extractor={extractBilling}
            metricDefs={BILLING_METRICS}
            openMonth={openMonth}
            setOpenMonth={setOpenMonth}
            onRefreshMonth={(idx) => refresh({ source: 'billing', month: idx + 1 })}
            isRefreshing={(idx) => pending[`billing:${idx + 1}`] === true}
          />
          <SourceSection
            title="Payment Gateway (Nixxe)"
            description={
              hasClientId
                ? `Payment-gateway billing summary. Key from server env GATEWAY_API_KEY · client_id ${active?.clientId}.`
                : 'Add a Client ID on this connection (Settings → Billing API Connections) to enable.'
            }
            source="gateway"
            months={fetchState.sources.gateway}
            year={year}
            extractor={extractGateway}
            metricDefs={GATEWAY_METRICS}
            openMonth={openMonth}
            setOpenMonth={setOpenMonth}
            onRefreshMonth={(idx) => refresh({ source: 'gateway', month: idx + 1 })}
            isRefreshing={(idx) => pending[`gateway:${idx + 1}`] === true}
            disabledNote={hasClientId ? null : 'No client_id configured'}
          />
        </>
      )}
    </div>
  )
}

// --- Common types -----------------------------------------------------------

interface MetricDef {
  key: string
  label: string
  group: string
  isCurrency: boolean
  emphasis?: boolean
}

interface MonthSummary {
  month: string
  monthIndex: number
  ok: boolean
  status: number
  error?: string
  raw: unknown
  fetchedAt?: string | null
  currency: string | null
  chunked: boolean
  metrics: Record<string, number | null>
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function blankSummary(m: BillingMonth, defs: MetricDef[]): MonthSummary {
  const data = m.data as Record<string, unknown> | null
  return {
    month: m.month,
    monthIndex: m.monthIndex,
    ok: m.ok,
    status: m.status,
    error: m.error,
    raw: m.data,
    fetchedAt: m.fetchedAt,
    currency: null,
    chunked: !!(data && typeof data === 'object' && data.chunked === true),
    metrics: defs.reduce<Record<string, number | null>>((acc, d) => {
      acc[d.key] = null
      return acc
    }, {}),
  }
}

// --- Billing API extractor --------------------------------------------------

const BILLING_METRICS: MetricDef[] = [
  { key: 'sportsbook_ngr', label: 'Sportsbook NGR', group: 'Revenue', isCurrency: true },
  { key: 'casino_ngr', label: 'Casino NGR', group: 'Revenue', isCurrency: true },
  { key: 'total_ngr', label: 'Total NGR (sport + casino)', group: 'Revenue', isCurrency: true, emphasis: true },
  { key: 'sportsbook_turnover', label: 'Sportsbook turnover', group: 'Activity', isCurrency: true },
  { key: 'casino_turnover', label: 'Casino turnover', group: 'Activity', isCurrency: true },
  { key: 'bets_placed', label: 'Bets placed', group: 'Activity', isCurrency: false },
  { key: 'bets_settled', label: 'Bets settled', group: 'Activity', isCurrency: false },
  { key: 'casino_rounds', label: 'Casino rounds', group: 'Activity', isCurrency: false },
  { key: 'active_users', label: 'Active users', group: 'Users', isCurrency: false },
  { key: 'registered', label: 'Registered users', group: 'Users', isCurrency: false },
  { key: 'ftd', label: 'First-time depositors', group: 'Users', isCurrency: false },
  { key: 'kyc_checks', label: 'KYC checks', group: 'Compliance', isCurrency: false },
  { key: 'affordability_checks', label: 'Affordability checks', group: 'Compliance', isCurrency: false },
  { key: 'deposits', label: 'Deposits', group: 'Transactions', isCurrency: false },
  { key: 'withdrawals', label: 'Withdrawals', group: 'Transactions', isCurrency: false },
  { key: 'total_txns', label: 'Total transactions', group: 'Transactions', isCurrency: false, emphasis: true },
]

function extractBilling(m: BillingMonth): MonthSummary {
  const out = blankSummary(m, BILLING_METRICS)
  if (!m.ok || !m.data || typeof m.data !== 'object') return out
  const root = m.data as Record<string, unknown>
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>
  const sport = ((data.activity_totals as any) ?? {}).sportsbook ?? {}
  const casino = ((data.activity_totals as any) ?? {}).casino ?? {}
  const users = (data.users as any) ?? {}
  const txns = (data.transactions as any) ?? {}
  const txnsByType = (txns.txns_by_type as any) ?? {}
  const kyc = (data.kyc as any) ?? {}
  const aff = (data.affordability as any) ?? {}

  const sportNgr = num(sport?.net_gaming_revenue?.amount)
  const casinoNgr = num(casino?.net_gaming_revenue?.amount)
  out.currency =
    sport?.net_gaming_revenue?.currency ??
    casino?.net_gaming_revenue?.currency ??
    sport?.turnover?.currency ??
    null
  out.metrics.sportsbook_ngr = sportNgr
  out.metrics.casino_ngr = casinoNgr
  out.metrics.total_ngr =
    sportNgr === null && casinoNgr === null ? null : (sportNgr ?? 0) + (casinoNgr ?? 0)
  out.metrics.sportsbook_turnover = num(sport?.turnover?.amount)
  out.metrics.casino_turnover = num(casino?.turnover?.amount)
  out.metrics.bets_placed = num(sport?.bets_placed)
  out.metrics.bets_settled = num(sport?.bets_settled)
  out.metrics.casino_rounds = num(casino?.rounds_played)
  out.metrics.active_users = num(users?.active_users?.count)
  out.metrics.registered = num(users?.registered_total)
  out.metrics.ftd = num(users?.first_time_deposit_total)
  out.metrics.kyc_checks = num(kyc?.checks_total)
  out.metrics.affordability_checks = num(aff?.checks_total)
  const dep = num(txnsByType?.deposit)
  const wd = num(txnsByType?.withdrawal)
  out.metrics.deposits = dep
  out.metrics.withdrawals = wd
  out.metrics.total_txns =
    dep === null && wd === null ? null : (dep ?? 0) + (wd ?? 0)
  return out
}

// --- Gateway extractor ------------------------------------------------------

const GATEWAY_METRICS: MetricDef[] = [
  { key: 'deposit_amount', label: 'Total deposits', group: 'Totals (base ccy)', isCurrency: true, emphasis: true },
  { key: 'withdrawal_amount', label: 'Total withdrawals', group: 'Totals (base ccy)', isCurrency: true },
  { key: 'net_flow', label: 'Net flow (deposits − withdrawals)', group: 'Totals (base ccy)', isCurrency: true, emphasis: true },
  { key: 'deposit_txns', label: 'Deposit transactions', group: 'Volume', isCurrency: false },
  { key: 'withdrawal_txns', label: 'Withdrawal transactions', group: 'Volume', isCurrency: false },
  { key: 'total_txns', label: 'Total transactions', group: 'Volume', isCurrency: false, emphasis: true },
]

function extractGateway(m: BillingMonth): MonthSummary {
  const out = blankSummary(m, GATEWAY_METRICS)
  if (!m.ok || !m.data || typeof m.data !== 'object') return out
  const root = m.data as Record<string, unknown>
  const summary = (root.summary as any) ?? {}
  const deposit = num(summary?.total_deposit_amount)
  const withdrawal = num(summary?.total_withdrawal_amount)
  out.currency = summary?.base_currency ?? null
  out.metrics.deposit_amount = deposit
  out.metrics.withdrawal_amount = withdrawal
  out.metrics.net_flow =
    deposit === null && withdrawal === null ? null : (deposit ?? 0) - (withdrawal ?? 0)
  const depTxns = num(summary?.total_deposit_txns)
  const wdTxns = num(summary?.total_withdrawal_txns)
  out.metrics.deposit_txns = depTxns
  out.metrics.withdrawal_txns = wdTxns
  out.metrics.total_txns =
    depTxns === null && wdTxns === null ? null : (depTxns ?? 0) + (wdTxns ?? 0)
  return out
}

// --- Render -----------------------------------------------------------------

// Shared column proportions so the Billing API and Gateway tables line up
// regardless of viewport width: metric 22% · 12 × month 5.5% (= 66%) · total 12%.
const COL_METRIC_PCT = '22%'
const COL_MONTH_PCT = '5.5%'
const COL_TOTAL_PCT = '12%'

function MonthlyColGroup() {
  return (
    <colgroup>
      <col style={{ width: COL_METRIC_PCT }} />
      {MONTHS.map((m) => (
        <col key={m} style={{ width: COL_MONTH_PCT }} />
      ))}
      <col style={{ width: COL_TOTAL_PCT }} />
    </colgroup>
  )
}

function SourceSection({
  title,
  description,
  source,
  months,
  year,
  extractor,
  metricDefs,
  openMonth,
  setOpenMonth,
  onRefreshMonth,
  isRefreshing,
  disabledNote,
}: {
  title: string
  description: string
  source: BillingSource
  months: BillingMonth[]
  year: string
  extractor: (m: BillingMonth) => MonthSummary
  metricDefs: MetricDef[]
  openMonth: string | null
  setOpenMonth: (m: string | null) => void
  onRefreshMonth: (monthIdx: number) => void
  isRefreshing: (monthIdx: number) => boolean
  disabledNote?: string | null
}) {
  const summaries = useMemo(() => months.map(extractor), [months, extractor])
  const currency = summaries.find((s) => s.currency)?.currency ?? null

  const groups = useMemo(() => {
    const m = new Map<string, MetricDef[]>()
    for (const def of metricDefs) {
      const arr = m.get(def.group) ?? []
      arr.push(def)
      m.set(def.group, arr)
    }
    return [...m.entries()]
  }, [metricDefs])

  const lastFetched = summaries
    .map((s) => s.fetchedAt)
    .filter(Boolean)
    .sort()
    .pop()

  const chunkedMonths = summaries.filter((s) => s.ok && s.chunked).map((s) => s.month)

  return (
    <div className="card">
      <h2 style={{ marginTop: 0, marginBottom: 4 }}>
        {title} <span className="subtle" style={{ fontWeight: 400, fontSize: 12 }}>· {year}{currency ? ` · ${currency}` : ''}</span>
      </h2>
      <p className="subtle" style={{ marginTop: 0 }}>
        {description}
        {lastFetched && <> · last refreshed {formatRelative(lastFetched)}</>}
      </p>

      {disabledNote && (
        <p style={{ color: 'var(--muted)', fontSize: 12, fontStyle: 'italic' }}>{disabledNote}</p>
      )}

      {chunkedMonths.length > 0 && (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>
          <span style={{ marginRight: 4 }}>*</span>
          {chunkedMonths.join(', ')} reassembled from smaller date ranges due to upstream gateway timeouts on the full month.
          Revenue, turnover, and transaction-count totals are exact; user-count metrics (Active users) may over-count people who were active in more than one chunk.
        </p>
      )}

      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table className="grid" style={{ tableLayout: 'fixed', width: '100%' }}>
          <MonthlyColGroup />
          <thead>
            <tr>
              <th>Metric</th>
              {summaries.map((s) => (
                <th key={s.month} className="num" title={statusTitle(s)}>
                  {s.month.slice(0, 3)}
                  {!s.ok && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>!</span>}
                  {s.ok && s.chunked && (
                    <span
                      style={{ color: 'var(--muted)', marginLeft: 2 }}
                      title="Assembled from multiple smaller-range fetches because the upstream timed out on a full-month query. Revenue/turnover/bet-count totals are exact; user-count metrics (Active users) may over-count people active in more than one chunk."
                    >*</span>
                  )}
                </th>
              ))}
              <th className="num">Total</th>
            </tr>
            <tr>
              <th style={{ fontSize: 10, fontWeight: 400 }}>refresh →</th>
              {summaries.map((s) => (
                <th key={s.month} className="num" style={{ padding: '2px 6px' }}>
                  <button
                    onClick={() => onRefreshMonth(s.monthIndex)}
                    disabled={isRefreshing(s.monthIndex) || !!disabledNote}
                    title={`Refresh ${s.month}`}
                    style={{
                      fontSize: 11,
                      padding: '2px 6px',
                      borderRadius: 4,
                      border: '1px solid var(--border-strong)',
                      background: 'white',
                    }}
                  >
                    {isRefreshing(s.monthIndex) ? '…' : '↻'}
                  </button>
                </th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([groupName, defs]) => (
              <Fragment key={groupName}>
                <tr className="section-head">
                  <td colSpan={MONTHS.length + 2}>{groupName}</td>
                </tr>
                {defs.map((def) => {
                  const values = summaries.map((s) => s.metrics[def.key])
                  const total = values.reduce<number | null>((acc, v) => {
                    if (v === null) return acc
                    return (acc ?? 0) + v
                  }, null)
                  return (
                    <tr key={def.key} className={def.emphasis ? 'total-row' : ''}>
                      <td style={{ whiteSpace: 'normal' }}>{def.label}{def.isCurrency && currency ? ` (${currency})` : ''}</td>
                      {values.map((v, i) => (
                        <td key={i} className="num">
                          {v === null ? <span className="subtle">—</span> : formatNumber(v, def.isCurrency)}
                        </td>
                      ))}
                      <td className="num">
                        <strong>{total === null ? '—' : formatNumber(total, def.isCurrency)}</strong>
                      </td>
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <details>
        <summary className="subtle" style={{ cursor: 'pointer', fontSize: 12 }}>Per-month status &amp; raw responses</summary>
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Month</th>
                <th>Status</th>
                <th>Fetched at</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => {
                const openKey = `${source}:${s.month}`
                return (
                  <Fragment key={s.month}>
                    <tr>
                      <td>{s.month}</td>
                      <td>
                        {s.fetchedAt ? (
                          s.ok ? (
                            <span className="pill b2b">HTTP {s.status}</span>
                          ) : (
                            <span className="pill b2c" title={s.error}>HTTP {s.status || 'err'}</span>
                          )
                        ) : (
                          <span className="pill unassigned">not fetched</span>
                        )}
                      </td>
                      <td className="subtle" style={{ fontSize: 11 }}>
                        {s.fetchedAt ? new Date(s.fetchedAt).toLocaleString() : '—'}
                      </td>
                      <td className="row-actions">
                        <button onClick={() => setOpenMonth(openMonth === openKey ? null : openKey)} disabled={!s.fetchedAt}>
                          {openMonth === openKey ? 'Hide JSON' : 'View JSON'}
                        </button>
                      </td>
                    </tr>
                    {openMonth === openKey && (
                      <tr>
                        <td colSpan={4} style={{ background: '#f8fafc' }}>
                          <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto' }}>
                            {JSON.stringify(s.raw, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

function statusTitle(s: MonthSummary): string {
  if (!s.fetchedAt) return 'not fetched yet — click ↻ to fetch'
  if (s.ok) return `HTTP ${s.status} · fetched ${new Date(s.fetchedAt).toLocaleString()}`
  return `HTTP ${s.status || 'err'}: ${s.error ?? 'unknown'} (fetched ${new Date(s.fetchedAt).toLocaleString()})`
}

function formatRelative(iso: string): string {
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  const sec = Math.round(diffMs / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  return d.toLocaleDateString()
}

function formatNumber(n: number, isCurrency: boolean): string {
  if (!Number.isFinite(n)) return '—'
  if (isCurrency) {
    return n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return n.toLocaleString('en-GB', { maximumFractionDigits: 0 })
}
