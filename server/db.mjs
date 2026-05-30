// Postgres-backed data layer. Public API matches the original SQLite version
// but every function is async. Callers must await.

import pg from 'pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('[db] DATABASE_URL is not set. Set it in .env (e.g. DATABASE_URL=$DATABASE_URL_DEV).')
  process.exit(1)
}

// Postgres returns BIGINT as string by default; coerce to JS number.
pg.types.setTypeParser(20, (v) => (v == null ? null : Number(v)))

// pg v9 reads sslmode from the URL and upgrades require/verify-ca to
// verify-full, which fails on RDS' default cert chain. Strip it so the
// explicit ssl object below wins. sslmode=disable still disables SSL.
const sslDisabled = /[?&]sslmode=disable\b/.test(connectionString)
const cleanConnectionString = connectionString.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '')

export const pool = new pg.Pool({
  connectionString: cleanConnectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  ssl: sslDisabled ? false : { rejectUnauthorized: false },
})

pool.on('error', (err) => console.error('[db] idle client error', err))

const defaultFxRates = { AED: 0.21, ZAR: 0.043, EUR: 0.86, USD: 0.79 }

async function tx(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

function asJson(v) {
  return v === undefined ? null : JSON.stringify(v)
}

// ---- bootstrap / schema check ----------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  section TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'excel',
  monthly_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  classification TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  territory_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  monthly_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  expense_id TEXT PRIMARY KEY,
  classification TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  currency_override TEXT,
  territory_id TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_groups (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS territories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  short_code TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS api_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  client_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_cache (
  connection_id TEXT NOT NULL REFERENCES api_connections(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  year TEXT NOT NULL,
  month INTEGER NOT NULL,
  ok BOOLEAN NOT NULL,
  status INTEGER NOT NULL,
  payload_json JSONB NOT NULL,
  error TEXT,
  fetched_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (connection_id, source, year, month)
);
`

export async function ensureSchema() {
  await pool.query(SCHEMA_SQL)
  await seedDefaultTerritoriesIfEmpty()
}

async function seedDefaultTerritoriesIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM territories')
  if (rows[0].n > 0) return
  await pool.query(
    "INSERT INTO territories (id, name, currency, sort_order, short_code) VALUES ('t_ukie', 'Swifty IE/UK', 'GBP', 1, 'IE/UK')",
  )
  await pool.query(
    "INSERT INTO territories (id, name, currency, sort_order, short_code) VALUES ('t_za', 'Swifty Africa', 'ZAR', 2, 'ZA')",
  )
}

// ---- read --------------------------------------------------------------------

export async function getFullState() {
  const [expensesR, operatorsR, assignmentsR, settingsR, customGroupsR, territoriesR, connectionsR] =
    await Promise.all([
      pool.query('SELECT id, section, name, currency, source, monthly_json FROM expenses'),
      pool.query(
        'SELECT id, name, category, classification, currency, territory_id, monthly_json FROM operators ORDER BY sort_order ASC',
      ),
      pool.query(
        'SELECT expense_id, classification, group_name, currency_override, territory_id FROM assignments',
      ),
      pool.query('SELECT key, value FROM settings'),
      pool.query('SELECT name FROM custom_groups ORDER BY name'),
      pool.query('SELECT id, name, currency, sort_order, short_code FROM territories ORDER BY sort_order, id'),
      pool.query('SELECT id, name, base_url, api_key, client_id, created_at FROM api_connections ORDER BY created_at, id'),
    ])

  const expenses = expensesR.rows.map((r) => ({
    id: r.id,
    section: r.section,
    name: r.name,
    currency: r.currency,
    source: r.source ?? 'excel',
    nativeMonthly: r.monthly_json,
  }))

  const operators = operatorsR.rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    classification: r.classification,
    currency: r.currency ?? 'GBP',
    territoryId: r.territory_id ?? undefined,
    monthly: r.monthly_json,
  }))

  const assignments = {}
  for (const r of assignmentsR.rows) {
    assignments[r.expense_id] = {
      classification: r.classification,
      group: r.group_name,
      currencyOverride: r.currency_override ?? undefined,
      territoryId: r.territory_id ?? undefined,
    }
  }

  const settings = {}
  for (const r of settingsR.rows) settings[r.key] = r.value

  const customGroups = customGroupsR.rows.map((r) => r.name)

  const territories = territoriesR.rows.map((r) => ({
    id: r.id,
    name: r.name,
    currency: r.currency,
    sortOrder: r.sort_order,
    shortCode: r.short_code ?? '',
  }))

  const apiConnections = connectionsR.rows.map((r) => ({
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    apiKeyMasked: maskKey(r.api_key),
    hasKey: !!r.api_key,
    clientId: r.client_id ?? '',
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
  }))

  return {
    expenses,
    operators,
    assignments,
    customGroups,
    territories,
    apiConnections,
    fxRates: { ...defaultFxRates, ...(settings.fxRates ?? {}) },
    excelFileName: settings.excelFileName,
    lastImportedAt: settings.lastImportedAt,
  }
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 8)}••••${key.slice(-4)}`
}

// ---- expenses ----------------------------------------------------------------

export async function replaceExpenses(expenses, excelFileName, lastImportedAt) {
  await tx(async (c) => {
    await c.query("DELETE FROM expenses WHERE source = 'excel'")
    for (const e of expenses) {
      await c.query(
        "INSERT INTO expenses (id, section, name, currency, source, monthly_json) VALUES ($1,$2,$3,$4,'excel',$5::jsonb)",
        [e.id, e.section, e.name, e.currency, asJson(e.nativeMonthly)],
      )
    }
    if (excelFileName) await upsertSettingTx(c, 'excelFileName', excelFileName)
    if (lastImportedAt) await upsertSettingTx(c, 'lastImportedAt', lastImportedAt)
  })
}

export async function insertManualExpense(line) {
  await pool.query(
    "INSERT INTO expenses (id, section, name, currency, source, monthly_json) VALUES ($1,$2,$3,$4,'manual',$5::jsonb)",
    [line.id, line.section, line.name, line.currency, asJson(line.nativeMonthly ?? {})],
  )
}

export async function updateManualExpense(id, patch) {
  const { rows } = await pool.query(
    'SELECT section, name, currency, monthly_json FROM expenses WHERE id = $1',
    [id],
  )
  if (rows.length === 0) return
  const cur = rows[0]
  const next = {
    section: patch.section ?? cur.section,
    name: patch.name ?? cur.name,
    currency: patch.currency ?? cur.currency,
    monthly: patch.nativeMonthly ?? cur.monthly_json,
  }
  await pool.query(
    'UPDATE expenses SET section = $1, name = $2, currency = $3, monthly_json = $4::jsonb WHERE id = $5',
    [next.section, next.name, next.currency, asJson(next.monthly), id],
  )
}

export async function deleteManualExpense(id) {
  await tx(async (c) => {
    await c.query('DELETE FROM expenses WHERE id = $1', [id])
    await c.query('DELETE FROM assignments WHERE expense_id = $1', [id])
  })
}

// ---- assignments -------------------------------------------------------------

export async function upsertAssignment(id, classification, group, currencyOverride, territoryId) {
  await pool.query(
    `INSERT INTO assignments (expense_id, classification, group_name, currency_override, territory_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (expense_id) DO UPDATE SET
       classification = EXCLUDED.classification,
       group_name = EXCLUDED.group_name,
       currency_override = EXCLUDED.currency_override,
       territory_id = EXCLUDED.territory_id`,
    [id, classification, group ?? '', currencyOverride ?? null, territoryId ?? null],
  )
}

export async function bulkUpsertAssignments(patches) {
  await tx(async (c) => {
    for (const p of patches) {
      await c.query(
        `INSERT INTO assignments (expense_id, classification, group_name, currency_override, territory_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (expense_id) DO UPDATE SET
           classification = EXCLUDED.classification,
           group_name = EXCLUDED.group_name,
           currency_override = EXCLUDED.currency_override,
           territory_id = EXCLUDED.territory_id`,
        [p.id, p.classification, p.group ?? '', p.currencyOverride ?? null, p.territoryId ?? null],
      )
    }
  })
}

// ---- territories -------------------------------------------------------------

export async function addTerritory(t) {
  const { rows } = await pool.query('SELECT COALESCE(MAX(sort_order),0)::int AS m FROM territories')
  await pool.query(
    'INSERT INTO territories (id, name, currency, sort_order, short_code) VALUES ($1,$2,$3,$4,$5)',
    [t.id, t.name, t.currency, (rows[0].m ?? 0) + 1, t.shortCode ?? ''],
  )
}

export async function updateTerritory(id, patch) {
  const { rows } = await pool.query(
    'SELECT name, currency, short_code FROM territories WHERE id = $1',
    [id],
  )
  if (rows.length === 0) return
  const cur = rows[0]
  await pool.query(
    'UPDATE territories SET name = $1, currency = $2, short_code = $3 WHERE id = $4',
    [
      patch.name ?? cur.name,
      patch.currency ?? cur.currency,
      patch.shortCode ?? cur.short_code ?? '',
      id,
    ],
  )
}

export async function deleteTerritory(id) {
  await tx(async (c) => {
    await c.query('UPDATE assignments SET territory_id = NULL WHERE territory_id = $1', [id])
    await c.query('UPDATE operators SET territory_id = NULL WHERE territory_id = $1', [id])
    await c.query('DELETE FROM territories WHERE id = $1', [id])
  })
}

// ---- operators ---------------------------------------------------------------

export async function insertOperator(op) {
  const { rows } = await pool.query('SELECT COALESCE(MAX(sort_order),0)::int AS m FROM operators')
  await pool.query(
    'INSERT INTO operators (id, name, category, classification, currency, monthly_json, sort_order, territory_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
    [
      op.id,
      op.name,
      op.category,
      op.classification,
      op.currency ?? 'GBP',
      asJson(op.monthly),
      (rows[0].m ?? 0) + 1,
      op.territoryId ?? null,
    ],
  )
}

export async function reorderOperators(ids) {
  await tx(async (c) => {
    for (let i = 0; i < ids.length; i++) {
      await c.query('UPDATE operators SET sort_order = $1 WHERE id = $2', [i + 1, ids[i]])
    }
  })
}

export async function updateOperator(id, patch) {
  const { rows } = await pool.query(
    'SELECT name, category, classification, currency, territory_id, monthly_json FROM operators WHERE id = $1',
    [id],
  )
  if (rows.length === 0) return
  const cur = rows[0]
  await pool.query(
    'UPDATE operators SET name = $1, category = $2, classification = $3, currency = $4, monthly_json = $5::jsonb, territory_id = $6 WHERE id = $7',
    [
      patch.name ?? cur.name,
      patch.category ?? cur.category,
      patch.classification ?? cur.classification,
      patch.currency ?? cur.currency ?? 'GBP',
      asJson(patch.monthly ?? cur.monthly_json),
      patch.territoryId !== undefined ? patch.territoryId : cur.territory_id,
      id,
    ],
  )
}

export async function deleteOperator(id) {
  await pool.query('DELETE FROM operators WHERE id = $1', [id])
}

// ---- settings ----------------------------------------------------------------

async function upsertSettingTx(client, key, value) {
  await client.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value ?? null)],
  )
}

