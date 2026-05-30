import { useMemo, useState } from 'react'
import { AppState, Classification, Currency, CURRENCIES, ExpenseLine, MONTHS, Month, zeroMonthly } from '../types'
import {
  downloadCsv,
  formatGBP,
  formatMoney,
  round2,
  toCsv,
  toGbp,
  defaultGroupFor,
  defaultTerritoryFor,
  effectiveCurrency,
  effectiveTerritoryId,
  uniqueGroups,
} from '../utils'

function manualId() {
  return 'manual_' + Math.random().toString(36).slice(2, 10)
}

type ValueMode = 'both' | 'native' | 'gbp'

function MoneyCell({
  native,
  gbp,
  currency,
  mode,
}: {
  native: number
  gbp: number
  currency: string
  mode: ValueMode
}) {
  if (currency === 'GBP' || mode === 'gbp') {
    return <>{formatGBP(gbp)}</>
  }
  if (mode === 'native') {
    return <>{formatMoney(native, currency)}</>
  }
  return (
    <div style={{ lineHeight: 1.25 }}>
      <div>{formatMoney(native, currency)}</div>
      <div className="subtle" style={{ fontSize: 11 }}>{formatGBP(gbp)}</div>
    </div>
  )
}

interface Props {
  state: AppState
  hiddenMonths: Month[]
  setHiddenMonths: (hm: Month[]) => void
  setAssignment: (
    id: string,
    patch: { classification?: Classification; group?: string; currencyOverride?: Currency; territoryId?: string },
  ) => void
  bulkSetClassification: (ids: string[], c: Classification) => void
  bulkSetGroup: (ids: string[], group: string) => void
  bulkSetCurrency: (ids: string[], currency: Currency) => void
  bulkSetTerritory: (ids: string[], territoryId: string) => void
  addCustomGroup: (name: string) => void
  addManualExpense: (line: ExpenseLine) => void
  updateExpense: (id: string, patch: Partial<ExpenseLine>) => void
  deleteExpense: (id: string) => void
}

