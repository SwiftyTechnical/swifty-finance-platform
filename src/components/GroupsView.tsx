import { useMemo, useState } from 'react'
import { AppState } from '../types'
import { defaultGroupFor, summariseGroups } from '../utils'

interface Props {
  state: AppState
  addCustomGroup: (name: string) => void
  renameCustomGroup: (oldName: string, newName: string) => void
  deleteCustomGroup: (name: string) => void
  deleteExpense: (id: string) => void
}

export function GroupsView({ state, addCustomGroup, renameCustomGroup, deleteCustomGroup, deleteExpense }: Props) {
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null)

  const groups = useMemo(() => summariseGroups(state), [state])

  const totals = useMemo(() => {
    let b2b = 0, b2c = 0, unassigned = 0
    for (const g of groups) { b2b += g.b2b; b2c += g.b2c; unassigned += g.unassigned }
    return { b2b, b2c, unassigned, total: b2b + b2c + unassigned }
  }, [groups])

  function commitAdd() {
    const t = newName.trim()
    if (!t) return
    addCustomGroup(t)
    setNewName('')
  }

  function commitRename() {
    if (!editing) return
    const t = editing.value.trim()
    if (!t || t === editing.name) { setEditing(null); return }
    renameCustomGroup(editing.name, t)
    setEditing(null)
  }

  return (
    <div>
      <div className="stats-row">
        <div className="stat">
          <div className="stat-label">Groups</div>
          <div className="stat-value">{groups.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Assigned Lines</div>
          <div className="stat-value">{totals.b2b + totals.b2c}</div>
        </div>
        <div className="stat">
          <div className="stat-label">B2B Lines</div>
          <div className="stat-value">{totals.b2b}</div>
        </div>
        <div className="stat">
          <div className="stat-label">B2C Lines</div>
          <div className="stat-value">{totals.b2c}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Unassigned</div>
          <div className="stat-value">{totals.unassigned}</div>
        </div>
      </div>

      <div className="card">
        <h2>Add a new group</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input-cell"
            placeholder="e.g. Infrastructure, Marketing, Compliance…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitAdd() }}
            style={{ maxWidth: 320 }}
          />
          <button className="btn" onClick={commitAdd} disabled={!newName.trim()}>Add group</button>
        </div>
        <p className="subtle" style={{ marginTop: 8 }}>
          New groups show up immediately in the Expenses tab's group dropdown so you can assign lines to them.
        </p>
      </div>

      <div className="card">
        <h2>All groups</h2>
        {groups.length === 0 ? (
          <p className="subtle">No groups yet. Add one above or assign expenses a group name in the Expenses tab.</p>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Group</th>
                  <th className="num">Expenses</th>
                  <th className="num">B2B</th>
                  <th className="num">B2C</th>
                  <th className="num">Unassigned</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const isEditing = editing?.name === g.name
                  return (
                    <tr key={g.name}>
                      <td>
                        {isEditing ? (
                          <input
                            className="input-cell"
                            autoFocus
                            value={editing!.value}
                            onChange={(e) => setEditing({ name: g.name, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename()
                              else if (e.key === 'Escape') setEditing(null)
                            }}
                            onBlur={commitRename}
                          />
                        ) : (
                          <strong>{g.name}</strong>
                        )}
                      </td>
                      <td className="num"><strong>{g.total}</strong></td>
                      <td className="num">{g.b2b}</td>
                      <td className="num">{g.b2c}</td>
                      <td className="num">{g.unassigned}</td>
                      <td className="row-actions">
                        <button onClick={() => setEditing({ name: g.name, value: g.name })}>Rename</button>
                        {g.custom ? (
                          <button
                            className="danger"
                            onClick={() => {
                              if (g.total > 0) {
                                if (!confirm(`"${g.name}" has ${g.total} expense line${g.total === 1 ? '' : 's'} assigned. Removing the custom entry won't untag them — they'll just stop showing in the dropdown. Continue?`)) return
                              }
                              deleteCustomGroup(g.name)
                            }}
                          >Delete</button>
                        ) : (
                          <button
                            className="danger"
                            onClick={() => {
                              const ids = state.expenses
                                .filter((e) => (state.assignments[e.id]?.group?.trim() || defaultGroupFor(e)) === g.name)
                                .map((e) => e.id)
                              if (ids.length === 0) return
                              if (!confirm(`Delete "${g.name}" and its ${ids.length} expense line${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return
                              for (const id of ids) deleteExpense(id)
                            }}
                          >Delete</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