export async function upsertSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value ?? null)],
  )
}

export async function setFxRate(currency, rate) {
  await tx(async (c) => {
    const { rows } = await c.query("SELECT value FROM settings WHERE key = 'fxRates'")
    const current = rows.length > 0 ? rows[0].value ?? {} : {}
    current[currency] = rate
    await upsertSettingTx(c, 'fxRates', current)
  })
}

// ---- custom groups -----------------------------------------------------------

export async function addCustomGroup(name) {
  const trimmed = String(name).trim()
  if (!trimmed) throw new Error('group name required')
  await pool.query(
    'INSERT INTO custom_groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
    [trimmed],
  )
}

export async function removeCustomGroup(name) {
  await pool.query('DELETE FROM custom_groups WHERE name = $1', [name])
}

export async function renameCustomGroup(oldName, newName) {
  const trimmed = String(newName).trim()
  if (!trimmed) throw new Error('new name required')
  await tx(async (c) => {
    const { rows } = await c.query('SELECT name FROM custom_groups WHERE name = $1', [oldName])
    if (rows.length > 0) {
      await c.query('DELETE FROM custom_groups WHERE name = $1', [oldName])
    }
    await c.query(
      'INSERT INTO custom_groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [trimmed],
    )
    await c.query('UPDATE assignments SET group_name = $1 WHERE group_name = $2', [trimmed, oldName])
  })
}

