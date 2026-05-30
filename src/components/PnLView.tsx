import { useMemo, useState } from 'react'
import {
  AppState,
  Currency,
  MONTHS,
  Month,
  MonthlyValues,
  REVENUE_CATEGORIES,
  RevenueCategory,
  RevenueOperator,
  Year,
  zeroMonthly,
  sumMonthly,
  totalOfMonthly,
} from '../types'
import {
  convertAmount,
  downloadCsv,
  effectiveCurrency,
  effectiveTerritoryId,
  effectiveTerritoryIdForOperator,
  formatGBP,
  formatMoney,
  groupExpenses,
  operatorMonthlyFor,
  operatorMonthlyInGbp,
  round2,
  toCsv,
  toGbp,
  totalAcross,
} from '../utils'

interface Props {
  state: AppState
  side: 'B2B' | 'B2C'
  year: Year
  hiddenMonths: Month[]
  setHiddenMonths: (hm: Month[]) => void
}

type RevenueViewMode = 'operator' | 'category'
type Layout = 'monthly' | 'territory'

const UNASSIGNED_KEY = '__unassigned__'

export function PnLView({ state, side, year, hiddenMonths, setHiddenMonths }: Props) {
  const [revView, setRevView] = useState<RevenueViewMode>('operator')
  const [layout, setLayout] = useState<Layout>('monthly')
  const [showMonthFilter, setShowMonthFilter] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const visibleMonths: Month[] = MONTHS.filter((m) => !hiddenMonths.includes(m))
  const hiddenSet = new Set(hiddenMonths)
  function toggleMonth(m: Month) {
    const next = new Set(hiddenSet)
    if (next.has(m)) next.delete(m); else next.add(m)
    setHiddenMonths(MONTHS.filter((mm) => next.has(mm)))
  }

  function toggleGroup(name: string) {
    const next = new Set(expanded)
    if (next.has(name)) next.delete(name); else next.add(name)
    setExpanded(next)
  }

  const operators = state.operators.filter((o) => o.classification === side)

  // === MONTHLY LAYOUT DATA ===
  const territoryLabel = (id: string | null): string => {
    if (!id) return ''
    const t = state.territories.find((tt) => tt.id === id)
    return t ? (t.shortCode?.trim() || t.name) : ''
  }
  const territoryName = (id: string | null): string => {
    if (!id) return ''
    return state.territories.find((tt) => tt.id === id)?.name ?? ''
  }
  const territoryCode = (id: string | null): string => {
    if (!id) return ''
    return state.territories.find((tt) => tt.id === id)?.shortCode ?? ''
  }

  const revenueByOperator = useMemo(() => {
    return operators.map((op) => {
      const tId = effectiveTerritoryIdForOperator(op, state.territories)
      const territory = territoryLabel(tId)
      const sub = op.category + (territory ? ` · ${territory}` : '')
      return {
        label: op.name,
        sub,
        territory,
        monthly: operatorMonthlyInGbp(operatorMonthlyFor(op, year), op.currency ?? 'GBP', state.fxRates),
      }
    })
  }, [operators, state.fxRates, state.territories, year])

  const revenueByCategory = useMemo(() => {
    const map = new Map<RevenueCategory, MonthlyValues>()
    for (const c of REVENUE_CATEGORIES) map.set(c, zeroMonthly())
    for (const op of operators) {
      const gbp = operatorMonthlyInGbp(operatorMonthlyFor(op, year), op.currency ?? 'GBP', state.fxRates)
      map.set(op.category, sumMonthly(map.get(op.category)!, gbp))
    }
    return [...map.entries()]
      .filter(([, v]) => totalOfMonthly(v) !== 0)
      .map(([k, v]) => ({ label: k, sub: '', territory: '', monthly: v }))
  }, [operators, state.fxRates, year])

  const revenueRows = revView === 'operator' ? revenueByOperator : revenueByCategory
  const revenueTotal = useMemo(() => totalAcross(revenueRows), [revenueRows])

  const costGroups = useMemo(() => groupExpenses(state, side), [state, side])
  const costTotal = useMemo(() => totalAcross(costGroups), [costGroups])

  const net = useMemo(() => {
    const n = zeroMonthly()
    for (const m of MONTHS) n[m] = revenueTotal[m] - costTotal[m]
    return n
  }, [revenueTotal, costTotal])

  function exportCsv() {
    const header = [
      'Row type',
      'Group',
      'Line',
      'Section',
      'Currency',
      'Territory',
      'Territory short code',
      ...MONTHS.map((m) => m),
      'Total',
    ]
    const blankCols = ['', '', '', '', '', '', ...MONTHS.map(() => ''), '']
    const monthlyRow = (
      rowType: string,
      group: string,
      line: string,
      section: string,
      currency: string,
      territory: string,
      code: string,
      vals: MonthlyValues,
    ): (string | number)[] => [
      rowType,
      group,
      line,
      section,
      currency,
      territory,
      code,
      ...MONTHS.map((m) => round2(vals[m] ?? 0)),
      round2(totalOfMonthly(vals)),
    ]
    const rows: (string | number)[][] = [header]
    rows.push([`${side} sales revenue`, ...blankCols.slice(1)])
    for (const op of operators) {
      const tId = effectiveTerritoryIdForOperator(op, state.territories)
      const monthly = operatorMonthlyInGbp(
        operatorMonthlyFor(op, year),
        op.currency ?? 'GBP',
        state.fxRates,
      )
      rows.push(monthlyRow('Revenue', '', op.name, op.category, 'GBP', territoryName(tId), territoryCode(tId), monthly))
    }
    rows.push(monthlyRow('Total Revenue', '', '', '', 'GBP', '', '', revenueTotal))
    rows.push(['Costs and expenses', ...blankCols.slice(1)])
    for (const g of costGroups) {
      const lineTerritoryIds = [...new Set(g.lines.map((line) => effectiveTerritoryId(line, state)))]
      const names = lineTerritoryIds.map(territoryName).filter(Boolean).sort().join(', ')
      const codes = lineTerritoryIds.map(territoryCode).filter(Boolean).sort().join(', ')
      rows.push(monthlyRow('Cost group', g.group, `${g.group} subtotal`, '', 'GBP', names, codes, g.monthly))
      for (const line of g.lines) {
        const gbp = toGbp(line, state)
        const cur = effectiveCurrency(line, state)
        const lineTId = effectiveTerritoryId(line, state)
        rows.push(monthlyRow('Cost line', g.group, line.name, line.section, cur, territoryName(lineTId), territoryCode(lineTId), gbp))
      }
    }
    rows.push(monthlyRow('Total Expenses', '', '', '', 'GBP', '', '', costTotal))
    rows.push(monthlyRow('Net (Revenue - Expenses)', '', '', '', 'GBP', '', '', net))
    downloadCsv(`pnl-${side.toLowerCase()}-${year}.csv`, toCsv(rows))
  }

  // === TERRITORY LAYOUT DATA ===
  // Determine which columns appear: each defined territory + Unassigned if applicable.
  const oppositeSide = side === 'B2B' ? 'b2c' : 'b2b'
  const territoryCols = useMemo(() => {
    const mentionsOpposite = (s: string) => {
      const lower = s.toLowerCase()
      return new RegExp(`\\b${oppositeSide}\\b`).test(lower)
    }
    const cols: { id: string; name: string; currency: Currency | null }[] = state.territories
      .filter((t) => {
        const code = t.shortCode ?? ''
        const name = t.name ?? ''
        return !mentionsOpposite(code) && !mentionsOpposite(name)
      })
      .map((t) => ({
        id: t.id,
        name: t.shortCode?.trim() || t.name,
        currency: t.currency,
      }))

    const anyUnassignedExpense = costGroups.some((g) =>
      g.lines.some((l) => !effectiveTerritoryId(l, state)),
    )
    const anyUnassignedOperator = operators.some(
      (op) => !effectiveTerritoryIdForOperator(op, state.territories),
    )
    if (anyUnassignedExpense || anyUnassignedOperator) {
      cols.push({ id: UNASSIGNED_KEY, name: '(Unassigned)', currency: null })
    }
    return cols
  }, [state, costGroups, operators, oppositeSide])

  const selectedMonths: Month[] = visibleMonths

  // Per-column aggregated value for a revenue operator row (native currency of column)
  function operatorAmountForColumn(
    op: RevenueOperator,
    col: { id: string; currency: Currency | null },
  ): number {
    const opTerritoryId = effectiveTerritoryIdForOperator(op, state.territories)
    const belongs =
      col.id === UNASSIGNED_KEY ? !opTerritoryId : opTerritoryId === col.id
    if (!belongs) return 0
    const opCur: Currency = op.currency ?? 'GBP'
    const targetCurrency: Currency = col.currency ?? 'GBP'
    const yearly = operatorMonthlyFor(op, year)
    let total = 0
    for (const m of selectedMonths) {
      total += convertAmount(yearly[m] ?? 0, opCur, targetCurrency, state.fxRates)
    }
    return total
  }

  function operatorGbpTotal(op: RevenueOperator): number {
    const gbp = operatorMonthlyInGbp(operatorMonthlyFor(op, year), op.currency ?? 'GBP', state.fxRates)
    let t = 0
    for (const m of selectedMonths) t += gbp[m] ?? 0
    return t
  }

  // Per-column amount for a cost group
  function groupAmountForColumn(
    group: { group: string; lines: any[] },
    col: { id: string; currency: Currency | null },
  ): number {
    const targetCurrency: Currency = col.currency ?? 'GBP'
    let total = 0
    for (const line of group.lines) {
      const lineTerritoryId = effectiveTerritoryId(line, state)
      const belongs =
        col.id === UNASSIGNED_KEY ? !lineTerritoryId : lineTerritoryId === col.id
      if (!belongs) continue
      const lineCur = effectiveCurrency(line, state)
      for (const m of selectedMonths) {
        total += convertAmount(line.nativeMonthly[m] ?? 0, lineCur, targetCurrency, state.fxRates)
      }
    }
    return total
  }

  function groupGbpTotal(group: { group: string; lines: any[] }): number {
    let total = 0
    for (const line of group.lines) {
      const gbp = toGbp(line, state)
      for (const m of selectedMonths) total += gbp[m] ?? 0
    }
    return total
  }

  const territoryColumnTotals = useMemo(() => {
    // For each column, compute revenue, expense, and net across all rows
    const revSums: Record<string, number> = {}
    const expSums: Record<string, number> = {}
    for (const col of territoryCols) {
      let rev = 0
      for (const op of operators) rev += operatorAmountForColumn(op, col)
      let exp = 0
      for (const g of costGroups) exp += groupAmountForColumn(g, col)
      revSums[col.id] = rev
      expSums[col.id] = exp
    }
    let revGbp = 0
    for (const op of operators) revGbp += operatorGbpTotal(op)
    let expGbp = 0
    for (const g of costGroups) expGbp += groupGbpTotal(g)
    return { revSums, expSums, revGbp, expGbp }
  }, [territoryCols, operators, costGroups, state, hiddenMonths])

  return (
    <div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <h2 style={{ margin: 0 }}>{side} — FY.{year}</h2>
          <span className="subtle">(figures in GBP unless stated)</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="subtle">Layout:</span>
            <select value={layout} onChange={(e) => setLayout(e.target.value as Layout)}>
              <option value="monthly">Monthly</option>
              <option value="territory">Territory split</option>
            </select>
            <button
              className="btn secondary"
              onClick={() => setShowMonthFilter((v) => !v)}
            >
              Months ({visibleMonths.length}/12) {showMonthFilter ? '▴' : '▾'}
            </button>
            <span className="subtle">Revenue:</span>
            <select value={revView} onChange={(e) => setRevView(e.target.value as RevenueViewMode)}>
              <option value="operator">By operator</option>
              <option value="category">By category</option>
            </select>
            <button
              className="btn secondary"
              onClick={() => {
                if (expanded.size === costGroups.length) setExpanded(new Set())
                else setExpanded(new Set(costGroups.map((g) => g.group)))
              }}
              disabled={costGroups.length === 0}
            >
              {expanded.size === costGroups.length && costGroups.length > 0 ? 'Collapse all' : 'Expand all'}
            </button>
            <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
          </div>
        </div>

        {showMonthFilter && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              padding: 10,
              margin: '10px 14px',
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
            <button className="linkish" onClick={() => setHiddenMonths([])} style={{ marginLeft: 'auto' }}>Show all</button>
            <button className="linkish" onClick={() => setHiddenMonths(MONTHS.filter((_, i) => i < 0 || i > 2))}>Q1</button>
            <button className="linkish" onClick={() => setHiddenMonths(MONTHS.filter((_, i) => i < 3 || i > 5))}>Q2</button>
            <button className="linkish" onClick={() => setHiddenMonths(MONTHS.filter((_, i) => i < 6 || i > 8))}>Q3</button>
            <button className="linkish" onClick={() => setHiddenMonths(MONTHS.filter((_, i) => i < 9 || i > 11))}>Q4</button>
          </div>
        )}

        {layout === 'monthly' ? (
          <MonthlyTable
            side={side}
            revenueRows={revenueRows}
            revenueTotal={revenueTotal}
            costGroups={costGroups}
            costTotal={costTotal}
            net={net}
            expanded={expanded}
            toggleGroup={toggleGroup}
            state={state}
            visibleMonths={visibleMonths}
            territoryLabelForLine={(line) => territoryLabel(effectiveTerritoryId(line, state))}
          />
        ) : (
          <TerritoryTable
            side={side}
            year={year}
            operators={operators}
            costGroups={costGroups}
            territoryCols={territoryCols}
            revView={revView}
            visibleMonths={visibleMonths}
            expanded={expanded}
            toggleGroup={toggleGroup}
            state={state}
            operatorAmountForColumn={operatorAmountForColumn}
            operatorGbpTotal={operatorGbpTotal}
            groupAmountForColumn={groupAmountForColumn}
            groupGbpTotal={groupGbpTotal}
            totals={territoryColumnTotals}
          />
        )}
      </div>
    </div>
  )
}

