import {
  AppState,
  Currency,
  ExpenseLine,
  MONTHS,
  Month,
  MonthlyByYear,
  MonthlyValues,
  RevenueOperator,
  Territory,
  Year,
  zeroMonthly,
  scaleMonthly,
  sumMonthly,
} from './types'

export function formatGBP(n: number): string {
  return formatMoney(n, 'GBP')
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
  AED: 'د.إ',
  ZAR: 'R',
}

export function formatMoney(n: number, currency: string): string {
  const sym = CURRENCY_SYMBOLS[currency] ?? ''
  if (!Number.isFinite(n) || n === 0) return `${sym}0`
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${sym}${abs.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
}

export function effectiveCurrency(line: ExpenseLine, state: AppState): Currency {
  return state.assignments[line.id]?.currencyOverride ?? line.currency
}

export function operatorMonthlyInGbp(
  monthly: MonthlyValues,
  currency: Currency,
  fxRates: AppState['fxRates'],
): MonthlyValues {
  if (currency === 'GBP') return monthly
  return scaleMonthly(monthly, fxRates[currency] ?? 0)
}

export const DEFAULT_YEAR: Year = '2026'

export function normalizeOperatorMonthly(raw: unknown): MonthlyByYear {
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length === 0) return {}
  // Legacy shape: month-name keys at top level — wrap as DEFAULT_YEAR
  if ((MONTHS as readonly string[]).includes(keys[0])) {
    return { [DEFAULT_YEAR]: obj as MonthlyValues }
  }
  // Assume already year-keyed; coerce children
  const out: MonthlyByYear = {}
  for (const [year, value] of Object.entries(obj)) {
    out[year] = { ...zeroMonthly(), ...((value as MonthlyValues) ?? {}) }
  }
  return out
}

export function operatorMonthlyFor(op: RevenueOperator, year: Year): MonthlyValues {
  const map = op.monthly ?? {}
  if (map[year]) return map[year]
  return zeroMonthly()
}

export function setOperatorMonthlyValue(
  op: RevenueOperator,
  year: Year,
  month: Month,
  value: number,
): MonthlyByYear {
  const cur = op.monthly ?? {}
  const yearly = cur[year] ?? zeroMonthly()
  return { ...cur, [year]: { ...yearly, [month]: value } }
}

export function knownYears(operators: RevenueOperator[]): Year[] {
  const set = new Set<Year>([DEFAULT_YEAR])
  for (const op of operators) {
    for (const y of Object.keys(op.monthly ?? {})) set.add(y)
  }
  return [...set].sort()
}

export function gbpRate(currency: Currency, fxRates: AppState['fxRates']): number {
  if (currency === 'GBP') return 1
  return fxRates[currency] ?? 0
}

export function convertAmount(
  amount: number,
  from: Currency,
  to: Currency,
  fxRates: AppState['fxRates'],
): number {
  if (from === to) return amount
  const fromRate = gbpRate(from, fxRates)
  const toRate = gbpRate(to, fxRates)
  if (!toRate) return 0
  return (amount * fromRate) / toRate
}

export function convertMonthly(
  monthly: MonthlyValues,
  from: Currency,
  to: Currency,
  fxRates: AppState['fxRates'],
): MonthlyValues {
  if (from === to) return monthly
  const out = zeroMonthly()
  for (const m of MONTHS) out[m] = convertAmount(monthly[m] ?? 0, from, to, fxRates)
  return out
}

export function defaultTerritoryFor(
  line: ExpenseLine,
  territories: Territory[],
): Territory | null {
  const section = line.section.toLowerCase().trim()
  const findByHint = (matcher: (t: Territory) => boolean) => territories.find(matcher) ?? null
  if (section.endsWith('- za') || section.includes('africa')) {
    return findByHint((t) => t.currency === 'ZAR' || t.name.toLowerCase().includes('africa'))
  }
  if (section.endsWith('- ie/uk') || section.endsWith('- uk') || section.endsWith('- ie')) {
    return findByHint((t) => t.name.toLowerCase().includes('ie/uk') || t.name.toLowerCase().includes('uk'))
  }
  return null
}

