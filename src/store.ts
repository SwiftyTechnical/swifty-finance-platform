import { useEffect, useState, useCallback, useRef } from 'react'
import {
  AppState,
  Currency,
  ExpenseLine,
  ExpenseAssignment,
  Month,
  RevenueOperator,
  Territory,
  FxRates,
  NonGbpCurrency,
  Year,
} from './types'
import * as api from './api'
import { normalizeOperatorMonthly, DEFAULT_YEAR } from './utils'

const STORAGE_KEY = 'swifty-pnl-state-v1'
const UI_STORAGE_KEY = 'swifty-pnl-ui-v1'

export interface UiPrefs {
  currentYear: Year
  hiddenMonths: Month[]
}

const defaultUi: UiPrefs = { currentYear: DEFAULT_YEAR, hiddenMonths: [] }

function loadUi(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY)
    if (!raw) return defaultUi
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return { ...defaultUi, ...parsed }
  } catch {
    return defaultUi
  }
}

function saveUi(u: UiPrefs) {
  try { localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(u)) } catch {}
}

function normalizeOperators(ops: RevenueOperator[]): RevenueOperator[] {
  return ops.map((o) => ({ ...o, monthly: normalizeOperatorMonthly(o.monthly) }))
}

const defaultFxRates: FxRates = {
  AED: 0.21,
  ZAR: 0.043,
  EUR: 0.86,
  USD: 0.79,
}

const defaultState: AppState = {
  expenses: [],
  operators: [],
  assignments: {},
  customGroups: [],
  territories: [],
  fxRates: defaultFxRates,
  apiConnections: [],
}

function loadLocal(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultState
    const parsed = JSON.parse(raw) as Partial<AppState>
    return {
      ...defaultState,
      ...parsed,
      fxRates: { ...defaultFxRates, ...(parsed.fxRates ?? {}) },
      assignments: parsed.assignments ?? {},
      operators: parsed.operators ?? [],
      expenses: parsed.expenses ?? [],
      customGroups: parsed.customGroups ?? [],
      territories: parsed.territories ?? [],
      apiConnections: parsed.apiConnections ?? [],
    }
  } catch {
    return defaultState
  }
}

function saveLocal(s: AppState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch (e) {
    console.warn('Failed to cache state locally', e)
  }
}

function hasMeaningfulData(s: AppState): boolean {
  return (
    s.expenses.length > 0 ||
    s.operators.length > 0 ||
    Object.keys(s.assignments).length > 0 ||
    s.customGroups.length > 0
  )
}

function mergeServerWithDefaults(remote: Partial<AppState>): AppState {
  return {
    ...defaultState,
    ...remote,
    fxRates: { ...defaultFxRates, ...(remote.fxRates ?? {}) },
    assignments: remote.assignments ?? {},
    operators: remote.operators ?? [],
    expenses: remote.expenses ?? [],
    customGroups: remote.customGroups ?? [],
    territories: remote.territories ?? [],
    apiConnections: remote.apiConnections ?? [],
  }
}

export type SyncStatus = 'loading' | 'ready' | 'offline' | 'migrated'

