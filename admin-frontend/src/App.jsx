import { useCallback, useEffect, useState } from "react";

const ADMIN_API_BASE_URL = "http://localhost:8000";

const responseError = async (response) => {
  const body = await response.json().catch(() => null);
  return typeof body?.detail === "string" ? body.detail : `Request failed (${response.status}).`;
};

function ServerOpenDialog({ onClose, onOpen }) {
  const [servers, setServers] = useState([]);
  const [selectedName, setSelectedName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${ADMIN_API_BASE_URL}/servers`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return response.json();
      })
      .then((body) => {
        const items = body.servers || [];
        setServers(items);
        setSelectedName(body.defaultServerName || items[0]?.name || "");
      })
      .catch((fetchError) => setError(fetchError.message))
      .finally(() => setLoading(false));
  }, []);

  const selectedServer = servers.find((server) => server.name === selectedName);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="server-open-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-titlebar">
          <h2 id="server-open-title">Open Server</h2>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}>×</button>
        </div>
        <div className="dialog-body">
          {loading && <div className="dialog-message">Loading servers…</div>}
          {error && <div className="error-message">{error}</div>}
          {!loading && !error && servers.length === 0 && <div className="dialog-message">No servers are configured.</div>}
          {servers.map((server) => (
            <label className={`server-option${selectedName === server.name ? " selected" : ""}`} key={server.name}>
              <input type="radio" name="server" value={server.name} checked={selectedName === server.name} onChange={() => setSelectedName(server.name)} />
              <span className="server-option-copy">
                <strong>{server.name}</strong>
                <span>{server.host}:{server.port}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="button" disabled={!selectedServer} onClick={() => onOpen(selectedServer)}>Open</button>
        </div>
      </section>
    </div>
  );
}

const intervalUnits = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
const inputVariableKey = (item) => String(item?.name || "").trim().replace(/^\$+/, "");
const displayValue = (value) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
const toLocalDateTime = (value) => {
  const date = value ? new Date(value) : new Date(Date.now() + 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};
const splitInterval = (seconds) => {
  for (const unit of ["days", "hours", "minutes"]) if (seconds % intervalUnits[unit] === 0) return { interval: seconds / intervalUnits[unit], intervalUnit: unit };
  return { interval: seconds, intervalUnit: "seconds" };
};

function SetTimerView({ server }) {
  const [rows, setRows] = useState([]);
  const [concerts, setConcerts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [inputVariables, setInputVariables] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const selectedRow = rows.find((row) => row.id === selectedId);

  const load = useCallback(async () => {
    setLoading(true); setError(""); setMessage("");
    try {
      const [timerResponse, concertResponse] = await Promise.all([fetch(`${server.apiBaseUrl}/timers`), fetch(`${server.apiBaseUrl}/concerts`)]);
      if (!timerResponse.ok) throw new Error(await responseError(timerResponse));
      if (!concertResponse.ok) throw new Error(await responseError(concertResponse));
      const timerBody = await timerResponse.json();
      const concertBody = await concertResponse.json();
      setConcerts(concertBody.concerts || []);
      const nextRows = (timerBody.timers || []).map((timer) => ({ ...timer, ...splitInterval(timer.intervalSeconds), firstRunLocal: toLocalDateTime(timer.firstRunAt), isNew: false }));
      setRows(nextRows);
      setSelectedId((current) => nextRows.some((row) => row.id === current) ? current : nextRows[0]?.id || null);
    } catch (loadError) { setError(loadError.message); } finally { setLoading(false); }
  }, [server.apiBaseUrl]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!selectedRow?.concertName) { setInputVariables([]); return; }
    const path = selectedRow.concertName.split("/").map(encodeURIComponent).join("/");
    fetch(`${server.apiBaseUrl}/concerts/${path}`).then((response) => response.ok ? response.json() : Promise.reject(new Error("Unable to load Concert inputs."))).then((body) => {
      const variables = body.inputVariables || [];
      setInputVariables(variables);
      setRows((current) => current.map((row) => row.id !== selectedRow.id ? row : { ...row, params: Object.fromEntries(variables.map((item) => { const key = inputVariableKey(item); return [key, displayValue(row.params?.[key] ?? item.defaultValue ?? "")]; })) }));
    }).catch((loadError) => setError(loadError.message));
  }, [selectedId, selectedRow?.concertName, server.apiBaseUrl]);

  const updateRow = (id, changes) => setRows((current) => current.map((row) => row.id === id ? { ...row, ...changes } : row));
  const addRow = () => {
    const id = crypto.randomUUID();
    const concertName = concerts[0]?.name || "";
    setRows((current) => [...current, { id, name: "", concertName, interval: 1, intervalUnit: "minutes", firstRunLocal: toLocalDateTime(), enabled: true, params: {}, isNew: true, running: false }]);
    setSelectedId(id); setEditing({ id, field: "name" }); setMessage("");
  };
  const save = async () => {
    setError(""); setMessage("");
    const timers = rows.map((row) => ({ id: row.isNew ? null : row.id, name: row.name.trim(), concertName: row.concertName, intervalSeconds: Number(row.interval) * intervalUnits[row.intervalUnit], firstRunAt: new Date(row.firstRunLocal).toISOString(), enabled: row.enabled, params: row.params || {} }));
    if (timers.some((timer) => !timer.name || !timer.concertName || timer.intervalSeconds < 1 || Number.isNaN(new Date(timer.firstRunAt).getTime()))) { setError("Complete every timer name, Concert, interval, and first run time before saving."); return; }
    const response = await fetch(`${server.apiBaseUrl}/timers`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timers }) });
    if (!response.ok) { setError(await responseError(response)); return; }
    await load(); setMessage("Timer settings saved.");
  };
  const isEditing = (row, field) => row.isNew || (editing?.id === row.id && editing.field === field);
  const editCell = (row, field) => { setSelectedId(row.id); setEditing({ id: row.id, field }); };

  return (
    <section className="admin-content timer-admin-content">
      <div className="content-heading"><div><h1>Set Timer</h1><p>Double-click a cell to edit it, then save all changes together.</p></div></div>
      <div className="grid-toolbar"><button type="button" onClick={addRow}>Add</button><button className="primary-button" type="button" onClick={save}>Save</button><button type="button" onClick={load}>Refresh</button></div>
      {error && <div className="error-message content-error">{error}</div>}{message && <div className="success-message">{message}</div>}
      <div className="timer-grid-wrap"><table className="timer-grid"><thead><tr><th>Timer Name</th><th>Concert File</th><th>Interval</th><th>Unit</th><th>First Run</th><th>Enable</th><th>Running</th><th>Last Run Time</th><th>Last Duration</th><th></th></tr></thead><tbody>
        {loading && <tr><td colSpan="10" className="empty-list">Loading timers…</td></tr>}
        {!loading && rows.length === 0 && <tr><td colSpan="10" className="empty-list">No timers are configured.</td></tr>}
        {rows.map((row) => <tr className={row.id === selectedId ? "selected" : ""} key={row.id} onClick={() => setSelectedId(row.id)}>
          <td onDoubleClick={() => editCell(row, "name")}>{isEditing(row, "name") ? <input autoFocus={editing?.field === "name"} value={row.name} onChange={(event) => updateRow(row.id, { name: event.target.value })} onBlur={() => !row.isNew && setEditing(null)} /> : row.name}</td>
          <td onDoubleClick={() => editCell(row, "concertName")}>{isEditing(row, "concertName") ? <select value={row.concertName} onChange={(event) => updateRow(row.id, { concertName: event.target.value, params: {} })} onBlur={() => !row.isNew && setEditing(null)}>{concerts.map((concert) => <option value={concert.name} key={concert.concertId}>{concert.name}</option>)}</select> : row.concertName}</td>
          <td onDoubleClick={() => editCell(row, "interval")}>{isEditing(row, "interval") ? <input type="number" min="1" value={row.interval} onChange={(event) => updateRow(row.id, { interval: event.target.value })} onBlur={() => !row.isNew && setEditing(null)} /> : row.interval}</td>
          <td onDoubleClick={() => editCell(row, "intervalUnit")}>{isEditing(row, "intervalUnit") ? <select value={row.intervalUnit} onChange={(event) => updateRow(row.id, { intervalUnit: event.target.value })} onBlur={() => !row.isNew && setEditing(null)}><option value="seconds">Seconds</option><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select> : row.intervalUnit}</td>
          <td onDoubleClick={() => editCell(row, "firstRunLocal")}>{isEditing(row, "firstRunLocal") ? <input type="datetime-local" step="1" value={row.firstRunLocal} onChange={(event) => updateRow(row.id, { firstRunLocal: event.target.value })} onBlur={() => !row.isNew && setEditing(null)} /> : new Date(row.firstRunLocal).toLocaleString()}</td>
          <td className="center-cell"><input type="checkbox" checked={row.enabled} onChange={(event) => updateRow(row.id, { enabled: event.target.checked })} /></td>
          <td><span className={`status-badge${row.running ? " running" : ""}`}>{row.running ? "Running" : "Idle"}</span></td>
          <td>{row.lastRunAt ? new Date(row.lastRunAt).toLocaleString() : "—"}</td><td>{row.lastDurationMs == null ? "—" : `${(row.lastDurationMs / 1000).toFixed(3)}s`}</td>
          <td><button className="danger-text-button" type="button" onClick={() => { setRows((current) => current.filter((item) => item.id !== row.id)); if (selectedId === row.id) setSelectedId(null); }}>Delete</button></td>
        </tr>)}</tbody></table></div>
      <section className="input-values-panel"><div className="input-values-title"><strong>Concert Input Values</strong><span>{selectedRow?.concertName || "Select a timer row"}</span></div>
        {!selectedRow && <div className="empty-list">Select a timer row to edit its Concert input values.</div>}
        {selectedRow && inputVariables.length === 0 && <div className="empty-list">This Concert has no input values.</div>}
        {selectedRow && inputVariables.length > 0 && <div className="input-values-grid">{inputVariables.map((item) => { const key = inputVariableKey(item); return <label key={key}><span>${key}</span><input value={selectedRow.params?.[key] ?? ""} placeholder={displayValue(item.defaultValue)} onChange={(event) => updateRow(selectedRow.id, { params: { ...(selectedRow.params || {}), [key]: event.target.value } })} /></label>; })}</div>}
      </section>
    </section>
  );
}

function DsnEditorDialog({ value, onChange, onClose }) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog dsn-dialog" role="dialog" aria-modal="true" aria-labelledby="dsn-editor-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-titlebar"><h2 id="dsn-editor-title">Edit DSN</h2><button className="icon-button" type="button" aria-label="Close DSN editor" onClick={onClose}>×</button></div>
        <div className="dialog-body"><textarea className="dsn-editor" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck="false" autoFocus /></div>
        <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="button" onClick={() => { onChange(draft); onClose(); }}>Apply</button></div>
      </section>
    </div>
  );
}

function DbConnectionsView({ server }) {
  const [rows, setRows] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [editing, setEditing] = useState(null);
  const [dsnRowKey, setDsnRowKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const selectedRow = rows.find((row) => row.key === selectedKey) || null;

  const load = useCallback(async () => {
    setLoading(true); setError(""); setMessage("");
    try {
      const response = await fetch(`${server.apiBaseUrl}/admin/connections`);
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      const nextRows = (body.connections || []).map((item) => ({ ...item, key: crypto.randomUUID(), originalName: item.name, password: "", isNew: false }));
      setRows(nextRows);
      setSelectedKey((current) => nextRows.some((row) => row.key === current) ? current : nextRows[0]?.key || null);
    } catch (loadError) { setError(loadError.message); } finally { setLoading(false); }
  }, [server.apiBaseUrl]);

  useEffect(() => { load(); }, [load]);
  const updateRow = (key, changes) => setRows((current) => current.map((row) => row.key === key ? { ...row, ...changes } : row));
  const add = () => {
    const key = crypto.randomUUID();
    setRows((current) => [...current, { key, originalName: "", name: "", user: "", password: "", dsn: "", enable: true, pm: false, passwordSet: false, isNew: true }]);
    setSelectedKey(key); setEditing({ key, field: "name" }); setMessage("");
  };
  const save = async () => {
    setError(""); setMessage("");
    const connections = rows.map(({ originalName, name, user, password, dsn, enable, pm }) => ({ originalName, name: name.trim(), user: user.trim(), password, dsn: dsn.trim(), enable, pm }));
    if (connections.some((item) => !item.name || !item.user || !item.dsn || (!item.originalName && !item.password))) { setError("Complete name, user, password, and DSN for every connection."); return; }
    const response = await fetch(`${server.apiBaseUrl}/admin/connections`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connections }) });
    if (!response.ok) { setError(await responseError(response)); return; }
    await load(); setMessage("Connection settings saved.");
  };
  const test = async () => {
    if (!selectedRow) { setError("Select a connection row to test."); return; }
    setTesting(true); setError(""); setMessage("");
    try {
      const response = await fetch(`${server.apiBaseUrl}/admin/connections/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ originalName: selectedRow.originalName, name: selectedRow.name, user: selectedRow.user, password: selectedRow.password, dsn: selectedRow.dsn, enable: selectedRow.enable, pm: selectedRow.pm }) });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json(); setMessage(body.message || "Connection succeeded.");
    } catch (testError) { setError(testError.message); } finally { setTesting(false); }
  };
  const isEditing = (row, field) => row.isNew || (editing?.key === row.key && editing.field === field);
  const editCell = (row, field) => { setSelectedKey(row.key); setEditing({ key: row.key, field }); };
  const blockPasswordTransfer = (event) => event.preventDefault();
  const dsnRow = rows.find((row) => row.key === dsnRowKey);

  return (
    <section className="admin-content timer-admin-content">
      <div className="content-heading"><div><h1>DB Connections</h1><p>Double-click a cell to edit it, then save all changes together.</p></div></div>
      <div className="grid-toolbar"><button type="button" onClick={add}>Add</button><button className="primary-button" type="button" onClick={save}>Save</button><button type="button" onClick={load}>Refresh</button><button type="button" disabled={!selectedRow || testing} onClick={test}>{testing ? "Testing…" : "Connection Test"}</button></div>
      {error && <div className="error-message content-error">{error}</div>}{message && <div className="success-message">{message}</div>}
      <div className="timer-grid-wrap"><table className="connection-grid"><thead><tr><th>Name</th><th>User</th><th>Password</th><th>DSN</th><th>Enable</th><th>PM</th><th></th></tr></thead><tbody>
        {loading && <tr><td colSpan="7" className="empty-list">Loading connections…</td></tr>}
        {!loading && rows.length === 0 && <tr><td colSpan="7" className="empty-list">No connections are configured.</td></tr>}
        {rows.map((row) => <tr className={row.key === selectedKey ? "selected" : ""} key={row.key} onClick={() => setSelectedKey(row.key)}>
          <td onDoubleClick={() => editCell(row, "name")}>{isEditing(row, "name") ? <input autoFocus={editing?.field === "name"} value={row.name} onChange={(event) => updateRow(row.key, { name: event.target.value })} onBlur={() => !row.isNew && setEditing(null)} /> : row.name}</td>
          <td onDoubleClick={() => editCell(row, "user")}>{isEditing(row, "user") ? <input value={row.user} onChange={(event) => updateRow(row.key, { user: event.target.value })} onBlur={() => !row.isNew && setEditing(null)} /> : row.user}</td>
          <td className="password-cell" onCopy={blockPasswordTransfer} onCut={blockPasswordTransfer} onContextMenu={blockPasswordTransfer} onDoubleClick={() => editCell(row, "password")}>{isEditing(row, "password") ? <span className="password-editor-wrap"><input type="password" autoComplete="new-password" draggable="false" value={row.password} placeholder={row.password || row.passwordSet ? "" : "Password"} onChange={(event) => updateRow(row.key, { password: event.target.value })} onCopy={blockPasswordTransfer} onCut={blockPasswordTransfer} onContextMenu={blockPasswordTransfer} onDragStart={blockPasswordTransfer} onBlur={() => !row.isNew && setEditing(null)} /><span>{row.password || row.passwordSet ? "••••••••" : ""}</span></span> : (row.password || row.passwordSet ? "••••••••" : "")}</td>
          <td className="dsn-cell"><span title={row.dsn}>{row.dsn}</span><button type="button" onClick={(event) => { event.stopPropagation(); setSelectedKey(row.key); setDsnRowKey(row.key); }}>Edit</button></td>
          <td className="center-cell"><input type="checkbox" checked={row.enable} onChange={(event) => updateRow(row.key, { enable: event.target.checked })} /></td>
          <td className="center-cell"><input type="checkbox" checked={row.pm} onChange={(event) => updateRow(row.key, { pm: event.target.checked })} /></td>
          <td><button className="danger-text-button" type="button" onClick={() => { setRows((current) => current.filter((item) => item.key !== row.key)); if (selectedKey === row.key) setSelectedKey(null); }}>Delete</button></td>
        </tr>)}</tbody></table></div>
      {dsnRow && <DsnEditorDialog value={dsnRow.dsn} onChange={(dsn) => updateRow(dsnRow.key, { dsn })} onClose={() => setDsnRowKey(null)} />}
    </section>
  );
}

