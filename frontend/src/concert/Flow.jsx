import { useEffect, useRef, useState } from "react";

import "reactflow/dist/style.css";
import "./Flow.css";

import ConcertListPanel from "./ConcertListPanel";
import ConcertTabView from "./ConcertTabView";
import DeployDialog from "./DeployDialog";
import ConcertManagerDialog from "./ConcertManagerDialog";
import StageResourcesDialog from "./StageResourcesDialog";

const queryLocalPort = Number(
  new URLSearchParams(window.location.search).get("localPort"),
);
const localServerPort =
  Number.isInteger(queryLocalPort) && queryLocalPort >= 1 && queryLocalPort <= 65535
    ? queryLocalPort
    : 8000;
const localApiBaseUrl = `http://localhost:${localServerPort}`;

export default function Flow() {
  const tabViewRef = useRef(null);
  const resizeRef = useRef(null);
  const mainMenuRef = useRef(null);
  const [activeMenu, setActiveMenu] = useState(null);
  const [showStageResources, setShowStageResources] = useState(false);
  const [deployTarget, setDeployTarget] = useState(null);
  const [deploySourceName, setDeploySourceName] = useState("");
  const [showConcertManager, setShowConcertManager] = useState(false);
  const [showConcertList, setShowConcertList] = useState(true);
  const [concertListRefreshKey, setConcertListRefreshKey] = useState(0);
  const [hasActiveConcert, setHasActiveConcert] = useState(false);
  const [concertListWidth, setConcertListWidth] = useState(430);
  const [servers, setServers] = useState([]);
  const [selectedServerName, setSelectedServerName] = useState("Local");
  const selectedServer =
    servers.find((server) => server.name === selectedServerName) || {
      name: "Local",
      host: "localhost",
      port: localServerPort,
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
    fetch(`${localApiBaseUrl}/servers`)
      .then((response) => response.json())
      .then((body) => {
        setServers(body.servers || []);
        setSelectedServerName(body.defaultServerName || body.servers?.[0]?.name || "Local");
      });
  }, []);

  useEffect(() => {
    const closeMenuOutside = (event) => {
      const menuRoot = event.target.closest?.(".menu-root");
      if (!menuRoot || !mainMenuRef.current?.contains(menuRoot)) {
        setActiveMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeMenuOutside, true);
    return () => {
      document.removeEventListener("pointerdown", closeMenuOutside, true);
    };
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

        <nav
          ref={mainMenuRef}
          className="menu-bar"
          onClick={(event) => event.stopPropagation()}
        >
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
                <button disabled={!hasActiveConcert} onClick={() => {
                  if (!tabViewRef.current?.hasActiveConcert()) return;
                  setActiveMenu(null);
                  setDeploySourceName(tabViewRef.current.activeConcertName());
                  setDeployTarget("selected");
                }}>Rehearsal</button>
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
                refreshKey={concertListRefreshKey}
                onClose={() => setShowConcertList(false)}
                openKinds={["playing", "rehearsal", "backup"]}
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
            onActiveConcertChange={setHasActiveConcert}
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
          onDirectoryCreated={() => setConcertListRefreshKey((value) => value + 1)}
          onClose={() => setDeployTarget(null)}
          onDeploy={async (version, directory, allowMismatch, nextCommitId) => {
            const baseName = deploySourceName.split("/").pop();
            const deploymentName = directory ? `${directory}/${baseName}` : baseName;
            const payload = await tabViewRef.current?.prepareDeployment(version, deploymentName, nextCommitId);
            if (!payload) throw new Error("No active Concert.");
            const response = await fetch(`${selectedApiBaseUrl}/deployments/rehearsals`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...payload, deploymentPath: deploymentName, sourceName: deploySourceName, allowMismatch }),
            });
            if (!response.ok) {
              const body = await response.json().catch(() => null);
              const detail = body?.detail;
              const nextError = new Error(
                typeof detail === "string"
                  ? detail
                  : detail?.message || `Rehearsal failed (${response.status}).`,
              );
              nextError.retryableMismatch = detail?.code === "DEPLOYMENT_MISMATCH";
              throw nextError;
            }
            const result = await response.json();
            await tabViewRef.current?.completeDeployment(version, nextCommitId);
            setConcertListRefreshKey((value) => value + 1);
            return result;
          }}
        />
      )}
      {showConcertManager && (
        <ConcertManagerDialog
          apiBaseUrl={selectedApiBaseUrl}
          serverName={selectedServerName}
          onDeploymentChange={() => setConcertListRefreshKey((value) => value + 1)}
          onClose={() => setShowConcertManager(false)}
        />
      )}
    </div>
  );
}