// ---- API connections ---------------------------------------------------------

export async function listApiConnections() {
  const { rows } = await pool.query(
    'SELECT id, name, base_url, api_key, client_id, created_at FROM api_connections ORDER BY created_at, id',
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    apiKeyMasked: maskKey(r.api_key),
    hasKey: !!r.api_key,
    clientId: r.client_id ?? '',
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
  }))
}

export async function getApiConnectionWithKey(id) {
  const { rows } = await pool.query(
    'SELECT id, name, base_url, api_key, client_id FROM api_connections WHERE id = $1',
    [id],
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    apiKey: r.api_key,
    clientId: r.client_id ?? '',
  }
}

export async function createApiConnection({ id, name, baseUrl, apiKey, clientId }) {
  const trimmedName = String(name ?? '').trim()
  const trimmedUrl = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  const trimmedKey = String(apiKey ?? '').trim()
  const trimmedClientId = String(clientId ?? '').trim()
  if (!id || !trimmedName || !trimmedUrl || !trimmedKey) {
    throw new Error('id, name, baseUrl, apiKey all required')
  }
  await pool.query(
    'INSERT INTO api_connections (id, name, base_url, api_key, client_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, trimmedName, trimmedUrl, trimmedKey, trimmedClientId || null, new Date().toISOString()],
  )
}

