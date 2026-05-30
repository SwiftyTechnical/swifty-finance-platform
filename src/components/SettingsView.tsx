import { useEffect, useState } from 'react'
import { AppState, CURRENCIES, Currency, FxRates, NonGbpCurrency, Territory, Year } from '../types'
import { knownYears } from '../utils'
import { testConnection } from '../api'

interface Props {
  state: AppState
  currentYear: Year
  setCurrentYear: (y: Year) => void
  setFxRate: (currency: NonGbpCurrency, rate: number) => void
  addTerritory: (t: { name: string; currency: Currency; shortCode?: string }) => void
  updateTerritory: (id: string, patch: Partial<Territory>) => void
  deleteTerritory: (id: string) => void
  addApiConnection: (input: { name: string; baseUrl: string; apiKey: string; clientId?: string }) => Promise<string>
  patchApiConnection: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; clientId?: string }) => Promise<void>
  removeApiConnection: (id: string) => Promise<void>
  refreshApiConnections: () => Promise<void>
}

const labels: Record<NonGbpCurrency, string> = {
  AED: 'AED → GBP',
  ZAR: 'ZAR → GBP',
  EUR: 'EUR → GBP',
  USD: 'USD → GBP',
}

export function SettingsView({
  state,
  currentYear,
  setCurrentYear,
  setFxRate,
  addTerritory,
  updateTerritory,
  deleteTerritory,
  addApiConnection,
  patchApiConnection,
  removeApiConnection,
  refreshApiConnections,
}: Props) {
  const currencies = Object.keys(state.fxRates) as NonGbpCurrency[]
  const [newName, setNewName] = useState('')
  const [newShortCode, setNewShortCode] = useState('')
  const [newCurrency, setNewCurrency] = useState<Currency>('GBP')

  function commitAdd() {
    if (!newName.trim()) return
    addTerritory({ name: newName.trim(), currency: newCurrency, shortCode: newShortCode.trim() || undefined })
    setNewName('')
    setNewShortCode('')
    setNewCurrency('GBP')
  }

  const years = (() => {
    const ys = knownYears(state.operators)
    if (!ys.includes(currentYear)) ys.push(currentYear)
    return ys.sort()
  })()
  const maxYear = years[years.length - 1]

  function addNextYear() {
    const next = String(Number(maxYear) + 1)
    setCurrentYear(next)
  }

  return (
    <div>
      <div className="card">
        <h2>Years</h2>
        <p className="subtle" style={{ marginTop: 0 }}>
          Each operator's monthly revenue is stored per year. Expenses come from the latest Excel import (single year).
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {years.map((y) => (
            <button
              key={y}
              className={`btn ${y === currentYear ? '' : 'secondary'}`}
              onClick={() => setCurrentYear(y)}
            >
              {y}
            </button>
          ))}
          <button
            className="btn secondary"
            onClick={addNextYear}
            title={`Start FY${Number(maxYear) + 1}`}
          >
            + Add {Number(maxYear) + 1}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Territories</h2>
        <p className="subtle" style={{ marginTop: 0 }}>
          Used on the P&amp;L *Territory split* view and to tag expenses / operators by region. Each territory has its own display currency; cross-currency amounts are converted using your FX rates.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <input
            className="input-cell"
            placeholder="Territory name (e.g. Swifty UAE)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitAdd() }}
            style={{ maxWidth: 240 }}
          />
          <input
            className="input-cell"
            placeholder="Short code (e.g. UAE)"
            value={newShortCode}
            onChange={(e) => setNewShortCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitAdd() }}
            style={{ maxWidth: 120 }}
          />
          <select value={newCurrency} onChange={(e) => setNewCurrency(e.target.value as Currency)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className="btn" onClick={commitAdd} disabled={!newName.trim()}>Add territory</button>
        </div>

        {state.territories.length === 0 ? (
          <p className="subtle">No territories yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Short code</th>
                  <th>Currency</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {state.territories.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <input
                        className="input-cell"
                        value={t.name}
                        onChange={(e) => updateTerritory(t.id, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="input-cell"
                        placeholder="e.g. ZA"
                        value={t.shortCode ?? ''}
                        onChange={(e) => updateTerritory(t.id, { shortCode: e.target.value })}
                        style={{ maxWidth: 120 }}
                      />
                    </td>
                    <td>
                      <select
                        className="select-cell"
                        value={t.currency}
                        onChange={(e) => updateTerritory(t.id, { currency: e.target.value as Currency })}
                      >
                        {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td className="row-actions">
                      <button
                        className="danger"
                        onClick={() => {
                          if (confirm(`Delete territory "${t.name}"? Any expenses/operators tagged to it will become unassigned.`)) {
                            deleteTerritory(t.id)
                          }
                        }}
                      >Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>FX rates</h2>
        <p className="subtle" style={{ marginTop: 0 }}>
          Non-GBP expense lines are multiplied by these rates. Tune until P&amp;L figures line up with your Excel.
        </p>
        <div className="fx-grid">
          {currencies.map((c) => (
            <div className="fx-item" key={c}>
              <label>{labels[c]}</label>
              <input
                type="number"
                step="0.0001"
                min="0"
                value={state.fxRates[c as keyof FxRates]}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  setFxRate(c, Number.isFinite(v) ? v : 0)
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <ApiConnectionsCard
        state={state}
        addApiConnection={addApiConnection}
        patchApiConnection={patchApiConnection}
        removeApiConnection={removeApiConnection}
        refreshApiConnections={refreshApiConnections}
      />
    </div>
  )
}

function ApiConnectionsCard({
  state,
  addApiConnection,
  patchApiConnection,
  removeApiConnection,
  refreshApiConnections,
}: {
  state: AppState
  addApiConnection: Props['addApiConnection']
  patchApiConnection: Props['patchApiConnection']
  removeApiConnection: Props['removeApiConnection']
  refreshApiConnections: Props['refreshApiConnections']
}) {
  const [newName, setNewName] = useState('')
  const [newBaseUrl, setNewBaseUrl] = useState('')
  const [newApiKey, setNewApiKey] = useState('')
  const [newClientId, setNewClientId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, string>>({})

  useEffect(() => { refreshApiConnections() }, [refreshApiConnections])

  async function commitAdd() {
    if (!newName.trim() || !newBaseUrl.trim() || !newApiKey.trim()) return
    setBusy(true)
    setError(null)
    try {
      await addApiConnection({
        name: newName.trim(),
        baseUrl: newBaseUrl.trim(),
        apiKey: newApiKey.trim(),
        clientId: newClientId.trim() || undefined,
      })
      setNewName('')
      setNewBaseUrl('')
      setNewApiKey('')
      setNewClientId('')
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runTest(id: string) {
    setTestResults((r) => ({ ...r, [id]: 'Testing…' }))
    try {
      const res = await testConnection(id)
      const detail =
        res.ok && res.data && typeof res.data === 'object' && 'message' in (res.data as any)
          ? (res.data as any).message
          : res.error ?? `HTTP ${res.status}`
      setTestResults((r) => ({
        ...r,
        [id]: `${res.ok ? '✓' : '✗'} ${detail}`,
      }))
    } catch (e: any) {
      setTestResults((r) => ({ ...r, [id]: `✗ ${e?.message ?? String(e)}` }))
    }
  }

  return (
    <div className="card">
      <h2>Billing API Connections</h2>
      <p className="subtle" style={{ marginTop: 0 }}>
        Each connection has a base URL + API key for the operator's billing API. Optionally set a
        <strong> Client ID</strong> to also pull payment-gateway data (Nixxe). The gateway API key is
        read from the <code>GATEWAY_API_KEY</code> server env var, not stored here.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input
          className="input-cell"
          placeholder="Name (e.g. Swifty Sports IE)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <input
          className="input-cell"
          placeholder="Base URL (https://backoffice-api.swiftysports.ie)"
          value={newBaseUrl}
          onChange={(e) => setNewBaseUrl(e.target.value)}
          style={{ maxWidth: 320 }}
        />
        <input
          className="input-cell"
          type="password"
          placeholder="API key (swf_live_…)"
          value={newApiKey}
          onChange={(e) => setNewApiKey(e.target.value)}
          style={{ maxWidth: 240 }}
        />
        <input
          className="input-cell"
          placeholder="Client ID (optional, gateway)"
          value={newClientId}
          onChange={(e) => setNewClientId(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <button
          className="btn"
          onClick={commitAdd}
          disabled={busy || !newName.trim() || !newBaseUrl.trim() || !newApiKey.trim()}
        >
          Add connection
        </button>
        {error && <span style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</span>}
      </div>

      {state.apiConnections.length === 0 ? (
        <p className="subtle">No API connections yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Base URL</th>
                <th>Client ID</th>
                <th>API key</th>
                <th>Replace key</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {state.apiConnections.map((c) => (
                <ConnectionRow
                  key={c.id}
                  conn={c}
                  testResult={testResults[c.id]}
                  onPatch={(patch) => patchApiConnection(c.id, patch)}
                  onRemove={() => {
                    if (confirm(`Delete connection "${c.name}"?`)) removeApiConnection(c.id)
                  }}
                  onTest={() => runTest(c.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ConnectionRow({
  conn,
  testResult,
  onPatch,
  onRemove,
  onTest,
}: {
  conn: AppState['apiConnections'][number]
  testResult?: string
  onPatch: (patch: { name?: string; baseUrl?: string; apiKey?: string; clientId?: string }) => Promise<void>
  onRemove: () => void
  onTest: () => void
}) {
  const [name, setName] = useState(conn.name)
  const [baseUrl, setBaseUrl] = useState(conn.baseUrl)
  const [clientId, setClientId] = useState(conn.clientId ?? '')
  const [newKey, setNewKey] = useState('')

  function commitField(patch: { name?: string; baseUrl?: string; clientId?: string }) {
    onPatch(patch)
  }

  function commitNewKey() {
    if (!newKey.trim()) return
    onPatch({ apiKey: newKey.trim() }).then(() => setNewKey(''))
  }

  return (
    <tr>
      <td>
        <input
          className="input-cell"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== conn.name && commitField({ name })}
          style={{ maxWidth: 200 }}
        />
      </td>
      <td>
        <input
          className="input-cell"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={() => baseUrl !== conn.baseUrl && commitField({ baseUrl })}
          style={{ maxWidth: 280 }}
        />
      </td>
      <td>
        <input
          className="input-cell"
          value={clientId}
          placeholder="optional (gateway)"
          onChange={(e) => setClientId(e.target.value)}
          onBlur={() => (clientId ?? '') !== (conn.clientId ?? '') && commitField({ clientId })}
          style={{ maxWidth: 200 }}
        />
      </td>
      <td>
        <code style={{ fontSize: 11 }}>{conn.apiKeyMasked || '—'}</code>
      </td>
      <td>
        <input
          className="input-cell"
          type="password"
          placeholder="paste new key to replace"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commitNewKey() }}
          onBlur={() => newKey && commitNewKey()}
          style={{ maxWidth: 220 }}
        />
      </td>
      <td className="row-actions" style={{ whiteSpace: 'nowrap' }}>
        <button onClick={onTest}>Test</button>
        <button className="danger" onClick={onRemove}>Delete</button>
        {testResult && (
          <span style={{ marginLeft: 8, fontSize: 11, color: testResult.startsWith('✓') ? '#0f766e' : 'var(--danger)' }}>
            {testResult}
          </span>
        )}
      </td>
    </tr>
  )
}
