export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

export type Month = typeof MONTHS[number]

export type Classification = 'B2B' | 'B2C' | 'Unassigned'

export type Currency = 'GBP' | 'AED' | 'ZAR' | 'EUR' | 'USD'

export type MonthlyValues = Record<Month, number>

export type Year = string
export type MonthlyByYear = Record<Year, MonthlyValues>

export type ExpenseSource = 'excel' | 'manual'

export interface ExpenseLine {
  id: string
  section: string
  name: string
  currency: Currency
  source?: ExpenseSource
  nativeMonthly: MonthlyValues
}

export const REVENUE_CATEGORIES = [
  'Platform', 'Managed Services', 'Sports', 'Casino', 'KYC', 'Affordability', 'Gateway',
] as const
export type RevenueCategory = typeof REVENUE_CATEGORIES[number]

export interface RevenueOperator {
  id: string
  name: string
  category: RevenueCategory
  classification: 'B2B' | 'B2C'
  currency: Currency
  territoryId?: string
  monthly: MonthlyByYear
}

export interface ExpenseAssignment {
  classification: Classification
  group: string
  currencyOverride?: Currency
  territoryId?: string
}

export const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD', 'AED', 'ZAR']

export interface Territory {
  id: string
  name: string
  currency: Currency
  shortCode?: string
  sortOrder?: number
}

export type NonGbpCurrency = Exclude<Currency, 'GBP'>

export type FxRates = Record<NonGbpCurrency, number>

export interface ApiConnection {
  id: string
  name: string
  baseUrl: string
  apiKeyMasked?: string
  hasKey?: boolean
  clientId?: string
  createdAt?: string
}

export interface AppState {
  expenses: ExpenseLine[]
  operators: RevenueOperator[]
  assignments: Record<string, ExpenseAssignment>
  customGroups: string[]
  territories: Territory[]
  fxRates: FxRates
  apiConnections: ApiConnection[]
  excelFileName?: string
  lastImportedAt?: string
}

export function zeroMonthly(): MonthlyValues {
  const m = {} as MonthlyValues
  for (const month of MONTHS) m[month] = 0
  return m
}

export function sumMonthly(a: MonthlyValues, b: MonthlyValues): MonthlyValues {
  const out = zeroMonthly()
  for (const m of MONTHS) out[m] = (a[m] ?? 0) + (b[m] ?? 0)
  return out
}

export function scaleMonthly(a: MonthlyValues, factor: number): MonthlyValues {
  const out = zeroMonthly()
  for (const m of MONTHS) out[m] = (a[m] ?? 0) * factor
  return out
}

export function totalOfMonthly(a: MonthlyValues): number {
  let t = 0
  for (const m of MONTHS) t += a[m] ?? 0
  return t
}