// ------------------------- Monthly Table -------------------------

function MonthlyTable({
  side,
  revenueRows,
  revenueTotal,
  costGroups,
  costTotal,
  net,
  expanded,
  toggleGroup,
  state,
  visibleMonths,
  territoryLabelForLine,
}: {
  side: 'B2B' | 'B2C'
  revenueRows: { label: string; sub: string; monthly: MonthlyValues }[]
  revenueTotal: MonthlyValues
  costGroups: ReturnType<typeof groupExpenses>
  costTotal: MonthlyValues
  net: MonthlyValues
  expanded: Set<string>
  toggleGroup: (name: string) => void
  state: AppState
  visibleMonths: Month[]
  territoryLabelForLine: (line: any) => string
}) {
  const totalColSpan = visibleMonths.length + 2
  return (
    <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
      <table className="grid">
        <thead>
          <tr>
            <th style={{ minWidth: 220 }}></th>
            {visibleMonths.map((m) => <th key={m} className="num">{m}</th>)}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr className="section-head"><td colSpan={totalColSpan}>{side} sales revenue</td></tr>
          {revenueRows.length === 0 ? (
            <tr><td colSpan={totalColSpan} className="subtle" style={{ padding: '10px 14px' }}>
              No {side} operators yet — add them on the Revenue tab.
            </td></tr>
          ) : revenueRows.flatMap((r, idx) => {
            const row = (
              <tr key={`${r.label}-${idx}`}>
                <td>
                  <strong>{r.label}</strong>{r.sub && <span className="subtle"> — {r.sub}</span>}
                </td>
                {visibleMonths.map((m) => <td key={m} className="num">{formatGBP(r.monthly[m])}</td>)}
                <td className="num"><strong>{formatGBP(totalOfMonthly(r.monthly))}</strong></td>
              </tr>
            )
            const nextRow = revenueRows[idx + 1]
            const isLastOfRun = !nextRow || nextRow.label !== r.label
            if (!isLastOfRun) return [row]
            const runRows: typeof revenueRows = []
            for (let j = idx; j >= 0; j--) {
              if (revenueRows[j].label === r.label) runRows.unshift(revenueRows[j])
              else break
            }
            if (runRows.length < 2) return [row]
            const runMonthly = runRows.reduce<MonthlyValues>(
              (acc, rr) => sumMonthly(acc, rr.monthly),
              zeroMonthly(),
            )
            const subtotal = (
              <tr key={`${r.label}-${idx}-subtotal`} className="total-row">
                <td style={{ paddingLeft: 24 }}>
                  <strong>{r.label} subtotal</strong>
                  <span className="subtle"> ({runRows.length} rows)</span>
                </td>
                {visibleMonths.map((m) => <td key={m} className="num">{formatGBP(runMonthly[m])}</td>)}
                <td className="num"><strong>{formatGBP(totalOfMonthly(runMonthly))}</strong></td>
              </tr>
            )
            return [row, subtotal]
          })}
          <tr className="total-row">
            <td>Total Revenue</td>
            {visibleMonths.map((m) => <td key={m} className="num">{formatGBP(revenueTotal[m])}</td>)}
            <td className="num">{formatGBP(totalOfMonthly(revenueTotal))}</td>
          </tr>

          <tr className="section-head"><td colSpan={totalColSpan}>Costs and expenses</td></tr>
          {costGroups.length === 0 ? (
            <tr><td colSpan={totalColSpan} className="subtle" style={{ padding: '10px 14px' }}>
              No {side} expenses classified yet — assign on the Expenses tab.
            </td></tr>
          ) : costGroups.flatMap((g) => {
            const isOpen = expanded.has(g.group)
            const territoryTags = [...new Set(g.lines.map(territoryLabelForLine).filter(Boolean))].sort()
            const groupRow = (
              <tr key={g.group}>
                <td onClick={() => toggleGroup(g.group)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  <span style={{ display: 'inline-block', width: 14, color: 'var(--muted)' }}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <strong>{g.group}</strong>{' '}
                  <span className="subtle">({g.lines.length} line{g.lines.length === 1 ? '' : 's'})</span>
                  {territoryTags.length > 0 && (
                    <span className="subtle" style={{ marginLeft: 6, fontSize: 11 }}>
                      · {territoryTags.join(', ')}
                    </span>
                  )}
                </td>
                {visibleMonths.map((m) => <td key={m} className="num">{formatGBP(g.monthly[m])}</td>)}
                <td className="num"><strong>{formatGBP(totalOfMonthly(g.monthly))}</strong></td>
              </tr>
            )
            if (!isOpen) return [groupRow]
            const children = g.lines.map((line) => {
              const gbp = toGbp(line, state)
              const cur = effectiveCurrency(line, state)
              const territory = territoryLabelForLine(line)
              return (
                <tr key={`${g.group}::${line.id}`} style={{ background: '#fbfbfc' }}>
                  <td style={{ paddingLeft: 32 }}>
                    <span className="subtle">{line.name}</span>{' '}
                    <span className="subtle" style={{ fontSize: 11 }}>
                      · {line.section} · {cur}{territory ? ` · ${territory}` : ''}
                    </span>
                  </td>
                  {visibleMonths.map((m) => (
                    <td key={m} className="num subtle">{formatGBP(gbp[m])}</td>
                  ))}
                  <td className="num subtle">{formatGBP(MONTHS.reduce((acc, m) => acc + gbp[m], 0))}</td>
                </tr>
              )
            })
            return [groupRow, ...children]
          })}
          <tr className="total-row">
            <td>Total Expenses</td>
            {visibleMonths.map((m) => <td key={m} className="num">{formatGBP(costTotal[m])}</td>)}
            <td className="num">{formatGBP(totalOfMonthly(costTotal))}</td>
          </tr>

          <tr className="net-row">
            <td>Net (Revenue - Expenses)</td>
            {visibleMonths.map((m) => (
              <td key={m} className={`num ${net[m] >= 0 ? 'positive' : 'negative'}`}>
                {formatGBP(net[m])}
              </td>
            ))}
            <td className={`num ${totalOfMonthly(net) >= 0 ? 'positive' : 'negative'}`}>
              {formatGBP(totalOfMonthly(net))}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ------------------------- Territory Table -------------------------

type Col = { id: string; name: string; currency: Currency | null }

function TerritoryTable({
  side,
  year,
  operators,
  costGroups,
  territoryCols,
  revView,
  visibleMonths,
  expanded,
  toggleGroup,
  state,
  operatorAmountForColumn,
  operatorGbpTotal,
  groupAmountForColumn,
  groupGbpTotal,
  totals,
}: {
  side: 'B2B' | 'B2C'
  year: Year
  operators: RevenueOperator[]
  costGroups: ReturnType<typeof groupExpenses>
  territoryCols: Col[]
  revView: RevenueViewMode
  visibleMonths: Month[]
  expanded: Set<string>
  toggleGroup: (name: string) => void
  state: AppState
  operatorAmountForColumn: (op: RevenueOperator, col: Col) => number
  operatorGbpTotal: (op: RevenueOperator) => number
  groupAmountForColumn: (g: ReturnType<typeof groupExpenses>[number], col: Col) => number
  groupGbpTotal: (g: ReturnType<typeof groupExpenses>[number]) => number
  totals: { revSums: Record<string, number>; expSums: Record<string, number>; revGbp: number; expGbp: number }
}) {
  const periodLabel =
    visibleMonths.length === MONTHS.length
      ? 'YTD'
      : visibleMonths.length === 1
      ? visibleMonths[0]
      : `${visibleMonths.length} months`

  function lineAmountForColumn(line: any, col: Col): number {
    const lineTerritoryId = effectiveTerritoryId(line, state)
    const belongs = col.id === UNASSIGNED_KEY ? !lineTerritoryId : lineTerritoryId === col.id
    if (!belongs) return 0
    const lineCur = effectiveCurrency(line, state)
    const targetCurrency: Currency = col.currency ?? 'GBP'
    let total = 0
    for (const m of visibleMonths) {
      total += convertAmount(line.nativeMonthly[m] ?? 0, lineCur, targetCurrency, state.fxRates)
    }
    return total
  }
  function lineGbpTotal(line: any): number {
    const gbp = toGbp(line, state)
    let t = 0
    for (const m of visibleMonths) t += gbp[m] ?? 0
    return t
  }

  // Per-month accessors (amount in a given territory column's currency for a specific month)
  function operatorMonthInCol(op: RevenueOperator, col: Col, m: Month): number {
    const opTerritoryId = effectiveTerritoryIdForOperator(op, state.territories)
    const belongs = col.id === UNASSIGNED_KEY ? !opTerritoryId : opTerritoryId === col.id
    if (!belongs) return 0
    const opCur: Currency = op.currency ?? 'GBP'
    const target: Currency = col.currency ?? 'GBP'
    const yearly = operatorMonthlyFor(op, year)
    return convertAmount(yearly[m] ?? 0, opCur, target, state.fxRates)
  }
  function groupMonthInCol(g: ReturnType<typeof groupExpenses>[number], col: Col, m: Month): number {
    const target: Currency = col.currency ?? 'GBP'
    let total = 0
    for (const line of g.lines) {
      const lineTerritoryId = effectiveTerritoryId(line, state)
      const belongs = col.id === UNASSIGNED_KEY ? !lineTerritoryId : lineTerritoryId === col.id
      if (!belongs) continue
      const lineCur = effectiveCurrency(line, state)
      total += convertAmount(line.nativeMonthly[m] ?? 0, lineCur, target, state.fxRates)
    }
    return total
  }
  function lineMonthInCol(line: any, col: Col, m: Month): number {
    const lineTerritoryId = effectiveTerritoryId(line, state)
    const belongs = col.id === UNASSIGNED_KEY ? !lineTerritoryId : lineTerritoryId === col.id
    if (!belongs) return 0
    const lineCur = effectiveCurrency(line, state)
    const target: Currency = col.currency ?? 'GBP'
    return convertAmount(line.nativeMonthly[m] ?? 0, lineCur, target, state.fxRates)
  }

  // Revenue rows — by operator or by category
  const revenueRows: { label: string; amounts: Record<string, number>; gbp: number }[] =
    revView === 'operator'
      ? operators.map((op) => ({
          label: op.name,
          amounts: Object.fromEntries(territoryCols.map((c) => [c.id, operatorAmountForColumn(op, c)])),
          gbp: operatorGbpTotal(op),
        }))
      : REVENUE_CATEGORIES
          .map((cat) => {
            const ops = operators.filter((o) => o.category === cat)
            if (ops.length === 0) return null
            const amounts: Record<string, number> = {}
            for (const col of territoryCols) {
              amounts[col.id] = ops.reduce((acc, op) => acc + operatorAmountForColumn(op, col), 0)
            }
            const gbp = ops.reduce((acc, op) => acc + operatorGbpTotal(op), 0)
            if (Object.values(amounts).every((v) => v === 0) && gbp === 0) return null
            return { label: cat, amounts, gbp }
          })
          .filter(Boolean) as { label: string; amounts: Record<string, number>; gbp: number }[]

  const perTerritoryCols = visibleMonths.length + 1 // months + subtotal
  const totalCols = territoryCols.length * perTerritoryCols + 1 // + grand GBP total
  const sectionColSpan = totalCols + 1

  return (
    <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
      <table className="grid">
        <thead>
          <tr>
            <th rowSpan={2} style={{ minWidth: 220 }}>
              <span className="subtle">{periodLabel}</span>
            </th>
            {territoryCols.map((c) => (
              <th
                key={c.id}
                colSpan={perTerritoryCols}
                style={{ textAlign: 'center', borderLeft: '1px solid var(--border)' }}
              >
                {c.name}
                <div className="subtle" style={{ fontSize: 11, fontWeight: 400 }}>
                  ({c.currency ?? 'GBP'})
                </div>
              </th>
            ))}
            <th rowSpan={2} className="num" style={{ borderLeft: '1px solid var(--border)' }}>
              Total
              <div className="subtle" style={{ fontSize: 11, fontWeight: 400 }}>(GBP)</div>
            </th>
          </tr>
          <tr>
            {territoryCols.flatMap((c, tIdx) => [
              ...visibleMonths.map((m, mIdx) => (
                <th
                  key={`${c.id}-${m}`}
                  className="num"
                  style={tIdx === 0 && mIdx === 0 ? { borderLeft: '1px solid var(--border)' } : undefined}
                >
                  {m.slice(0, 3)}
                </th>
              )),
              <th key={`${c.id}-sub`} className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                Total
              </th>,
            ])}
          </tr>
        </thead>
        <tbody>
          <tr className="section-head"><td colSpan={sectionColSpan}>{side} sales revenue</td></tr>
          {revenueRows.length === 0 ? (
            <tr><td colSpan={sectionColSpan} className="subtle" style={{ padding: '10px 14px' }}>
              No {side} operators yet.
            </td></tr>
          ) : revenueRows.map((r) => {
            const operatorsInRow =
              revView === 'operator'
                ? operators.filter((op) => op.name === r.label)
                : operators.filter((op) => op.category === r.label)
            const perMonthForCol = (col: Col, m: Month): number =>
              operatorsInRow.reduce((acc, op) => acc + operatorMonthInCol(op, col, m), 0)
            return (
              <tr key={r.label}>
                <td><strong>{r.label}</strong></td>
                {territoryCols.flatMap((c) => [
                  ...visibleMonths.map((m) => (
                    <td key={`${r.label}-${c.id}-${m}`} className="num">
                      {formatMoney(perMonthForCol(c, m), c.currency ?? 'GBP')}
                    </td>
                  )),
                  <td key={`${r.label}-${c.id}-sub`} className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                    <strong>{formatMoney(r.amounts[c.id] ?? 0, c.currency ?? 'GBP')}</strong>
                  </td>,
                ])}
                <td className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                  <strong>{formatGBP(r.gbp)}</strong>
                </td>
              </tr>
            )
          })}
          <tr className="total-row">
            <td>Total Revenue</td>
            {territoryCols.flatMap((c) => {
              const monthSums = visibleMonths.map((m) =>
                operators.reduce((acc, op) => acc + operatorMonthInCol(op, c, m), 0),
              )
              return [
                ...visibleMonths.map((m, i) => (
                  <td key={`tr-${c.id}-${m}`} className="num">
                    {formatMoney(monthSums[i], c.currency ?? 'GBP')}
                  </td>
                )),
                <td key={`tr-${c.id}-sub`} className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                  {formatMoney(totals.revSums[c.id] ?? 0, c.currency ?? 'GBP')}
                </td>,
              ]
            })}
            <td className="num" style={{ borderLeft: '1px solid var(--border)' }}>
              {formatGBP(totals.revGbp)}
            </td>
          </tr>

          <tr className="section-head"><td colSpan={sectionColSpan}>Costs and expenses</td></tr>
          {costGroups.length === 0 ? (
            <tr><td colSpan={sectionColSpan} className="subtle" style={{ padding: '10px 14px' }}>
              No {side} expenses classified yet.
            </td></tr>
          ) : costGroups.flatMap((g) => {
            const isOpen = expanded.has(g.group)
            const groupRow = (
              <tr key={g.group}>
                <td onClick={() => toggleGroup(g.group)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  <span style={{ display: 'inline-block', width: 14, color: 'var(--muted)' }}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <strong>{g.group}</strong>{' '}
                  <span className="subtle">({g.lines.length} line{g.lines.length === 1 ? '' : 's'})</span>
                </td>
                {territoryCols.flatMap((c) => [
                  ...visibleMonths.map((m) => (
                    <td key={`${g.group}-${c.id}-${m}`} className="num">
                      {formatMoney(groupMonthInCol(g, c, m), c.currency ?? 'GBP')}
                    </td>
                  )),
                  <td key={`${g.group}-${c.id}-sub`} className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                    <strong>{formatMoney(groupAmountForColumn(g, c), c.currency ?? 'GBP')}</strong>
                  </td>,
                ])}
                <td className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                  <strong>{formatGBP(groupGbpTotal(g))}</strong>
                </td>
              </tr>
            )
            if (!isOpen) return [groupRow]
            const children = g.lines.map((line: any) => (
              <tr key={`${g.group}::${line.id}`} style={{ background: '#fbfbfc' }}>
                <td style={{ paddingLeft: 32 }}>
                  <span className="subtle">{line.name}</span>{' '}
                  <span className="subtle" style={{ fontSize: 11 }}>
                    · {line.section} · {effectiveCurrency(line, state)}
                  </span>
                </td>
                {territoryCols.flatMap((c) => [
                  ...visibleMonths.map((m) => (
                    <td key={`${line.id}-${c.id}-${m}`} className="num subtle">
                      {formatMoney(lineMonthInCol(line, c, m), c.currency ?? 'GBP')}
                    </td>
                  )),
                  <td key={`${line.id}-${c.id}-sub`} className="num subtle" style={{ borderLeft: '1px solid var(--border)' }}>
                    {formatMoney(lineAmountForColumn(line, c), c.currency ?? 'GBP')}
                  </td>,
                ])}
                <td className="num subtle" style={{ borderLeft: '1px solid var(--border)' }}>
                  {formatGBP(lineGbpTotal(line))}
                </td>
              </tr>
            ))
            return [groupRow, ...children]
          })}
          <tr className="total-row">
            <td>Total Expenses</td>
            {territoryCols.flatMap((c) => {
              const monthSums = visibleMonths.map((m) =>
                costGroups.reduce((acc, g) => acc + groupMonthInCol(g, c, m), 0),
              )
              return [
                ...visibleMonths.map((m, i) => (
                  <td key={`te-${c.id}-${m}`} className="num">
                    {formatMoney(monthSums[i], c.currency ?? 'GBP')}
                  </td>
                )),
                <td key={`te-${c.id}-sub`} className="num" style={{ borderLeft: '1px solid var(--border)' }}>
                  {formatMoney(totals.expSums[c.id] ?? 0, c.currency ?? 'GBP')}
                </td>,
              ]
            })}
            <td className="num" style={{ borderLeft: '1px solid var(--border)' }}>
              {formatGBP(totals.expGbp)}
            </td>
          </tr>

          <tr className="net-row">
            <td>Net (Revenue - Expenses)</td>
            {territoryCols.flatMap((c) => {
              const revMonth = visibleMonths.map((m) =>
                operators.reduce((acc, op) => acc + operatorMonthInCol(op, c, m), 0),
              )
              const expMonth = visibleMonths.map((m) =>
                costGroups.reduce((acc, g) => acc + groupMonthInCol(g, c, m), 0),
              )
              const subTotal = (totals.revSums[c.id] ?? 0) - (totals.expSums[c.id] ?? 0)
              return [
                ...visibleMonths.map((_, i) => {
                  const v = revMonth[i] - expMonth[i]
                  return (
                    <td key={`net-${c.id}-${i}`} className={`num ${v >= 0 ? 'positive' : 'negative'}`}>
                      {formatMoney(v, c.currency ?? 'GBP')}
                    </td>
                  )
                }),
                <td key={`net-${c.id}-sub`} className={`num ${subTotal >= 0 ? 'positive' : 'negative'}`} style={{ borderLeft: '1px solid var(--border)' }}>
                  <strong>{formatMoney(subTotal, c.currency ?? 'GBP')}</strong>
                </td>,
              ]
            })}
            {(() => {
              const net = totals.revGbp - totals.expGbp
              return (
                <td className={`num ${net >= 0 ? 'positive' : 'negative'}`} style={{ borderLeft: '1px solid var(--border)' }}>
                  <strong>{formatGBP(net)}</strong>
                </td>
              )
            })()}
          </tr>
        </tbody>
      </table>
    </div>
  )
}
