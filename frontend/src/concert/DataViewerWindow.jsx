const viewerPayloads = new Map();

window.__metronomeDataViewerPayloads = viewerPayloads;

export function openDataWindow(node, nodeResult, viewerWindow = null, options = {}) {
  const result = nodeResult?.result;
  const dataframe = result?.kind === "dataframe" ? result : null;
  const columns = dataframe?.columns || [];
  const rows = dataframe?.data || dataframe?.preview || [];
  const token = crypto.randomUUID();

  viewerPayloads.set(token, {
    title: `${node.data.name} Data`,
    subtitle: dataframe
      ? `${dataframe.rows} rows / ${columns.length} columns${dataframe.truncated ? ` - showing first ${dataframe.dataLimit}` : ""}`
      : nodeResult?.error || "No run data yet.",
    columns,
    rows,
    rowNumbers: dataframe?.rowNumbers || [],
    dtypes: dataframe?.dtypes || {},
    filteredRows: dataframe?.filteredRows ?? dataframe?.rows ?? rows.length,
    resultOffset: dataframe?.offset || 0,
    error: nodeResult?.error || null,
    dataUrl: options.dataUrl || "",
    queryUrl: options.queryUrl || "",
    apiMode: Boolean(options.apiMode),
    truncated: Boolean(dataframe?.truncated),
    totalRows: dataframe?.rows || rows.length,
  });

  const url = new URL(window.location.href);
  url.searchParams.set("dataViewer", token);
  const viewer = viewerWindow || window.open(
    url.href,
    `data-viewer-${node.id}`,
    "popup=yes,width=1240,height=820,menubar=no,toolbar=no,location=no",
  );
  if (!viewer) {
    viewerPayloads.delete(token);
    alert("Popup was blocked. Allow popups for this app to open the data viewer.");
    return;
  }
  if (viewerWindow) viewer.location.replace(url.href);
  viewer.focus();
}
