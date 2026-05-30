import { read, utils } from 'xlsx'
import { Currency, ExpenseLine, MONTHS, MonthlyValues, zeroMonthly } from './types'

export async function parseExcel(file: File): Promise<{ expenses: ExpenseLine[] }> {
  const buf = await file.arrayBuffer()
  const wb = read(buf, { type: 'array' })
  const sheet = wb.Sheets['Expense breakdown']
  if (!sheet) throw new Error('Expense breakdown sheet not found')
  const rows = utils.sheet_to_json<any[]>(sheet, { header: 1, blankrows: true, defval: null })
  return { expenses: parseExpenseRows(rows) }
}

function isMonthString(v: unknown): boolean {
  return typeof v === 'string' && (MONTHS as readonly string[]).includes(v.trim())
}

function parseExpenseRows(rows: any[][]): ExpenseLine[] {
  const expenses: ExpenseLine[] = []

  type SectionSpan = { name: string; start: number; end: number }
  const sections: SectionSpan[] = []

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? []
    const a = row[0]
    const b = row[1]
    if (
      typeof a === 'string' &&
      a.trim() !== '' &&
      !isMonthString(a) &&
      (b === null || b === undefined || b === '')
    ) {
      sections.push({ name: a.trim(), start: r, end: rows.length })
      if (sections.length > 1) sections[sections.length - 2].end = r
    }
  }

  const idCounts: Record<string, number> = {}

  for (const section of sections) {
    const monthCols: Record<string, number> = {}
    let headerFound = false
    let currencyFromTotal: Currency | null = null
    const items: { name: string; monthly: MonthlyValues }[] = []

    for (let r = section.start + 1; r < section.end; r++) {
      const row = rows[r] ?? []

      if (!headerFound) {
        for (let ci = 2; ci < row.length; ci++) {
          const v = row[ci]
          if (typeof v === 'string' && (MONTHS as readonly string[]).includes(v.trim())) {
            monthCols[v.trim()] = ci
          }
        }
        if (Object.keys(monthCols).length > 0) headerFound = true
        continue
      }

      const a = row[0]
      const b = row[1]

      if (typeof b === 'string') {
        const bt = b.trim()
        const btLower = bt.toLowerCase()
        if (btLower.startsWith('total in ')) {
          const cur = bt.substring('Total in '.length).toUpperCase().trim() as Currency
          if (cur !== 'GBP' && !currencyFromTotal) currencyFromTotal = cur
          continue
        }
        if (btLower.startsWith('total')) continue
        if (['agents', 'ie', 'uk', 'za'].includes(btLower)) continue
      }

      if (typeof a !== 'number') continue
      if (typeof b !== 'string' || !b.trim()) continue

      const name = b.trim()
      const monthly = zeroMonthly()
      let anyValue = false
      for (const m of MONTHS) {
        const idx = monthCols[m]
        if (idx === undefined) continue
        const v = row[idx]
        if (typeof v === 'number' && !Number.isNaN(v)) {
          monthly[m] = v
          if (v !== 0) anyValue = true
        }
      }
      if (!anyValue) continue
      items.push({ name, monthly })
    }

    const currency: Currency = currencyFromTotal ?? 'GBP'

    for (const item of items) {
      const baseId = `${section.name}::${currency}::${item.name}`
      idCounts[baseId] = (idCounts[baseId] ?? 0) + 1
      const id = idCounts[baseId] === 1 ? baseId : `${baseId}#${idCounts[baseId]}`
      expenses.push({
        id,
        section: section.name,
        name: item.name,
        currency,
        nativeMonthly: item.monthly,
      })
    }
  }

  return expenses
}