export async function updateApiConnection(id, patch) {
  const { rows } = await pool.query(
    'SELECT name, base_url, api_key, client_id FROM api_connections WHERE id = $1',
    [id],
  )
  if (rows.length === 0) return
  const cur = rows[0]
  const name = patch.name !== undefined ? String(patch.name).trim() : cur.name
  const baseUrl = patch.baseUrl !== undefined ? String(patch.baseUrl).trim().replace(/\/+$/, '') : cur.base_url
  const apiKey = patch.apiKey ? String(patch.apiKey).trim() : cur.api_key
  const clientId =
    patch.clientId !== undefined ? String(patch.clientId).trim() || null : cur.client_id
  await pool.query(
    'UPDATE api_connections SET name = $1, base_url = $2, api_key = $3, client_id = $4 WHERE id = $5',
    [name, baseUrl, apiKey, clientId, id],
  )
}

export async function deleteApiConnection(id) {
  // billing_cache rows cascade via FK
  await pool.query('DELETE FROM api_connections WHERE id = $1', [id])
}

// ---- billing cache -----------------------------------------------------------

export async function getBillingCacheForYear(connectionId, year) {
  const { rows } = await pool.query(
    'SELECT source, month, ok, status, payload_json, error, fetched_at FROM billing_cache WHERE connection_id = $1 AND year = $2 ORDER BY source, month',
    [connectionId, year],
  )
  return rows.map((r) => ({
    source: r.source,
    month: r.month,
    ok: !!r.ok,
    status: r.status,
    data: r.payload_json,
    error: r.error ?? undefined,
    fetchedAt: r.fetched_at?.toISOString?.() ?? r.fetched_at,
  }))
}

