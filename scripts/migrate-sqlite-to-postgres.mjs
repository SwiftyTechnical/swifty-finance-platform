#!/usr/bin/env node
// Migrate a Swifty P&L SQLite database into a Postgres database.
//
// Usage:
//   node scripts/migrate-sqlite-to-postgres.mjs <sqlite-path> <postgres-url>
//
// Idempotent: drops and re-creates every Swifty table on the target before
// loading. Safe to re-run. Does NOT touch other tables in the target database.

import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'

const [, , sqlitePath, pgUrl] = process.argv

if (!sqlitePath || !pgUrl) {
  console.error('usage: node scripts/migrate-sqlite-to-postgres.mjs <sqlite-path> <postgres-url>')
  process.exit(1)
}

const SCHEMA_SQL = `
DROP TABLE IF EXISTS billing_cache CASCADE;
DROP TABLE IF EXISTS api_connections CASCADE;
DROP TABLE IF EXISTS assignments CASCADE;
DROP TABLE IF EXISTS expenses CASCADE;
DROP TABLE IF EXISTS operators CASCADE;
DROP TABLE IF EXISTS territories CASCADE;
DROP TABLE IF EXISTS custom_groups CASCADE;
DROP TABLE IF EXISTS settings CASCADE;

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  section TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'excel',
  monthly_json JSONB NOT NULL
);

CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  classification TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  territory_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  monthly_json JSONB NOT NULL
);

CREATE TABLE assignments (
  expense_id TEXT PRIMARY KEY,
  classification TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  currency_override TEXT,
  territory_id TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE custom_groups (
  name TEXT PRIMARY KEY
);

CREATE TABLE territories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  short_code TEXT NOT NULL DEFAULT ''
);

CREATE TABLE api_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  client_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE billing_cache (
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

function jsonOrNull(text, fallback = null) {
  if (text === null || text === undefined) return fallback
  try { return JSON.parse(text) } catch { return fallback }
}

function settingsValueAsJson(text) {
  // settings.value in SQLite was stored as JSON.stringify(...) per upsertSetting.
  // Parse it; if parsing fails, fall back to the raw string wrapped in a JSON value.
  try { return JSON.parse(text) } catch { return text }
}

async function copyTable(sqlite, pgClient, label, fn) {
  console.log(`-- ${label}`)
  await fn(sqlite, pgClient)
}

async function main() {
  const sqlite = new DatabaseSync(sqlitePath, { open: true })
  // Strip sslmode from the URL: pg v9 reads it from the connection string and
  // upgrades require/verify-ca to verify-full, which fails on RDS' default
  // cert chain. We pass ssl explicitly below.
  const cleanUrl = pgUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '')
  const pgClient = new pg.Client({
    connectionString: cleanUrl,
    ssl: { rejectUnauthorized: false },
  })
  await pgClient.connect()

  try {
    console.log(`-- target: ${pgUrl.replace(/:[^:@/]+@/, ':***@')}`)
    console.log(`-- source: ${sqlitePath}`)

    console.log('-- applying schema')
    await pgClient.query(SCHEMA_SQL)

    await pgClient.query('BEGIN')

    await copyTable(sqlite, pgClient, 'territories', async () => {
      const rows = sqlite.prepare('SELECT id, name, currency, sort_order, short_code FROM territories').all()
      for (const r of rows) {
        await pgClient.query(
          'INSERT INTO territories (id, name, currency, sort_order, short_code) VALUES ($1,$2,$3,$4,$5)',
          [r.id, r.name, r.currency, r.sort_order ?? 0, r.short_code ?? ''],
        )
      }
      console.log(`   ${rows.length} rows`)
    })

    await copyTable(sqlite, pgClient, 'custom_groups', async () => {
      const rows = sqlite.prepare('SELECT name FROM custom_groups').all()
      for (const r of rows) {
        await pgClient.query('INSERT INTO custom_groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [r.name])
      }
      console.log(`   ${rows.length} rows`)
    })

    await copyTable(sqlite, pgClient, 'expenses', async () => {
      const rows = sqlite.prepare('SELECT id, section, name, currency, source, monthly_json FROM expenses').all()
      for (const r of rows) {
        await pgClient.query(
          'INSERT INTO expenses (id, section, name, currency, source, monthly_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
          [r.id, r.section, r.name, r.currency, r.source ?? 'excel', JSON.stringify(jsonOrNull(r.monthly_json, {}))],
        )
      }
      console.log(`   ${rows.length} rows`)
    })

    await copyTable(sqlite, pgClient, 'operators', async () => {
      const rows = sqlite
        .prepare('SELECT id, name, category, classification, currency, territory_id, sort_order, monthly_json FROM operators ORDER BY sort_order, rowid')
        .all()
      for (const r of rows) {
        await pgClient.query(
          'INSERT INTO operators (id, name, category, classification, currency, territory_id, sort_order, monthly_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
          [
            r.id,
            r.name,
            r.category,
            r.classification,
            r.currency ?? 'GBP',
            r.territory_id ?? null,
            r.sort_order ?? 0,
            JSON.stringify(jsonOrNull(r.monthly_json, {})),
          ],
        )
      }
      console.log(`   ${rows.length} rows`)
    })

    await copyTable(sqlite, pgClient, 'assignments', async () => {
      const rows = sqlite
        .prepare('SELECT expense_id, classification, group_name, currency_override, territory_id FROM assignments')
        .all()
      for (const r of rows) {
        await pgClient.query(
          'INSERT INTO assignments (expense_id, classification, group_name, currency_override, territory_id) VALUES ($1,$2,$3,$4,$5)',
          [r.expense_id, r.classification, r.group_name ?? '', r.currency_override ?? null, r.territory_id ?? null],
        )
      }
      console.log(`   ${rows.length} rows`)
    })

    await copyTable(sqlite, pgClient, 'settings', async () => {
      const rows = sqlite.prepare('SELECT key, value FROM settings').all()
      for (const r of rows) {
        const parsed = settingsValueAsJson(r.value)
        await pgClient.query(
          'INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)',
          [r.key, JSON.stringify(parsed)],
        )
      }
      console.log(`   ${rows.length} rows`)
    })

    await copyTable(sqlite, pgClient, 'api_connections', async () => {
      const rows = sqlite
        .prepare('SELECT id, name, base_url, api_key, client_id, created_at FROM api_connections ORDER BY created_at, id')
        .all()
      for (const r of rows) {
        await pgClient.query(
          'INSERT INTO api_connections (id, name, base_url, api_key, client_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
          [r.id, r.name, r.base_url, r.api_key, r.client_id ?? null, r.created_at],
        )
      }
      console.log(`   ${rows.length} rows`)
    })

    await copyTable(sqlite, pgClient, 'billing_cache', async () => {
      const rows = sqlite
        .prepare('SELECT connection_id, source, year, month, ok, status, payload_json, error, fetched_at FROM billing_cache')
        .all()
      for (const r of rows) {
        await pgClient.query(
          'INSERT INTO billing_cache (connection_id, source, year, month, ok, status, payload_json, error, fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
          [
            r.connection_id,
            r.source,
            r.year,
            r.month,
            !!r.ok,
            r.status,
            JSON.stringify(jsonOrNull(r.payload_json, null)),
            r.error ?? null,
            r.fetched_at,
          ],
        )
      }
      console.log(`   ${rows.length} rows`)
    })

    await pgClient.query('COMMIT')
    console.log('-- done')
  } catch (e) {
    console.error('migration failed:', e)
    try { await pgClient.query('ROLLBACK') } catch {}
    process.exit(2)
  } finally {
    await pgClient.end()
    sqlite.close()
  }
}

main()