export function useAppState() {
  const [state, setState] = useState<AppState>(() => {
    const loaded = loadLocal()
    return { ...loaded, operators: normalizeOperators(loaded.operators) }
  })
  const [ui, setUi] = useState<UiPrefs>(() => loadUi())
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('loading')
  const [lastError, setLastError] = useState<string | null>(null)
  const bootstrapped = useRef(false)

  useEffect(() => { saveUi(ui) }, [ui])

  const setCurrentYear = useCallback((y: Year) => setUi((u) => ({ ...u, currentYear: y })), [])
  const setHiddenMonths = useCallback((hm: Month[]) => setUi((u) => ({ ...u, hiddenMonths: hm })), [])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    ;(async () => {
      try {
        const remoteRaw = mergeServerWithDefaults(await api.fetchState())
        const remote = { ...remoteRaw, operators: normalizeOperators(remoteRaw.operators) }
        const local = loadLocal()
        local.operators = normalizeOperators(local.operators)
        if (!hasMeaningfulData(remote) && hasMeaningfulData(local)) {
          const { seeded } = await api.seedState(local)
          if (seeded) {
            setState(local)
            setSyncStatus('migrated')
            return
          }
        }
        setState(remote)
        saveLocal(remote)
        setSyncStatus('ready')
      } catch (e: any) {
        console.warn('Server unavailable, using local cache', e)
        setLastError(e?.message ?? String(e))
        setSyncStatus('offline')
      }
    })()
  }, [])

  useEffect(() => {
    saveLocal(state)
  }, [state])

  function report(fn: () => Promise<void>) {
    fn().catch((e) => {
      console.warn('API write failed (kept locally)', e)
      setLastError(e?.message ?? String(e))
    })
  }

  const setExpenses = useCallback((expenses: ExpenseLine[], fileName?: string) => {
    const importedAt = new Date().toISOString()
    const excelMarked = expenses.map((e) => ({ ...e, source: 'excel' as const }))
    setState((s) => {
      const manual = s.expenses.filter((e) => e.source === 'manual')
      return {
        ...s,
        expenses: [...excelMarked, ...manual],
        excelFileName: fileName ?? s.excelFileName,
        lastImportedAt: importedAt,
      }
    })
    report(() => api.pushExpenses(excelMarked, fileName, importedAt))
  }, [])

  const addManualExpense = useCallback((line: ExpenseLine) => {
    const withSource: ExpenseLine = { ...line, source: 'manual' }
    setState((s) => ({ ...s, expenses: [...s.expenses, withSource] }))
    report(() => api.createManualExpense(withSource))
  }, [])

  const updateExpense = useCallback((id: string, patch: Partial<ExpenseLine>) => {
    setState((s) => ({
      ...s,
      expenses: s.expenses.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }))
    report(() => api.patchExpense(id, patch))
  }, [])

  const deleteExpense = useCallback((id: string) => {
    setState((s) => {
      const assignments = { ...s.assignments }
      delete assignments[id]
      return {
        ...s,
        expenses: s.expenses.filter((e) => e.id !== id),
        assignments,
      }
    })
    report(() => api.removeExpense(id))
  }, [])

  const setAssignment = useCallback((id: string, patch: Partial<ExpenseAssignment>) => {
    setState((s) => {
      const current = s.assignments[id] ?? { classification: 'Unassigned', group: '' }
      const next: ExpenseAssignment = { ...current, ...patch }
      report(() => api.putAssignment(id, next))
      return { ...s, assignments: { ...s.assignments, [id]: next } }
    })
  }, [])

  const bulkSetClassification = useCallback(
    (ids: string[], classification: ExpenseAssignment['classification']) => {
      setState((s) => {
        const assignments = { ...s.assignments }
        const patches: { id: string; classification: ExpenseAssignment['classification']; group?: string }[] = []
        for (const id of ids) {
          const cur = assignments[id] ?? { classification: 'Unassigned', group: '' }
          const next = { ...cur, classification }
          assignments[id] = next
          patches.push({ id, classification: next.classification, group: next.group })
        }
        report(() => api.bulkAssignments(patches))
        return { ...s, assignments }
      })
    },
    [],
  )

  const bulkSetGroup = useCallback((ids: string[], group: string) => {
    setState((s) => {
      const assignments = { ...s.assignments }
      const patches: { id: string; classification: ExpenseAssignment['classification']; group: string; currencyOverride?: Currency }[] = []
      for (const id of ids) {
        const cur = assignments[id] ?? { classification: 'Unassigned', group: '' }
        const next = { ...cur, group }
        assignments[id] = next
        patches.push({ id, classification: next.classification, group, currencyOverride: next.currencyOverride })
      }
      report(() => api.bulkAssignments(patches))
      return { ...s, assignments }
    })
  }, [])

  const bulkSetCurrency = useCallback((ids: string[], currency: Currency) => {
    setState((s) => {
      const assignments = { ...s.assignments }
      const patches: { id: string; classification: ExpenseAssignment['classification']; group: string; currencyOverride?: Currency }[] = []
      for (const id of ids) {
        const line = s.expenses.find((e) => e.id === id)
        const cur = assignments[id] ?? { classification: 'Unassigned', group: '' }
        const isDefault = line && currency === line.currency
        const next: ExpenseAssignment = { ...cur, currencyOverride: isDefault ? undefined : currency }
        assignments[id] = next
        patches.push({ id, classification: next.classification, group: next.group, currencyOverride: next.currencyOverride })
      }
      report(() => api.bulkAssignments(patches))
      return { ...s, assignments }
    })
  }, [])

  const addOperator = useCallback((op: RevenueOperator) => {
    setState((s) => ({ ...s, operators: [...s.operators, op] }))
    report(() => api.createOperator(op))
  }, [])

  const updateOperator = useCallback((id: string, patch: Partial<RevenueOperator>) => {
    setState((s) => ({
      ...s,
      operators: s.operators.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    }))
    report(() => api.patchOperator(id, patch))
  }, [])

  const removeOperator = useCallback((id: string) => {
    setState((s) => ({ ...s, operators: s.operators.filter((o) => o.id !== id) }))
    report(() => api.deleteOperator(id))
  }, [])

  const reorderOperators = useCallback((ids: string[]) => {
    setState((s) => {
      const byId = new Map(s.operators.map((o) => [o.id, o]))
      const reordered = ids.map((id) => byId.get(id)).filter(Boolean) as RevenueOperator[]
      const missing = s.operators.filter((o) => !ids.includes(o.id))
      return { ...s, operators: [...reordered, ...missing] }
    })
    report(() => api.reorderOperators(ids))
  }, [])

  const moveOperator = useCallback((id: string, direction: 'up' | 'down') => {
    setState((s) => {
      const idx = s.operators.findIndex((o) => o.id === id)
      if (idx === -1) return s
      const swapWith = direction === 'up' ? idx - 1 : idx + 1
      if (swapWith < 0 || swapWith >= s.operators.length) return s
      const next = [...s.operators]
      const [removed] = next.splice(idx, 1)
      next.splice(swapWith, 0, removed)
      report(() => api.reorderOperators(next.map((o) => o.id)))
      return { ...s, operators: next }
    })
  }, [])

  const setFxRate = useCallback((currency: NonGbpCurrency, rate: number) => {
    setState((s) => ({ ...s, fxRates: { ...s.fxRates, [currency]: rate } }))
    report(() => api.putFxRate(currency, rate))
  }, [])

  const addCustomGroup = useCallback((name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setState((s) => {
      if (s.customGroups.includes(trimmed)) return s
      return { ...s, customGroups: [...s.customGroups, trimmed].sort() }
    })
    report(() => api.createCustomGroup(trimmed))
  }, [])

  const renameCustomGroup = useCallback((oldName: string, newName: string) => {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) return
    setState((s) => {
      const customGroups = [...new Set(s.customGroups.map((g) => (g === oldName ? trimmed : g)))]
      if (!customGroups.includes(trimmed)) customGroups.push(trimmed)
      const assignments = { ...s.assignments }
      for (const [id, a] of Object.entries(assignments)) {
        if (a.group === oldName) assignments[id] = { ...a, group: trimmed }
      }
      return { ...s, customGroups: customGroups.sort(), assignments }
    })
    report(() => api.renameCustomGroup(oldName, trimmed))
  }, [])

  const deleteCustomGroup = useCallback((name: string) => {
    setState((s) => ({
      ...s,
      customGroups: s.customGroups.filter((g) => g !== name),
    }))
    report(() => api.deleteCustomGroup(name))
  }, [])

  const addTerritory = useCallback((t: Omit<Territory, 'id' | 'sortOrder'> & { id?: string }) => {
    const id = t.id ?? 't_' + Math.random().toString(36).slice(2, 10)
    const territory: Territory = {
      id,
      name: t.name.trim(),
      currency: t.currency,
      shortCode: t.shortCode?.trim() || undefined,
    }
    if (!territory.name) return
    setState((s) => ({ ...s, territories: [...s.territories, territory] }))
    report(() => api.createTerritory(territory))
  }, [])

  const updateTerritory = useCallback((id: string, patch: Partial<Territory>) => {
    setState((s) => ({
      ...s,
      territories: s.territories.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }))
    report(() => api.patchTerritory(id, patch))
  }, [])

  const deleteTerritory = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      territories: s.territories.filter((t) => t.id !== id),
      assignments: Object.fromEntries(
        Object.entries(s.assignments).map(([k, a]) => [
          k,
          a.territoryId === id ? { ...a, territoryId: undefined } : a,
        ]),
      ),
      operators: s.operators.map((o) => (o.territoryId === id ? { ...o, territoryId: undefined } : o)),
    }))
    report(() => api.removeTerritory(id))
  }, [])

  const bulkSetTerritory = useCallback((ids: string[], territoryId: string) => {
    setState((s) => {
      const assignments = { ...s.assignments }
      const patches: { id: string; classification: ExpenseAssignment['classification']; group: string; currencyOverride?: Currency; territoryId?: string }[] = []
      for (const id of ids) {
        const cur = assignments[id] ?? { classification: 'Unassigned', group: '' }
        const next: ExpenseAssignment = { ...cur, territoryId: territoryId || undefined }
        assignments[id] = next
        patches.push({
          id,
          classification: next.classification,
          group: next.group,
          currencyOverride: next.currencyOverride,
          territoryId: next.territoryId,
        })
      }
      report(() => api.bulkAssignments(patches))
      return { ...s, assignments }
    })
  }, [])

  const refreshApiConnections = useCallback(async () => {
    try {
      const list = await api.listConnections()
      setState((s) => ({ ...s, apiConnections: list }))
    } catch (e: any) {
      setLastError(e?.message ?? String(e))
    }
  }, [])

  const addApiConnection = useCallback(
    async (input: { name: string; baseUrl: string; apiKey: string }) => {
      const id = 'c_' + Math.random().toString(36).slice(2, 10)
      await api.createConnection({ id, ...input })
      await refreshApiConnections()
      return id
    },
    [refreshApiConnections],
  )

  const patchApiConnection = useCallback(
    async (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string }) => {
      await api.patchConnection(id, patch)
      await refreshApiConnections()
    },
    [refreshApiConnections],
  )

  const removeApiConnection = useCallback(
    async (id: string) => {
      await api.deleteConnection(id)
      await refreshApiConnections()
    },
    [refreshApiConnections],
  )

  return {
    state,
    ui,
    setCurrentYear,
    setHiddenMonths,
    syncStatus,
    lastError,
    setExpenses,
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
  }
}