export function effectiveTerritoryId(line: ExpenseLine, state: AppState): string | null {
  const override = state.assignments[line.id]?.territoryId
  if (override === '__none__') return null
  if (override) return override
  const def = defaultTerritoryFor(line, state.territories)
  return def?.id ?? null
}

export function defaultTerritoryForOperator(
  op: RevenueOperator,
  territories: Territory[],
): Territory | null {
  if (op.territoryId) return territories.find((t) => t.id === op.territoryId) ?? null
  return territories.find((t) => t.currency === op.currency) ?? null
}

export function effectiveTerritoryIdForOperator(op: RevenueOperator, territories: Territory[]): string | null {
  if (op.territoryId) return op.territoryId
  const def = defaultTerritoryForOperator(op, territories)
  return def?.id ?? null
}

export function toGbp(line: ExpenseLine, state: AppState): MonthlyValues {
  const cur = effectiveCurrency(line, state)
  if (cur === 'GBP') return line.nativeMonthly
  const rate = state.fxRates[cur]
  return scaleMonthly(line.nativeMonthly, rate ?? 0)
}

export function defaultGroupFor(line: ExpenseLine): string {
  return line.section
}

export interface GroupedTotals {
  group: string
  monthly: MonthlyValues
  lines: ExpenseLine[]
}

export function groupExpenses(
  state: AppState,
  filter: 'B2B' | 'B2C',
): GroupedTotals[] {
  const groups = new Map<string, GroupedTotals>()
  for (const line of state.expenses) {
    const assignment = state.assignments[line.id]
    if (!assignment || assignment.classification !== filter) continue
    const group = assignment.group?.trim() || defaultGroupFor(line)
    const existing = groups.get(group) ?? {
      group,
      monthly: zeroMonthly(),
      lines: [],
    }
    existing.monthly = sumMonthly(existing.monthly, toGbp(line, state))
    existing.lines.push(line)
    groups.set(group, existing)
  }
  const sorted = [...groups.values()].sort((a, b) => a.group.localeCompare(b.group))
  for (const g of sorted) {
    g.lines.sort((a, b) => a.name.localeCompare(b.name))
  }
  return sorted
}

export function totalAcross(groups: { monthly: MonthlyValues }[]): MonthlyValues {
  let acc = zeroMonthly()
  for (const g of groups) acc = sumMonthly(acc, g.monthly)
  return acc
}

export function uniqueGroups(state: AppState): string[] {
  const set = new Set<string>()
  for (const line of state.expenses) {
    const a = state.assignments[line.id]
    if (a?.group) set.add(a.group)
    else set.add(defaultGroupFor(line))
  }
  for (const g of state.customGroups) set.add(g)
  return [...set].sort()
}

export interface GroupSummary {
  name: string
  total: number
  b2b: number
  b2c: number
  unassigned: number
  custom: boolean
}

export function summariseGroups(state: AppState): GroupSummary[] {
  const counts = new Map<string, { b2b: number; b2c: number; unassigned: number }>()
  for (const line of state.expenses) {
    const a = state.assignments[line.id]
    const group = a?.group?.trim() || defaultGroupFor(line)
    const cls = a?.classification ?? 'Unassigned'
    const bucket = counts.get(group) ?? { b2b: 0, b2c: 0, unassigned: 0 }
    if (cls === 'B2B') bucket.b2b++
    else if (cls === 'B2C') bucket.b2c++
    else bucket.unassigned++
    counts.set(group, bucket)
  }
  const all = new Set<string>([...counts.keys(), ...state.customGroups])
  const customSet = new Set(state.customGroups)
  return [...all]
    .map((name) => {
      const c = counts.get(name) ?? { b2b: 0, b2c: 0, unassigned: 0 }
      return {
        name,
        b2b: c.b2b,
        b2c: c.b2c,
        unassigned: c.unassigned,
        total: c.b2b + c.b2c + c.unassigned,
        custom: customSet.has(name),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function monthlyCols() {
  return MONTHS
}

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const escape = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'number' ? String(v) : v
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  return rows.map((r) => r.map(escape).join(',')).join('\n')
}

export function downloadCsv(filename: string, csv: string) {
  // UTF-8 BOM so Excel opens non-ASCII characters (£, €, −, accents) correctly
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
