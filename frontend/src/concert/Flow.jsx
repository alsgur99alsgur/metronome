import { useEffect, useRef, useState } from "react";

import "reactflow/dist/style.css";
import "./Flow.css";

import ConcertListPanel from "./ConcertListPanel";
import ConcertTabView from "./ConcertTabView";
import DeployDialog from "./DeployDialog";
import ConcertManagerDialog from "./ConcertManagerDialog";
import StageResourcesDialog from "./StageResourcesDialog";

export default function Flow() {
  const tabViewRef = useRef(null);
  const resizeRef = useRef(null);
  const [activeMenu, setActiveMenu] = useState(null);
  const [showStageResources, setShowStageResources] = useState(false);
  const [deployTarget, setDeployTarget] = useState(null);
  const [deploySourceName, setDeploySourceName] = useState("");
  const [showConcertManager, setShowConcertManager] = useState(false);
  const [showConcertList, setShowConcertList] = useState(true);
  const [concertListWidth, setConcertListWidth] = useState(430);
  const [servers, setServers] = useState([]);
  const [selectedServerName, setSelectedServerName] = useState("Local");
  const selectedServer =
    servers.find((server) => server.name === selectedServerName) || {
      name: "Local",
      host: "localhost",
      port: 8000,
    };
  const selectedApiBaseUrl = `http://${selectedServer.host}:${selectedServer.port}`;

  const changeServer = async (nextServerName) => {
    if (nextServerName === selectedServerName) return true;
    const nextServer = servers.find((server) => server.name === nextServerName);
    if (!nextServer) {
      window.alert(`Server not found: ${nextServerName}.`);
      return false;
    }
    const nextApiBaseUrl = `http://${nextServer.host}:${nextServer.port}`;
    try {
      const response = await fetch(`${nextApiBaseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const body = response.ok ? await response.json() : null;
      if (!response.ok || body?.status !== "ok") throw new Error();
      setSelectedServerName(nextServerName);
      return true;
    } catch {
      window.alert(`No response from server: ${nextServerName}.`);
      return false;
    }
  };

  useEffect(() => {
    fetch("http://localhost:8000/servers")
      .then((response) => response.json())
      .then((body) => {
        setServers(body.servers || []);
        setSelectedServerName(body.defaultServerName || body.servers?.[0]?.name || "Local");
      });
  }, []);

  useEffect(() => {
    const move = (event) => {
      if (!resizeRef.current) return;
      const { startX, startWidth } = resizeRef.current;
      setConcertListWidth(Math.max(280, Math.min(window.innerWidth - 520, startWidth + event.clientX - startX)));
    };
    const stop = () => { resizeRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, []);

  return (
    <div
      className="app-shell"
      onClick={() => {
        setActiveMenu(null);
      }}
    >
      <header className="toolbar">
        <div className="brand">Metronome</div>

        <nav className="menu-bar" onClick={(event) => event.stopPropagation()}>
          <div className="menu-root">
            <button
              className="menu-button"
              onClick={() =>
                setActiveMenu(activeMenu === "file" ? null : "file")
              }
            >
              File
            </button>
            {activeMenu === "file" && (
              <div className="menu-popover">
                <button
                  onClick={() => {
                    setActiveMenu(null);
                    tabViewRef.current?.newConcert();
                  }}
                >
                  New
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null);
                    tabViewRef.current?.saveConcert();
                  }}
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null);
                    tabViewRef.current?.saveConcertAs();
                  }}
                >
                  Save As
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null);
                    tabViewRef.current?.openConcert();
                  }}
                >
                  Open
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null);
                    tabViewRef.current?.closeConcert();
                  }}
                >
                  Close
                </button>
              </div>
            )}
          </div>
          <div className="menu-root">
            <button className="menu-button" onClick={() => setActiveMenu(activeMenu === "deploy" ? null : "deploy")}>Stage</button>
            {activeMenu === "deploy" && (
              <div className="menu-popover">
                <div className="stage-menu-server">
                  <span>Server</span>
                  <strong>{selectedServerName}</strong>
                </div>
                <button onClick={() => { setActiveMenu(null); setShowStageResources(true); }}>
                  Stage Resources
                </button>
                <button onClick={() => { setActiveMenu(null); setDeploySourceName(tabViewRef.current?.activeConcertName() || ""); setDeployTarget("selected"); }}>Rehearsal</button>
                <button onClick={() => { setActiveMenu(null); setShowConcertManager(true); }}>Stage Manager</button>
              </div>
            )}
          </div>
          <div className="menu-root">
            <button className="menu-button" onClick={() => setActiveMenu(activeMenu === "view" ? null : "view")}>View</button>
            {activeMenu === "view" && (
              <div className="menu-popover">
                <button onClick={() => { setShowConcertList((visible) => !visible); setActiveMenu(null); }}>
                  <span className="menu-check">{showConcertList ? "✓" : ""}</span>
                  <span>Concert List</span>
                </button>
              </div>
            )}
          </div>
        </nav>
        <div className="server-selector">
          <span>Server</span>
          <select value={selectedServerName} onChange={(event) => { void changeServer(event.target.value); }}>
            {servers.map((server) => <option key={server.name} value={server.name}>{server.name}</option>)}
          </select>
        </div>
      </header>

      <main className="main-workspace">
        {showConcertList && (
          <>
            <div className="concert-list-pane" style={{ width: concertListWidth }}>
              <ConcertListPanel
                apiBaseUrl={selectedApiBaseUrl}
                onClose={() => setShowConcertList(false)}
                openKinds={["concert", "rehearsal", "backup"]}
                onOpen={(name, item) => tabViewRef.current?.openDeploymentConcert(item).catch((error) => window.alert(error.message))}
              />
            </div>
            <div
              className="concert-list-resizer"
              onPointerDown={(event) => {
                resizeRef.current = { startX: event.clientX, startWidth: concertListWidth };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
            />
          </>
        )}
        <div className="concert-tab-pane">
          <ConcertTabView
            ref={tabViewRef}
            defaultServerName={selectedServerName}
            defaultApiBaseUrl={selectedApiBaseUrl}
            servers={servers}
            onServerChange={changeServer}
          />
        </div>
      </main>
      {showStageResources && (
        <StageResourcesDialog
          apiBaseUrl={selectedApiBaseUrl}
          serverName={selectedServerName}
          onClose={() => setShowStageResources(false)}
        />
      )}
      {deployTarget && (
        <DeployDialog
          target={selectedServerName}
          sourceName={deploySourceName}
          apiBaseUrl={selectedApiBaseUrl}
          onClose={() => setDeployTarget(null)}
          onDeploy={async (version, directory, allowVersionMismatch) => {
            const baseName = deploySourceName.split("/").pop();
            const deploymentName = directory ? `${directory}/${baseName}` : baseName;
            const payload = await tabViewRef.current?.prepareDeployment(version, deploymentName);
            if (!payload) throw new Error("No active Concert.");
            const response = await fetch(`${selectedApiBaseUrl}/deployments/rehearsals`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...payload, deploymentPath: deploymentName, sourceName: deploySourceName, allowVersionMismatch }),
            });
            if (!response.ok) {
              const body = await response.json().catch(() => null);
              const detail = body?.detail;
              throw new Error(typeof detail === "string" ? detail : detail?.code === "VERSION_MISMATCH" ? `Production version is ${detail.currentVersion}.` : `Rehearsal failed (${response.status}).`);
            }
            return response.json();
          }}
        />
      )}
      {showConcertManager && (
        <ConcertManagerDialog apiBaseUrl={selectedApiBaseUrl} serverName={selectedServerName} onClose={() => setShowConcertManager(false)} />
      )}
    </div>
  );
}
