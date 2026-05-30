#!/usr/bin/env node
// One-shot bootstrap for the Swifty Postgres setup on the shared
// compliance-portal-db RDS instance.
//
//   - Creates the app role `financial_data_app` (or rotates its password).
//   - Creates `financial_data_prod` and `financial_data_dev` if missing.
//   - Makes the app role the owner of both DBs.
//   - Prints the new credentials and the two DATABASE_URLs to stdout so the
//     caller can write them into .env.
//
// Usage:
//   node scripts/setup-postgres.mjs <master-url-or-host> <master-user> <master-password>
//
// `master-url-or-host` accepts either a full hostname (e.g.
// compliance-portal-db.coprcrkbgxsn.eu-west-1.rds.amazonaws.com) or a
// postgres:// URL whose host/user/db are used as the bootstrap connection.

import pg from 'pg'
import { randomBytes } from 'node:crypto'

const [, , hostArg, masterUser, masterPassword] = process.argv
if (!hostArg || !masterUser || !masterPassword) {
  console.error('usage: node scripts/setup-postgres.mjs <host-or-url> <master-user> <master-password>')
  process.exit(1)
}

const host = hostArg.startsWith('postgres')
  ? new URL(hostArg).hostname
  : hostArg

const APP_ROLE = 'financial_data_app'
const DBS = ['financial_data_prod', 'financial_data_dev']

function generatePassword(len = 32) {
  // URL-safe base64 → no +, /, =, : (which would mangle a postgres:// URL).
  return randomBytes(len)
    .toString('base64')
    .replace(/[+/=]/g, '')
    .slice(0, len)
}

function urlFor(user, pass, dbName) {
  return `postgresql://${user}:${encodeURIComponent(pass)}@${host}:5432/${dbName}?sslmode=require`
}

async function main() {
  // 1. Connect as master to the default 'compliance' DB (you can't CREATE
  //    DATABASE while connected to that target DB).
  const master = new pg.Client({
    host,
    port: 5432,
    user: masterUser,
    password: masterPassword,
    database: 'compliance',
    ssl: { rejectUnauthorized: false },
  })
  await master.connect()
  console.log(`-- connected as ${masterUser}@${host}`)

  // 2. App role.
  const roleExists = await master.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE])
  const appPassword = generatePassword()
  if (roleExists.rowCount > 0) {
    console.log(`-- role ${APP_ROLE} exists, rotating password`)
    await master.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'`)
  } else {
    console.log(`-- creating role ${APP_ROLE}`)
    await master.query(`CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'`)
  }

  // 3. Databases — CREATE DATABASE cannot be parameterised or run in a tx.
  for (const dbName of DBS) {
    const exists = await master.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
    if (exists.rowCount > 0) {
      console.log(`-- database ${dbName} already exists`)
    } else {
      console.log(`-- creating database ${dbName}`)
      await master.query(`CREATE DATABASE ${dbName} WITH OWNER = ${APP_ROLE} ENCODING = 'UTF8'`)
    }
    // Make sure ownership is correct even on idempotent re-run.
    await master.query(`ALTER DATABASE ${dbName} OWNER TO ${APP_ROLE}`)
    await master.query(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${APP_ROLE}`)
  }

  await master.end()

  // 4. Print credentials in a parser-friendly block.
  console.log('')
  console.log('=== APP CREDENTIALS ===')
  console.log(`USER=${APP_ROLE}`)
  console.log(`PASSWORD=${appPassword}`)
  console.log(`HOST=${host}`)
  for (const dbName of DBS) {
    const tag = dbName.endsWith('_prod') ? 'PROD' : 'DEV'
    console.log(`DATABASE_URL_${tag}=${urlFor(APP_ROLE, appPassword, dbName)}`)
  }
  console.log('=== END ===')
}

main().catch((e) => {
  console.error('setup failed:', e)
  process.exit(2)
})