export default function App() {
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [activeMenu, setActiveMenu] = useState(null);
  const [showServerDialog, setShowServerDialog] = useState(false);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;

  const openServer = (server) => {
    const existing = tabs.find((tab) => tab.name === server.name && tab.host === server.host && tab.port === server.port);
    if (existing) setActiveTabId(existing.id);
    else {
      const tab = { ...server, id: crypto.randomUUID(), apiBaseUrl: `http://${server.host}:${server.port}`, activeView: "timer" };
      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
    }
    setShowServerDialog(false);
  };

  const closeTab = (tabId) => setTabs((current) => {
    const index = current.findIndex((tab) => tab.id === tabId);
    const nextTabs = current.filter((tab) => tab.id !== tabId);
    if (activeTabId === tabId) setActiveTabId(nextTabs[Math.min(index, nextTabs.length - 1)]?.id || null);
    return nextTabs;
  });
  const setTabView = (tabId, activeView) => setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, activeView } : tab));

  return (
    <div className="app-shell" onClick={() => setActiveMenu(null)}>
      <header className="toolbar">
        <div className="brand">Metronome admin</div>
        <nav className="menu-bar" onClick={(event) => event.stopPropagation()}>
          <div className="menu-root">
            <button className="menu-button" type="button" onClick={() => setActiveMenu(activeMenu === "server" ? null : "server")}>Server</button>
            {activeMenu === "server" && <div className="menu-popover"><button type="button" onClick={() => { setActiveMenu(null); setShowServerDialog(true); }}>Open</button><button type="button" disabled={!activeTab} onClick={() => activeTab && closeTab(activeTab.id)}>Close</button></div>}
          </div>
        </nav>
      </header>
      <main className="main-workspace">
        <section className={`admin-tab-shell${tabs.length === 0 ? " empty" : ""}`}>
          {tabs.length > 0 && <div className="tab-strip">{tabs.map((tab) => <button className={`tab-button${tab.id === activeTabId ? " active" : ""}`} type="button" key={tab.id} onClick={() => setActiveTabId(tab.id)}><span className="tab-title">{tab.name}</span><span className="tab-server-badge">{tab.host}:{tab.port}</span><span className="tab-close" role="button" aria-label={`Close ${tab.name}`} tabIndex={0} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}>×</span></button>)}</div>}
          {activeTab && <div className="server-workspace"><aside className="side-navigation"><div className="side-navigation-title">Administration</div><button className={`side-navigation-item${activeTab.activeView === "timer" ? " active" : ""}`} type="button" onClick={() => setTabView(activeTab.id, "timer")}>Set Timer</button><button className={`side-navigation-item${activeTab.activeView === "connections" ? " active" : ""}`} type="button" onClick={() => setTabView(activeTab.id, "connections")}>DB Connections</button></aside>{activeTab.activeView === "connections" ? <DbConnectionsView server={activeTab} /> : <SetTimerView server={activeTab} />}</div>}
        </section>
      </main>
      {showServerDialog && <ServerOpenDialog onClose={() => setShowServerDialog(false)} onOpen={openServer} />}
    </div>
  );
}
