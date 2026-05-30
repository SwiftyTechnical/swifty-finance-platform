import { useMemo, useState } from 'react'
import {
  AppState,
  CURRENCIES,
  Currency,
  MONTHS,
  Month,
  MonthlyValues,
  REVENUE_CATEGORIES,
  RevenueCategory,
  RevenueOperator,
  Year,
  sumMonthly,
  totalOfMonthly,
  zeroMonthly,
} from '../types'
import {
  downloadCsv,
  effectiveTerritoryIdForOperator,
  formatGBP,
  formatMoney,
  operatorMonthlyFor,
  operatorMonthlyInGbp,
  round2,
  setOperatorMonthlyValue,
  toCsv,
} from '../utils'

interface Props {
  state: AppState
  year: Year
  hiddenMonths: Month[]
  setHiddenMonths: (hm: Month[]) => void
  addOperator: (op: RevenueOperator) => void
  updateOperator: (id: string, patch: Partial<RevenueOperator>) => void
  removeOperator: (id: string) => void
  reorderOperators: (ids: string[]) => void
  moveOperator: (id: string, direction: 'up' | 'down') => void
}

function uid() {
  return 'op_' + Math.random().toString(36).slice(2, 10)
}

export function RevenueView({
  state,
  year,
  hiddenMonths,
  setHiddenMonths,
  addOperator,
  updateOperator,
  removeOperator,
  reorderOperators,
  moveOperator,
}: Props) {
  const operators = state.operators
  const [showMonthFilter, setShowMonthFilter] = useState(false)
  const visibleMonths: Month[] = MONTHS.filter((m) => !hiddenMonths.includes(m))
  const hiddenSet = new Set(hiddenMonths)

  function toggleMonth(m: Month) {
    const next = new Set(hiddenSet)
    if (next.has(m)) next.delete(m); else next.add(m)
    setHiddenMonths(MONTHS.filter((mm) => next.has(mm)))
  }

  function exportCsv() {
    const header = [
      'Operator',
      'Category',
      'Class',
      'Currency',
      'Territory',
      'Territory short code',
      ...MONTHS.map((m) => `${m} (native)`),
      ...MONTHS.map((m) => `${m} (GBP)`),
      'Total (native)',
      'Total (GBP)',
    ]
    const rows: (string | number)[][] = [header]
    for (const op of state.operators) {
      const opCur: Currency = op.currency ?? 'GBP'
      const yearly = operatorMonthlyFor(op, year)
      const gbp = operatorMonthlyInGbp(yearly, opCur, state.fxRates)
      const tId = effectiveTerritoryIdForOperator(op, state.territories)
      const t = tId ? state.territories.find((tt) => tt.id === tId) : undefined
      rows.push([
        op.name,
        op.category,
        op.classification,
        opCur,
        t?.name ?? '',
        t?.shortCode ?? '',
        ...MONTHS.map((m) => round2(yearly[m] ?? 0)),
        ...MONTHS.map((m) => round2(gbp[m] ?? 0)),
        round2(MONTHS.reduce((acc, m) => acc + (yearly[m] ?? 0), 0)),
        round2(MONTHS.reduce((acc, m) => acc + (gbp[m] ?? 0), 0)),
      ])
    }
    downloadCsv(`revenue-${year}.csv`, toCsv(rows))
  }
  const [name, setName] = useState('')
  const [category, setCategory] = useState<RevenueCategory>('Platform')
  const [classification, setClassification] = useState<'B2B' | 'B2C'>('B2B')
  const [currency, setCurrency] = useState<Currency>('GBP')
  const [filter, setFilter] = useState<'All' | 'B2B' | 'B2C'>('All')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(null); setDragOverId(null); return }
    const ids = operators.map((o) => o.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) { setDragId(null); setDragOverId(null); return }
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    reorderOperators(next)
    setDragId(null)
    setDragOverId(null)
  }

  function handleAdd() {
    if (!name.trim()) return
    addOperator({
      id: uid(),
      name: name.trim(),
      category,
      classification,
      currency,
      monthly: { [year]: zeroMonthly() },
    })
    setName('')
  }

  const visible = operators.filter((o) => filter === 'All' || o.classification === filter)

  const totals = useMemo(() => {
    let gbp = zeroMonthly()
    let native = zeroMonthly()
    const currencySet = new Set<Currency>()
    for (const op of visible) {
      const opCur: Currency = op.currency ?? 'GBP'
      currencySet.add(opCur)
      const yearly = operatorMonthlyFor(op, year)
      native = sumMonthly(native, yearly)
      gbp = sumMonthly(gbp, operatorMonthlyInGbp(yearly, opCur, state.fxRates))
    }
    const singleCurrency = currencySet.size === 1 ? [...currencySet][0] : null
    return { gbp, native, singleCurrency }
  }, [visible, state.fxRates, year])

  return (
    <div>
      <div className="card">
        <h2>Add revenue operator</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="input-cell"
            placeholder="Operator name (e.g. Swifty)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ maxWidth: 220 }}
          />
          <select className="select-cell" value={category} onChange={(e) => setCategory(e.target.value as RevenueCategory)}>
            {REVENUE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select-cell" style={{ minWidth: 80 }} value={classification} onChange={(e) => setClassification(e.target.value as any)}>
            <option value="B2B">B2B</option>
            <option value="B2C">B2C</option>
          </select>
          <select className="select-cell" style={{ minWidth: 80 }} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className="btn" onClick={handleAdd} disabled={!name.trim()}>Add</button>
        </div>
      </div>

      <div className="card">
        <div className="filters">
          <h2 style={{ marginRight: 'auto' }}>Operators ({operators.length}) — {year}</h2>
          <button
            className="btn secondary"
            onClick={() => setShowMonthFilter((v) => !v)}
          >
            Months ({visibleMonths.length}/12) {showMonthFilter ? '▴' : '▾'}
          </button>
          <select value={filter} onChange={(e) => setFilter(e.target.value as any)}>
            <option value="All">All</option>
            <option value="B2B">B2B</option>
            <option value="B2C">B2C</option>
          </select>
          <button
            className="btn secondary"
            onClick={exportCsv}
            disabled={operators.length === 0}
          >
            Export CSV
          </button>
        </div>

        {showMonthFilter && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              padding: 10,
              marginBottom: 10,
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: '#fbfbfc',
            }}
          >
            {MONTHS.map((m) => (
              <label
                key={m}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
              >
                <input
                  type="checkbox"
                  checked={!hiddenSet.has(m)}
                  onChange={() => toggleMonth(m)}
                />
                {m.slice(0, 3)}
              </label>
            ))}
            <button className="linkish" onClick={() => setHiddenMonths([])} style={{ marginLeft: 'auto' }}>
              Show all
            </button>
            <button
              className="linkish"
              onClick={() => setHiddenMonths(MONTHS.filter((_, i) => i < 0 || i > 2))}
            >
              Q1
            </button>
            <button
              className="linkish"
              onClick={() => setHiddenMonths(MONTHS.filter((_, i) => i < 3 || i > 5))}
            >
              Q2
            </button>
            <button
              className="linkish"
              onClick={() => setHiddenMonths(MONTHS.filter((_, i) => i < 6 || i > 8))}
            >
              Q3
            </button>
            <button
              className="linkish"
              onClick={() => setHiddenMonths(MONTHS.filter((_, i) => i < 9 || i > 11))}
            >
              Q4
            </button>
          </div>
        )}

        {operators.length === 0 ? (
          <p className="subtle">No operators yet. Add one above.</p>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 28 }}></th>
                  <th>Operator</th>
                  <th>Category</th>
                  <th>Class</th>
                  <th>Cur</th>
                  <th>Territory</th>
                  {visibleMonths.map((m) => <th key={m} className="num">{m.slice(0, 3)}</th>)}
                  <th className="num">Total (native)</th>
                  <th className="num">Total (GBP)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.flatMap((op, idx) => {
                  const nextOp = visible[idx + 1]
                  const isLastOfRun = !nextOp || nextOp.name !== op.name
                  const runOps = (() => {
                    if (!isLastOfRun) return null
                    const out: typeof visible = []
                    for (let j = idx; j >= 0; j--) {
                      if (visible[j].name === op.name) out.unshift(visible[j])
                      else break
                    }
                    return out
                  })()
                  const opCurrency: Currency = op.currency ?? 'GBP'
                  const yearlyNative = operatorMonthlyFor(op, year)
                  const nativeTotal = MONTHS.reduce((acc, m) => acc + (yearlyNative[m] ?? 0), 0)
                  const gbpMonthly = operatorMonthlyInGbp(yearlyNative, opCurrency, state.fxRates)
                  const gbpTotal = MONTHS.reduce((acc, m) => acc + gbpMonthly[m], 0)
                  const overallIdx = operators.findIndex((o) => o.id === op.id)
                  const canReorder = filter === 'All'
                  const isFirst = overallIdx === 0
                  const isLast = overallIdx === operators.length - 1
                  const row = (
                    <tr
                      key={op.id}
                      draggable={canReorder}
                      onDragStart={(e) => {
                        if (!canReorder) return
                        setDragId(op.id)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragOver={(e) => {
                        if (!canReorder || !dragId) return
                        e.preventDefault()
                        setDragOverId(op.id)
                      }}
                      onDragLeave={() => { if (dragOverId === op.id) setDragOverId(null) }}
                      onDrop={(e) => { if (!canReorder) return; e.preventDefault(); handleDrop(op.id) }}
                      onDragEnd={() => { setDragId(null); setDragOverId(null) }}
                      style={{
                        background: dragOverId === op.id ? 'var(--accent-weak)' : undefined,
                        opacity: dragId === op.id ? 0.5 : undefined,
                      }}
                    >
                      <td style={{ textAlign: 'center', color: 'var(--muted)' }}>
                        {canReorder ? (
                          <span
                            title="Drag to reorder"
                            style={{ cursor: 'grab', userSelect: 'none', fontSize: 14 }}
                          >⋮⋮</span>
                        ) : (
                          <span title="Clear the filter to reorder" style={{ opacity: 0.4 }}>⋮⋮</span>
                        )}
                      </td>
                      <td>
                        <input
                          className="input-cell"
                          value={op.name}
                          onChange={(e) => updateOperator(op.id, { name: e.target.value })}
                          style={{ minWidth: 200, maxWidth: 'none', width: '100%' }}
                        />
                      </td>
                      <td>
                        <select
                          className="select-cell"
                          value={op.category}
                          onChange={(e) => updateOperator(op.id, { category: e.target.value as RevenueCategory })}
                        >
                          {REVENUE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td>
                        <select
                          className="select-cell"
                          value={op.classification}
                          onChange={(e) => updateOperator(op.id, { classification: e.target.value as 'B2B' | 'B2C' })}
                          style={{ minWidth: 80 }}
                        >
                          <option value="B2B">B2B</option>
                          <option value="B2C">B2C</option>
                        </select>
                      </td>
                      <td>
                        <select
                          className="select-cell"
                          style={{ minWidth: 72 }}
                          value={opCurrency}
                          onChange={(e) => updateOperator(op.id, { currency: e.target.value as Currency })}
                        >
                          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td>
                        <select
                          className="select-cell"
                          style={{ minWidth: 140 }}
                          value={op.territoryId ?? ''}
                          onChange={(e) => updateOperator(op.id, { territoryId: e.target.value || undefined })}
                        >
                          <option value="">(Unassigned)</option>
                          {state.territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </td>
                      {visibleMonths.map((m) => (
                        <td key={m} className="num">
                          <input
                            type="number"
                            step="0.01"
                            className="num-input"
                            value={yearlyNative[m] || ''}
                            onChange={(e) => {
                              const n = parseFloat(e.target.value)
                              updateOperator(op.id, {
                                monthly: setOperatorMonthlyValue(op, year, m as Month, Number.isFinite(n) ? n : 0),
                              })
                            }}
                          />
                        </td>
                      ))}
                      <td className="num"><strong>{formatMoney(nativeTotal, opCurrency)}</strong></td>
                      <td className="num"><strong>{formatGBP(gbpTotal)}</strong></td>
                      <td className="row-actions">
                        <button
                          disabled={!canReorder || isFirst}
                          onClick={() => moveOperator(op.id, 'up')}
                          title="Move up"
                        >↑</button>
                        <button
                          disabled={!canReorder || isLast}
                          onClick={() => moveOperator(op.id, 'down')}
                          title="Move down"
                        >↓</button>
                        <button className="danger" onClick={() => removeOperator(op.id)}>Delete</button>
                      </td>
                    </tr>
                  )
                  if (!isLastOfRun || !runOps || runOps.length < 2) return [row]
                  const runCurrencySet = new Set(runOps.map((o) => o.currency ?? 'GBP'))
                  const runSingleCurrency: Currency | null = runCurrencySet.size === 1 ? [...runCurrencySet][0] : null
                  const runNative = MONTHS.reduce<MonthlyValues>((acc, m) => {
                    acc[m] = runOps.reduce((a, o) => a + (operatorMonthlyFor(o, year)[m] ?? 0), 0)
                    return acc
                  }, zeroMonthly())
                  const runGbp = runOps.reduce<MonthlyValues>(
                    (acc, o) => sumMonthly(
                      acc,
                      operatorMonthlyInGbp(operatorMonthlyFor(o, year), o.currency ?? 'GBP', state.fxRates),
                    ),
                    zeroMonthly(),
                  )
                  const runNativeTotal = totalOfMonthly(runNative)
                  const runGbpTotal = totalOfMonthly(runGbp)
                  const subtotal = (
                    <tr key={`${op.id}-subtotal`} className="total-row">
                      <td colSpan={6} style={{ paddingLeft: 32 }}>
                        <strong>{op.name} subtotal</strong>
                        <span className="subtle"> ({runOps.length} row{runOps.length === 1 ? '' : 's'})</span>
                      </td>
                      {visibleMonths.map((m) => (
                        <td key={m} className="num">
                          {runSingleCurrency && runSingleCurrency !== 'GBP' ? (
                            <div style={{ lineHeight: 1.25 }}>
                              <div>{formatMoney(runNative[m], runSingleCurrency)}</div>
                              <div className="subtle" style={{ fontSize: 11 }}>{formatGBP(runGbp[m])}</div>
                            </div>
                          ) : (
                            formatGBP(runGbp[m])
                          )}
                        </td>
                      ))}
                      <td className="num">
                        {runSingleCurrency ? <strong>{formatMoney(runNativeTotal, runSingleCurrency)}</strong> : <span className="subtle">—</span>}
                      </td>
                      <td className="num"><strong>{formatGBP(runGbpTotal)}</strong></td>
                      <td></td>
                    </tr>
                  )
                  return [row, subtotal]
                })}
              </tbody>
              <tfoot>
                {totals.singleCurrency && totals.singleCurrency !== 'GBP' && (
                  <tr className="total-row">
                    <td colSpan={6}>Total ({totals.singleCurrency})</td>
                    {visibleMonths.map((m) => (
                      <td key={m} className="num">{formatMoney(totals.native[m], totals.singleCurrency!)}</td>
                    ))}
                    <td className="num"><strong>{formatMoney(totalOfMonthly(totals.native), totals.singleCurrency!)}</strong></td>
                    <td className="num subtle">—</td>
                    <td></td>
                  </tr>
                )}
                <tr className="grand-total">
                  <td colSpan={6}>Total (GBP)</td>
                  {visibleMonths.map((m) => (
                    <td key={m} className="num">{formatGBP(totals.gbp[m])}</td>
                  ))}
                  <td className="num subtle">—</td>
                  <td className="num"><strong>{formatGBP(totalOfMonthly(totals.gbp))}</strong></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