export async function upsertBillingCache({ connectionId, source, year, month, ok, status, data, error }) {
  await pool.query(
    `INSERT INTO billing_cache (connection_id, source, year, month, ok, status, payload_json, error, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
     ON CONFLICT (connection_id, source, year, month) DO UPDATE SET
       ok = EXCLUDED.ok,
       status = EXCLUDED.status,
       payload_json = EXCLUDED.payload_json,
       error = EXCLUDED.error,
       fetched_at = EXCLUDED.fetched_at`,
    [
      connectionId,
      source,
      year,
      month,
      !!ok,
      status,
      JSON.stringify(data ?? null),
      error ?? null,
      new Date().toISOString(),
    ],
  )
}

// ---- reset / snapshot --------------------------------------------------------

export async function resetAll() {
  await tx(async (c) => {
    await c.query('DELETE FROM billing_cache')
    await c.query('DELETE FROM api_connections')
    await c.query('DELETE FROM expenses')
    await c.query('DELETE FROM operators')
    await c.query('DELETE FROM assignments')
    await c.query('DELETE FROM settings')
    await c.query('DELETE FROM custom_groups')
    await c.query('DELETE FROM territories')
  })
}

export async function replaceAllFromSnapshot(snapshot) {
  await tx(async (c) => {
    await c.query('DELETE FROM expenses')
    await c.query('DELETE FROM operators')
    await c.query('DELETE FROM assignments')
    await c.query('DELETE FROM settings')
    await c.query('DELETE FROM custom_groups')
    await c.query('DELETE FROM territories')
    // api_connections survive: secrets the client never sees.

    for (const g of snapshot.customGroups ?? []) {
      if (typeof g === 'string' && g.trim()) {
        await c.query(
          'INSERT INTO custom_groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          [g.trim()],
        )
      }
    }

    const terrs = snapshot.territories ?? []
    for (let i = 0; i < terrs.length; i++) {
      const t = terrs[i]
      await c.query(
        'INSERT INTO territories (id, name, currency, sort_order, short_code) VALUES ($1,$2,$3,$4,$5)',
        [t.id, t.name, t.currency, t.sortOrder ?? i + 1, t.shortCode ?? ''],
      )
    }

    for (const e of snapshot.expenses ?? []) {
      await c.query(
        'INSERT INTO expenses (id, section, name, currency, source, monthly_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
        [e.id, e.section, e.name, e.currency, e.source ?? 'excel', asJson(e.nativeMonthly ?? {})],
      )
    }

    const ops = snapshot.operators ?? []
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i]
      await c.query(
        'INSERT INTO operators (id, name, category, classification, currency, monthly_json, sort_order, territory_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
        [
          o.id,
          o.name,
          o.category,
          o.classification,
          o.currency ?? 'GBP',
          asJson(o.monthly ?? {}),
          i + 1,
          o.territoryId ?? null,
        ],
      )
    }

    for (const [id, a] of Object.entries(snapshot.assignments ?? {})) {
      await c.query(
        'INSERT INTO assignments (expense_id, classification, group_name, currency_override, territory_id) VALUES ($1,$2,$3,$4,$5)',
        [id, a.classification, a.group ?? '', a.currencyOverride ?? null, a.territoryId ?? null],
      )
    }

    if (snapshot.fxRates) await upsertSettingTx(c, 'fxRates', snapshot.fxRates)
    if (snapshot.excelFileName) await upsertSettingTx(c, 'excelFileName', snapshot.excelFileName)
    if (snapshot.lastImportedAt) await upsertSettingTx(c, 'lastImportedAt', snapshot.lastImportedAt)
  })
}