export function ExpensesView({
  state,
  hiddenMonths,
  setHiddenMonths,
  setAssignment,
  bulkSetClassification,
  bulkSetGroup,
  bulkSetCurrency,
  bulkSetTerritory,
  addCustomGroup,
  addManualExpense,
  updateExpense,
  deleteExpense,
}: Props) {
  const [showMonthFilter, setShowMonthFilter] = useState(false)
  const visibleMonths: Month[] = MONTHS.filter((m) => !hiddenMonths.includes(m))
  const hiddenSet = new Set(hiddenMonths)
  function toggleMonth(m: Month) {
    const next = new Set(hiddenSet)
    if (next.has(m)) next.delete(m); else next.add(m)
    setHiddenMonths(MONTHS.filter((mm) => next.has(mm)))
  }
  const [search, setSearch] = useState('')
  const [filterClass, setFilterClass] = useState<Classification | 'All'>('All')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [newGroup, setNewGroup] = useState('')
  const [valueMode, setValueMode] = useState<ValueMode>('both')
  const [showAddForm, setShowAddForm] = useState(false)
  const [draft, setDraft] = useState<{
    name: string; section: string; currency: Currency; monthly: Record<Month, number>
  }>({
    name: '',
    section: 'Manual entries',
    currency: 'GBP',
    monthly: zeroMonthly(),
  })

  function resetDraft() {
    setDraft({ name: '', section: 'Manual entries', currency: 'GBP', monthly: zeroMonthly() })
  }

  function submitDraft() {
    if (!draft.name.trim()) return
    const line: ExpenseLine = {
      id: manualId(),
      section: draft.section.trim() || 'Manual entries',
      name: draft.name.trim(),
      currency: draft.currency,
      source: 'manual',
      nativeMonthly: draft.monthly,
    }
    addManualExpense(line)
    resetDraft()
    setShowAddForm(false)
  }

  const sections = useMemo(() => {
    const s = new Set<string>()
    for (const e of state.expenses) s.add(e.section)
    return ['All', ...[...s].sort()]
  }, [state.expenses])

  const groups = useMemo(() => uniqueGroups(state), [state])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return state.expenses.filter((e) => {
      if (q && !(e.name.toLowerCase().includes(q) || e.section.toLowerCase().includes(q))) return false
      const a = state.assignments[e.id]?.classification ?? 'Unassigned'
      if (filterClass !== 'All' && a !== filterClass) return false
      return true
    })
  }, [state, search, filterClass])

  const stats = useMemo(() => {
    let b2b = 0, b2c = 0, un = 0
    let totalB2b = 0, totalB2c = 0, totalUn = 0
    for (const e of state.expenses) {
      const cls = state.assignments[e.id]?.classification ?? 'Unassigned'
      const gbp = toGbp(e, state)
      const total = MONTHS.reduce((acc, m) => acc + gbp[m], 0)
      if (cls === 'B2B') { b2b++; totalB2b += total }
      else if (cls === 'B2C') { b2c++; totalB2c += total }
      else { un++; totalUn += total }
    }
    return { b2b, b2c, un, totalB2b, totalB2c, totalUn }
  }, [state])

  const allVisibleSelected = filtered.length > 0 && filtered.every((e) => selectedIds.has(e.id))

  function toggleAllVisible() {
    if (allVisibleSelected) {
      const next = new Set(selectedIds)
      for (const e of filtered) next.delete(e.id)
      setSelectedIds(next)
    } else {
      const next = new Set(selectedIds)
      for (const e of filtered) next.add(e.id)
      setSelectedIds(next)
    }
  }

  function toggleOne(id: string) {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelectedIds(next)
  }

  const selectedArray = useMemo(() => [...selectedIds], [selectedIds])

  function exportCsv() {
    const header = [
      'Section',
      'Line',
      'Source',
      'Currency (effective)',
      'Currency (original)',
      'Classification',
      'Group',
      'Territory',
      'Territory short code',
      ...MONTHS.map((m) => `${m} (native)`),
      ...MONTHS.map((m) => `${m} (GBP)`),
      'YTD (native)',
      'YTD (GBP)',
    ]
    const rows: (string | number)[][] = [header]
    for (const e of state.expenses) {
      const a = state.assignments[e.id]
      const cur = effectiveCurrency(e, state)
      const gbp = toGbp(e, state)
      const tId = effectiveTerritoryId(e, state)
      const t = tId ? state.territories.find((tt) => tt.id === tId) : undefined
      rows.push([
        e.section,
        e.name,
        e.source ?? 'excel',
        cur,
        e.currency,
        a?.classification ?? 'Unassigned',
        (a?.group?.trim() || defaultGroupFor(e)),
        t?.name ?? '',
        t?.shortCode ?? '',
        ...MONTHS.map((m) => round2(e.nativeMonthly[m] ?? 0)),
        ...MONTHS.map((m) => round2(gbp[m] ?? 0)),
        round2(MONTHS.reduce((acc, m) => acc + (e.nativeMonthly[m] ?? 0), 0)),
        round2(MONTHS.reduce((acc, m) => acc + (gbp[m] ?? 0), 0)),
      ])
    }
    const stamp = new Date().toISOString().slice(0, 10)
    downloadCsv(`expenses-${stamp}.csv`, toCsv(rows))
  }

  return (
    <div>
      <div className="stats-row">
        <div className="stat">
          <div className="stat-label">Total Lines</div>
          <div className="stat-value">{state.expenses.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">B2B</div>
          <div className="stat-value">{stats.b2b}</div>
          <div className="subtle">{formatGBP(stats.totalB2b)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">B2C</div>
          <div className="stat-value">{stats.b2c}</div>
          <div className="subtle">{formatGBP(stats.totalB2c)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Unassigned</div>
          <div className="stat-value">{stats.un}</div>
          <div className="subtle">{formatGBP(stats.totalUn)}</div>
        </div>
      </div>

      <div className="card">
        <div className="filters">
          <input
            type="search"
            placeholder="Search by name or section…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={filterClass} onChange={(e) => setFilterClass(e.target.value as any)}>
            <option value="All">All classifications</option>
            <option value="B2B">B2B</option>
            <option value="B2C">B2C</option>
            <option value="Unassigned">Unassigned</option>
          </select>
          <select value={valueMode} onChange={(e) => setValueMode(e.target.value as ValueMode)}>
            <option value="both">Native + GBP</option>
            <option value="native">Native only</option>
            <option value="gbp">GBP only</option>
          </select>
          <button
            className="btn secondary"
            onClick={() => setShowMonthFilter((v) => !v)}
          >
            Months ({visibleMonths.length}/12) {showMonthFilter ? '▴' : '▾'}
          </button>
          <span className="subtle">{filtered.length} of {state.expenses.length} shown</span>
          <button
            className="btn secondary"
            style={{ marginLeft: 'auto' }}
            onClick={exportCsv}
            disabled={state.expenses.length === 0}
          >
            Export CSV
          </button>
          <button
            className="btn"
            onClick={() => setShowAddForm((v) => !v)}
          >
            {showAddForm ? 'Cancel' : '+ Add expense'}
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

        {showAddForm && (
          <div
            style={{
              border: '1px solid var(--border)',
              background: '#fbfbfc',
              borderRadius: 6,
              padding: 12,
              marginBottom: 12,
            }}
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <input
                className="input-cell"
                placeholder="Expense name (required)"
                autoFocus
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                style={{ maxWidth: 240 }}
              />
              <input
                className="input-cell"
                placeholder="Section (e.g. Manual entries)"
                list="expense-sections"
                value={draft.section}
                onChange={(e) => setDraft((d) => ({ ...d, section: e.target.value }))}
                style={{ maxWidth: 240 }}
              />
              <datalist id="expense-sections">
                {sections.filter((s) => s !== 'All').map((s) => <option key={s} value={s} />)}
              </datalist>
              <select
                value={draft.currency}
                onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value as Currency }))}
              >
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <button className="btn" onClick={submitDraft} disabled={!draft.name.trim()}>Save expense</button>
              <button className="btn secondary" onClick={() => { resetDraft(); setShowAddForm(false) }}>Cancel</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 6 }}>
              {MONTHS.map((m) => (
                <div key={m} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
                  <label className="subtle" style={{ fontSize: 10, marginBottom: 2 }}>{m.slice(0, 3)}</label>
                  <input
                    type="number"
                    step="0.01"
                    className="num-input"
                    value={draft.monthly[m] || ''}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value)
                      setDraft((d) => ({ ...d, monthly: { ...d.monthly, [m]: Number.isFinite(n) ? n : 0 } }))
                    }}
                    style={{ width: '100%' }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedArray.length > 0 && (
          <div className="bulk-bar">
            <strong>{selectedArray.length} selected</strong>
            <span>Assign:</span>
            <button className="btn secondary" onClick={() => bulkSetClassification(selectedArray, 'B2B')}>B2B</button>
            <button className="btn secondary" onClick={() => bulkSetClassification(selectedArray, 'B2C')}>B2C</button>
            <button className="btn secondary" onClick={() => bulkSetClassification(selectedArray, 'Unassigned')}>Unassigned</button>
            <span style={{ marginLeft: 12 }}>Group:</span>
            <input
              type="text"
              placeholder="Group name…"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              style={{ padding: '4px 8px', border: '1px solid var(--border-strong)', borderRadius: 4 }}
            />
            <button
              className="btn secondary"
              disabled={!newGroup.trim()}
              onClick={() => {
                const t = newGroup.trim()
                addCustomGroup(t)
                bulkSetGroup(selectedArray, t)
                setNewGroup('')
              }}
            >Apply group</button>
            <span style={{ marginLeft: 12 }}>Currency:</span>
            <select
              className="select-cell"
              defaultValue=""
              onChange={(e) => {
                if (!e.target.value) return
                bulkSetCurrency(selectedArray, e.target.value as Currency)
                e.target.value = ''
              }}
            >
              <option value="" disabled>Change to…</option>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <span style={{ marginLeft: 12 }}>Territory:</span>
            <select
              className="select-cell"
              defaultValue=""
              onChange={(e) => {
                const val = e.target.value
                if (val === '') return
                bulkSetTerritory(selectedArray, val === '__none__' ? '__none__' : val)
                e.target.value = ''
              }}
            >
              <option value="" disabled>Change to…</option>
              <option value="__none__">(Unassigned)</option>
              {state.territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button className="linkish" onClick={() => setSelectedIds(new Set())} style={{ marginLeft: 'auto' }}>Clear selection</button>
          </div>
        )}

        {state.expenses.length === 0 ? (
          <p className="subtle">Import your Excel file or click <strong>+ Add expense</strong> to enter one manually.</p>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
                  </th>
                  <th>Line</th>
                  <th>Cur</th>
                  {visibleMonths.map((m) => <th key={m} className="num">{m.slice(0, 3)}</th>)}
                  <th className="num">YTD</th>
                  <th>Classification</th>
                  <th>Group</th>
                  <th>Territory</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.flatMap((e) => {
                  const a = state.assignments[e.id]
                  const cls: Classification = a?.classification ?? 'Unassigned'
                  const group = a?.group ?? ''
                  const cur = effectiveCurrency(e, state)
                  const gbp = toGbp(e, state)
                  const ytdGbp = MONTHS.reduce((acc, m) => acc + gbp[m], 0)
                  const ytdNative = MONTHS.reduce((acc, m) => acc + (e.nativeMonthly[m] ?? 0), 0)
                  const selected = selectedIds.has(e.id)
                  const overridden = (state.assignments[e.id]?.currencyOverride ?? null) !== null
                  const mainRow = (
                    <tr key={e.id}>
                      <td>
                        <input type="checkbox" checked={selected} onChange={() => toggleOne(e.id)} />
                      </td>
                      <td>
                        <input
                          className="input-cell"
                          value={e.name}
                          onChange={(ev) => updateExpense(e.id, { name: ev.target.value })}
                          style={{ minWidth: 160, width: '100%' }}
                        />
                      </td>
                      <td>
                        <select
                          className="select-cell"
                          style={{ minWidth: 72, color: overridden ? 'var(--accent)' : undefined, fontWeight: overridden ? 600 : undefined }}
                          value={cur}
                          onChange={(ev) => {
                            const picked = ev.target.value as Currency
                            setAssignment(e.id, { currencyOverride: picked === e.currency ? undefined : picked })
                          }}
                          title={overridden ? `Original: ${e.currency}` : 'Detected from Excel'}
                        >
                          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      {visibleMonths.map((m) => (
                        <td key={m} className="num">
                          <input
                            type="number"
                            step="0.01"
                            className="num-input"
                            value={e.nativeMonthly[m] || ''}
                            onChange={(ev) => {
                              const n = parseFloat(ev.target.value)
                              updateExpense(e.id, {
                                nativeMonthly: { ...e.nativeMonthly, [m]: Number.isFinite(n) ? n : 0 },
                              })
                            }}
                          />
                        </td>
                      ))}
                      <td className="num"><strong><MoneyCell native={ytdNative} gbp={ytdGbp} currency={cur} mode={valueMode} /></strong></td>
                      <td>
                        <select
                          className="select-cell"
                          value={cls}
                          onChange={(ev) => setAssignment(e.id, { classification: ev.target.value as Classification })}
                        >
                          <option>Unassigned</option>
                          <option>B2B</option>
                          <option>B2C</option>
                        </select>
                      </td>
                      <td>
                        <input
                          className="input-cell"
                          list={`groups-${e.id}`}
                          placeholder={defaultGroupFor(e)}
                          value={group}
                          onChange={(ev) => setAssignment(e.id, { group: ev.target.value })}
                        />
                        <datalist id={`groups-${e.id}`}>
                          {groups.map((g) => <option key={g} value={g} />)}
                        </datalist>
                      </td>
                      <td>
                        {(() => {
                          const assignedTerritoryId = state.assignments[e.id]?.territoryId
                          const effectiveId = effectiveTerritoryId(e, state)
                          const def = defaultTerritoryFor(e, state.territories)
                          const isDefault = !assignedTerritoryId && !!def
                          const selectValue =
                            assignedTerritoryId === '__none__'
                              ? '__none__'
                              : assignedTerritoryId || ''
                          return (
                            <select
                              className="select-cell"
                              style={{
                                minWidth: 140,
                                fontStyle: isDefault ? 'italic' : undefined,
                                color: isDefault ? 'var(--muted)' : undefined,
                              }}
                              value={selectValue}
                              onChange={(ev) => {
                                const picked = ev.target.value
                                setAssignment(e.id, { territoryId: picked })
                              }}
                              title={
                                isDefault
                                  ? `Auto-detected from section "${e.section}". Pick to override.`
                                  : effectiveId
                                  ? 'Explicit assignment'
                                  : 'Unassigned'
                              }
                            >
                              <option value="">{def ? `(default: ${def.name})` : '(Unassigned)'}</option>
                              <option value="__none__">(Unassigned — force)</option>
                              {state.territories.map((t) => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </select>
                          )
                        })()}
                      </td>
                      <td className="row-actions">
                        <button
                          className="danger"
                          title={e.source === 'manual' ? 'Delete this manual expense' : 'Delete this expense (will return on next Excel import)'}
                          onClick={() => {
                            const msg = e.source === 'manual'
                              ? `Delete manual expense "${e.name}"?`
                              : `Delete "${e.name}"?\n\nThis row came from the Excel import — it will reappear the next time you re-import the workbook.`
                            if (confirm(msg)) deleteExpense(e.id)
                          }}
                        >Delete</button>
                      </td>
                    </tr>
                  )
                  return [mainRow]
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
