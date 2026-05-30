import { useState } from 'react'
import { ExpensesView } from './components/ExpensesView'
import { RevenueView } from './components/RevenueView'
import { PnLView } from './components/PnLView'
import { SettingsView } from './components/SettingsView'
import { GroupsView } from './components/GroupsView'
import { BillingView } from './components/BillingView'
import { SyncStatus, useAppState } from './store'
import { knownYears } from './utils'

type Tab = 'expenses' | 'groups' | 'revenue' | 'pnlB2B' | 'pnlB2C' | 'billing' | 'settings'

function YearSwitcher({
  operators,
  currentYear,
  onSelect,
}: {
  operators: any[]
  currentYear: string
  onSelect: (y: string) => void
}) {
  const years = knownYears(operators)
  if (!years.includes(currentYear)) years.push(currentYear)
  years.sort()
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <label className="subtle" style={{ fontSize: 11 }}>Year</label>
      <select value={currentYear} onChange={(e) => onSelect(e.target.value)}>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </span>
  )
}

function SyncBadge({ status, error }: { status: SyncStatus; error: string | null }) {
  const label = status === 'loading' ? 'Loading…' : status === 'offline' ? 'Offline' : 'Saved'
  const color = status === 'offline' ? '#c026d3' : status === 'loading' ? '#6b7480' : '#0f766e'
  return (
    <span title={error ?? ''} style={{ color, fontWeight: 600 }}>
      ● {label}
    </span>
  )
}

export function App() {
  const {
    state,
    ui,
    setCurrentYear,
    setHiddenMonths,
    syncStatus,
    lastError,
    addManualExpense,
    updateExpense,
    deleteExpense,
    setAssignment,
    bulkSetClassification,
    bulkSetGroup,
    bulkSetCurrency,
    addOperator,
    updateOperator,
    removeOperator,
    reorderOperators,
    moveOperator,
    setFxRate,
    addCustomGroup,
    renameCustomGroup,
    deleteCustomGroup,
    addTerritory,
    updateTerritory,
    deleteTerritory,
    bulkSetTerritory,
    addApiConnection,
    patchApiConnection,
    removeApiConnection,
    refreshApiConnections,
    resetAll,
  } = useAppState()

  const [tab, setTab] = useState<Tab>('expenses')

  return (
    <div className="app">
      <header className="topbar">
        <h1>Swifty P&L</h1>
        <nav className="tabs">
          <button className={`tab-btn ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>Expenses</button>
          <button className={`tab-btn ${tab === 'groups' ? 'active' : ''}`} onClick={() => setTab('groups')}>Groups</button>
          <button className={`tab-btn ${tab === 'revenue' ? 'active' : ''}`} onClick={() => setTab('revenue')}>Revenue</button>
          <button className={`tab-btn ${tab === 'pnlB2B' ? 'active' : ''}`} onClick={() => setTab('pnlB2B')}>B2B P&L</button>
          <button className={`tab-btn ${tab === 'pnlB2C' ? 'active' : ''}`} onClick={() => setTab('pnlB2C')}>B2C P&L</button>
          <button className={`tab-btn ${tab === 'billing' ? 'active' : ''}`} onClick={() => setTab('billing')}>Billing</button>
          <button className={`tab-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
        </nav>
        <div className="meta">
          <YearSwitcher
            operators={state.operators}
            currentYear={ui.currentYear}
            onSelect={setCurrentYear}
          />
          <SyncBadge status={syncStatus} error={lastError} />
        </div>
      </header>

      <main className="main">
        {tab === 'expenses' && (
          <ExpensesView
            state={state}
            hiddenMonths={ui.hiddenMonths}
            setHiddenMonths={setHiddenMonths}
            setAssignment={setAssignment}
            bulkSetClassification={bulkSetClassification}
            bulkSetGroup={bulkSetGroup}
            bulkSetCurrency={bulkSetCurrency}
            bulkSetTerritory={bulkSetTerritory}
            addCustomGroup={addCustomGroup}
            addManualExpense={addManualExpense}
            updateExpense={updateExpense}
            deleteExpense={deleteExpense}
          />
        )}
        {tab === 'groups' && (
          <GroupsView
            state={state}
            addCustomGroup={addCustomGroup}
            renameCustomGroup={renameCustomGroup}
            deleteCustomGroup={deleteCustomGroup}
            deleteExpense={deleteExpense}
          />
        )}
        {tab === 'revenue' && (
          <RevenueView
            state={state}
            year={ui.currentYear}
            hiddenMonths={ui.hiddenMonths}
            setHiddenMonths={setHiddenMonths}
            addOperator={addOperator}
            updateOperator={updateOperator}
            removeOperator={removeOperator}
            reorderOperators={reorderOperators}
            moveOperator={moveOperator}
          />
        )}
        {tab === 'pnlB2B' && (
          <PnLView
            state={state}
            side="B2B"
            year={ui.currentYear}
            hiddenMonths={ui.hiddenMonths}
            setHiddenMonths={setHiddenMonths}
          />
        )}
        {tab === 'pnlB2C' && (
          <PnLView
            state={state}
            side="B2C"
            year={ui.currentYear}
            hiddenMonths={ui.hiddenMonths}
            setHiddenMonths={setHiddenMonths}
          />
        )}
        {tab === 'billing' && (
          <BillingView state={state} year={ui.currentYear} />
        )}
        {tab === 'settings' && (
          <SettingsView
            state={state}
            currentYear={ui.currentYear}
            setCurrentYear={setCurrentYear}
            setFxRate={setFxRate}
            addTerritory={addTerritory}
            updateTerritory={updateTerritory}
            deleteTerritory={deleteTerritory}
            addApiConnection={addApiConnection}
            patchApiConnection={patchApiConnection}
            removeApiConnection={removeApiConnection}
            refreshApiConnections={refreshApiConnections}
            resetAll={resetAll}
          />
        )}
      </main>
    </div>
  )
}
