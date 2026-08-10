import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

const ROW_HEIGHT = 25;
const COLUMN_WIDTH = 180;
const ROW_NUMBER_WIDTH = 52;
const HEADER_HEIGHT = 57;
const OVERSCAN = 3;
const API_PAGE_SIZE = 1000;
const filterOperators = [["contains", "contains"], ["notContains", "not contain"], ["startsWith", "starts with"], ["endsWith", "ends with"], ["equals", "equals"], ["notEquals", "not equals"], ["gte", ">="], ["gt", ">"], ["lte", "<="], ["lt", "<"], ["empty", "is empty"], ["notEmpty", "not empty"]];
const filterOperatorLabels = Object.fromEntries(filterOperators);
const text = (value) => value == null ? "" : String(value);

function passes(value, filter, numeric) {
  if (!filter || (!["empty", "notEmpty"].includes(filter.operator) && !filter.value)) return true;
  const actualText = text(value);
  if (filter.operator === "empty") return actualText === "";
  if (filter.operator === "notEmpty") return actualText !== "";
  if (["contains", "notContains", "startsWith", "endsWith"].includes(filter.operator)) {
    const actual = actualText.toLowerCase(), target = filter.value.toLowerCase();
    return { contains: actual.includes(target), notContains: !actual.includes(target), startsWith: actual.startsWith(target), endsWith: actual.endsWith(target) }[filter.operator];
  }
  if (numeric && ["equals", "notEquals", "gte", "gt", "lte", "lt"].includes(filter.operator)) {
    const actual = Number(value), target = Number(filter.value);
    if (Number.isNaN(actual) || Number.isNaN(target)) return false;
    return { equals: actual === target, notEquals: actual !== target, gte: actual >= target, gt: actual > target, lte: actual <= target, lt: actual < target }[filter.operator];
  }
  const actual = actualText.toLowerCase(), target = filter.value.toLowerCase();
  return { equals: actual === target, notEquals: actual !== target, gte: actual >= target, gt: actual > target, lte: actual <= target, lt: actual < target }[filter.operator] ?? true;
}

export default function DataViewer({ initialPayload }) {
  const [payload, setPayload] = useState(initialPayload);
  const [visible, setVisible] = useState(() => new Set(initialPayload.columns));
  const [filters, setFilters] = useState({});
  const [search, setSearch] = useState("");
  const [sorts, setSorts] = useState([]);
  const [viewport, setViewport] = useState({ top: 0, left: 0, width: 900, height: 700 });
  const [selection, setSelection] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadedRowCount, setLoadedRowCount] = useState(0);
  const [downloadedRowCount, setDownloadedRowCount] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [criteriaClearance, setCriteriaClearance] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [pageOffset, setPageOffset] = useState(initialPayload.resultOffset || 0);
  const selecting = useRef(false);
  const gridRef = useRef(null);
  const criteriaRef = useRef(null);
  const skipInitialApiRequest = useRef(Boolean(initialPayload.apiMode));
  const deferredSearch = useDeferredValue(search);
  const deferredFilters = useDeferredValue(filters);
  const columns = useMemo(() => payload.columns.filter((column) => visible.has(column)), [payload.columns, visible]);
  const activeFilters = useMemo(
    () => Object.entries(filters).filter(([, filter]) =>
      ["empty", "notEmpty"].includes(filter.operator) || Boolean(filter.value),
    ),
    [filters],
  );
  const hasActiveFilters = Boolean(search.trim()) || activeFilters.length > 0;
  const hasActiveCriteria = sorts.length > 0 || hasActiveFilters;
  const numeric = useMemo(() => Object.fromEntries(payload.columns.map((column) => {
    if (payload.apiMode && payload.dtypes?.[column]) {
      return [column, /^(int|uint|float|decimal)/i.test(payload.dtypes[column])];
    }
    const values = payload.rows.slice(0, 1000).map((row) => row[column]).filter((value) => value != null && value !== "");
    return [column, values.length > 0 && values.every((value) => !Number.isNaN(Number(value)))];
  })), [payload.apiMode, payload.columns, payload.dtypes, payload.rows]);
  const rows = useMemo(() => {
    if (payload.apiMode) {
      return payload.rows.map((row, index) => ({
        row,
        rowNumber: payload.rowNumbers?.[index] ?? pageOffset + index + 1,
      }));
    }
    const term = deferredSearch.trim().toLowerCase();
    let next = payload.rows.map((row, index) => ({ row, rowNumber: index + 1 })).filter(({ row }) =>
      (!term || payload.columns.some((column) => text(row[column]).toLowerCase().includes(term))) &&
      payload.columns.every((column) => passes(row[column], deferredFilters[column], numeric[column]))
    );
    if (sorts.length) next = [...next].sort((a, b) => {
      for (const sort of sorts) {
        const av = a.row[sort.column], bv = b.row[sort.column];
        const comparison = numeric[sort.column]
          ? Number(av) - Number(bv)
          : text(av).localeCompare(text(bv));
        if (comparison) return comparison * (sort.direction === "asc" ? 1 : -1);
      }
      return 0;
    });
    return next;
  }, [payload.apiMode, payload.rows, payload.rowNumbers, payload.columns, deferredSearch, deferredFilters, numeric, pageOffset, sorts]);

  useEffect(() => {
    if (!payload.apiMode || !payload.queryUrl) return undefined;
    if (skipInitialApiRequest.current) {
      skipInitialApiRequest.current = false;
      return undefined;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      setLoadError("");
      try {
        const response = await fetch(payload.queryUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            offset: pageOffset,
            limit: API_PAGE_SIZE,
            search: deferredSearch,
            filters: Object.entries(deferredFilters).map(([column, filter]) => ({
              column,
              operator: filter.operator,
              value: filter.value || "",
            })),
            sorts,
          }),
        });
        if (!response.ok) throw new Error(await response.text());
        const result = (await response.json()).result;
        if (result?.kind !== "dataframe" || !Array.isArray(result.data)) {
          throw new Error("Invalid data response.");
        }
        setPayload((current) => ({
          ...current,
          rows: result.data,
          totalRows: result.rows,
          filteredRows: result.filteredRows,
          dtypes: result.dtypes,
          rowNumbers: result.rowNumbers || [],
        }));
        setSelection(null);
        if (gridRef.current) gridRef.current.scrollTop = 0;
        setViewport((current) => ({ ...current, top: 0 }));
      } catch (error) {
        if (error.name !== "AbortError") setLoadError(error.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [deferredFilters, deferredSearch, pageOffset, payload.apiMode, payload.queryUrl, sorts]);

  useEffect(() => {
    if (!hasActiveCriteria || !criteriaRef.current) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setCriteriaClearance(Math.ceil(entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height) + 28);
    });
    observer.observe(criteriaRef.current);
    return () => observer.disconnect();
  }, [hasActiveCriteria]);

  function cycleSort(column) {
    setPageOffset(0);
    setSorts((current) => {
      const index = current.findIndex((sort) => sort.column === column);
      if (index < 0) return [...current, { column, direction: "asc" }];
      if (current[index].direction === "asc") {
        return current.map((sort, sortIndex) =>
          sortIndex === index ? { ...sort, direction: "desc" } : sort,
        );
      }
      return current.filter((_, sortIndex) => sortIndex !== index);
    });
  }

  const firstRow = Math.max(0, Math.floor((viewport.top - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(rows.length, Math.ceil((viewport.top + viewport.height - HEADER_HEIGHT) / ROW_HEIGHT) + OVERSCAN);
  const firstColumn = Math.max(0, Math.floor((viewport.left - ROW_NUMBER_WIDTH) / COLUMN_WIDTH) - OVERSCAN);
  const lastColumn = Math.min(columns.length, Math.ceil((viewport.left + viewport.width - ROW_NUMBER_WIDTH) / COLUMN_WIDTH) + OVERSCAN);
  const shownRows = rows.slice(firstRow, lastRow);
  const shownColumns = columns.slice(firstColumn, lastColumn);

  async function loadAll() {
    setLoading(true); setLoadedRowCount(0); setLoadError("");
    try {
      const allRows = [];
      let offset = 0;
      while (offset < payload.totalRows) {
        const url = new URL(payload.dataUrl);
        url.searchParams.set("offset", offset); url.searchParams.set("limit", "5000");
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Request failed (${response.status}).`);
        const result = (await response.json()).result;
        if (result?.kind !== "dataframe" || !Array.isArray(result.data)) throw new Error("Invalid data response.");
        allRows.push(...result.data); offset += result.data.length;
        setLoadedRowCount(offset);
        if (!result.hasMore) break;
        if (!result.data.length) throw new Error("The server returned no rows.");
      }
      setPayload((current) => ({ ...current, rows: allRows, truncated: false, subtitle: `${current.totalRows} rows / ${current.columns.length} columns` }));
    } catch (error) { setLoadError(error.message); } finally { setLoading(false); }
  }

  async function downloadCsv() {
    const quote = (value) => `"${text(value).replaceAll('"', '""')}"`;
    if (!payload.apiMode || !payload.queryUrl) {
      const content = [columns.map(quote).join(","), ...rows.map(({ row }) => columns.map((column) => quote(row[column])).join(","))].join("\n");
      const url = URL.createObjectURL(new Blob(["\ufeff", content], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `${payload.title.replace(/\W+/g, "_")}.csv`; link.click(); URL.revokeObjectURL(url);
      return;
    }
    setDownloading(true);
    setDownloadedRowCount(0);
    setLoadError("");
    try {
      const lines = [columns.map(quote).join(",")];
      let offset = 0;
      while (true) {
        const response = await fetch(payload.queryUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset,
            limit: 5000,
            search: deferredSearch,
            filters: Object.entries(deferredFilters).map(([column, filter]) => ({
              column,
              operator: filter.operator,
              value: filter.value || "",
            })),
            sorts,
          }),
        });
        if (!response.ok) throw new Error(await response.text());
        const result = (await response.json()).result;
        if (result?.kind !== "dataframe" || !Array.isArray(result.data)) {
          throw new Error("Invalid data response.");
        }
        for (const row of result.data) {
          lines.push(columns.map((column) => quote(row[column])).join(","));
        }
        offset += result.data.length;
        setDownloadedRowCount(offset);
        if (!result.hasMore) break;
        if (!result.data.length) throw new Error("The server returned no rows.");
      }
      const url = URL.createObjectURL(new Blob(["\ufeff", lines.join("\n")], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `${payload.title.replace(/\W+/g, "_")}.csv`; link.click(); URL.revokeObjectURL(url);
    } catch (error) {
      setLoadError(`CSV download failed: ${error.message}`);
    } finally {
      setDownloading(false);
    }
  }

  function selectionBounds() {
    if (!selection) return null;
    return { top: Math.min(selection.startRow, selection.endRow), bottom: Math.max(selection.startRow, selection.endRow), left: Math.min(selection.startColumn, selection.endColumn), right: Math.max(selection.startColumn, selection.endColumn) };
  }
  const bounds = selectionBounds();

  return <div className="viewer" onMouseUp={() => { selecting.current = false; }} onCopy={(event) => {
    if (!bounds || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    const copied = rows.slice(bounds.top, bounds.bottom + 1).map(({ row }) => columns.slice(bounds.left, bounds.right + 1).map((column) => text(row[column])).join("\t")).join("\n");
    event.preventDefault(); event.clipboardData.setData("text/plain", copied);
  }}>
    <header><div><h1>{payload.title}</h1><div className="sub">{payload.apiMode ? `${(payload.filteredRows ?? payload.totalRows).toLocaleString()} matched / rows ${rows.length ? (pageOffset + 1).toLocaleString() : "0"}-${rows.length ? (pageOffset + rows.length).toLocaleString() : "0"}` : `${payload.subtitle} / ${rows.length.toLocaleString()} shown`}</div></div><div className="tools">
      {loadError && <span className="load-error" title={loadError}>{payload.apiMode ? "Request failed" : "Load all failed"}: {loadError}</span>}
      {payload.truncated && payload.dataUrl && <button onClick={loadAll} disabled={loading}>{loading ? `Loading ${loadedRowCount.toLocaleString()} / ${payload.totalRows.toLocaleString()}` : "View All"}</button>}
      {payload.apiMode && <><button disabled={loading || pageOffset === 0} onClick={() => setPageOffset((current) => Math.max(0, current - API_PAGE_SIZE))}>Previous</button><button disabled={loading || pageOffset + rows.length >= (payload.filteredRows ?? payload.totalRows)} onClick={() => setPageOffset((current) => current + API_PAGE_SIZE)}>Next</button></>}
      <input value={search} onChange={(event) => { setSearch(event.target.value); setPageOffset(0); }} placeholder="Search all data" />
      <button onClick={() => { setSorts([]); setPageOffset(0); }} disabled={!sorts.length}>Clear Sortings</button>
      <button onClick={() => { setFilters({}); setSearch(""); setPageOffset(0); }} disabled={!hasActiveFilters}>Clear Filters</button><button onClick={downloadCsv} disabled={downloading || !columns.length}>{downloading ? `Downloading ${downloadedRowCount.toLocaleString()}` : "Download CSV"}</button>
    </div></header>
    <main><aside><div className="column-title">Columns</div>
      <label className="column-toggle column-toggle-all"><input type="checkbox" checked={payload.columns.length > 0 && visible.size === payload.columns.length} ref={(input) => { if (input) input.indeterminate = visible.size > 0 && visible.size < payload.columns.length; }} onChange={(event) => setVisible(event.target.checked ? new Set(payload.columns) : new Set())}/><span>{visible.size === payload.columns.length ? "Deselect All" : "Select All"}</span></label>
      {payload.columns.map((column) => <label className="column-toggle" key={column}><input type="checkbox" checked={visible.has(column)} onChange={(event) => setVisible((current) => { const next = new Set(current); event.target.checked ? next.add(column) : next.delete(column); return next; })}/><span title={column}>{column}</span></label>)}</aside>
      <div className="grid-pane"><section ref={gridRef} className="grid" onScroll={(event) => { const element = event.currentTarget; setViewport({ top: element.scrollTop, left: element.scrollLeft, width: element.clientWidth, height: element.clientHeight }); }}>
        {payload.error ? <div className="error">{payload.error}</div> : <div className="canvas" style={{ width: ROW_NUMBER_WIDTH + columns.length * COLUMN_WIDTH, height: HEADER_HEIGHT + rows.length * ROW_HEIGHT + (hasActiveCriteria ? criteriaClearance : 0) }}>
          <div className="corner" style={{ transform: `translate(${viewport.left}px, ${viewport.top}px)` }}>No.</div>
          {shownColumns.map((column, index) => { const columnIndex = firstColumn + index; const filter = filters[column] || {}; const sortIndex = sorts.findIndex((sort) => sort.column === column); const columnSort = sorts[sortIndex]; return <div className="column-header" key={column} style={{ transform: `translate(${ROW_NUMBER_WIDTH + columnIndex * COLUMN_WIDTH}px, ${viewport.top}px)` }}>
            <button className="sort" onClick={() => cycleSort(column)} title={`${column}: ascending, descending, clear`}>{column}{columnSort ? ` ${columnSort.direction === "asc" ? "▲" : "▼"}${sortIndex + 1}` : ""}</button>
            <div className="filter"><select value={filter.operator || "contains"} onChange={(event) => { setPageOffset(0); setFilters((current) => ({ ...current, [column]: { ...current[column], operator: event.target.value } })); }}>{filterOperators.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><input value={filter.value || ""} placeholder="Filter" onChange={(event) => { setPageOffset(0); setFilters((current) => ({ ...current, [column]: { operator: current[column]?.operator || "contains", value: event.target.value } })); }}/></div>
          </div>; })}
          {shownRows.map(({ row, rowNumber }, rowOffset) => { const rowIndex = firstRow + rowOffset; return <div key={rowNumber}>
            <div className="row-number" style={{ transform: `translate(${viewport.left}px, ${HEADER_HEIGHT + rowIndex * ROW_HEIGHT}px)` }}>{rowNumber}</div>
            {shownColumns.map((column, columnOffset) => { const columnIndex = firstColumn + columnOffset; const selected = bounds && rowIndex >= bounds.top && rowIndex <= bounds.bottom && columnIndex >= bounds.left && columnIndex <= bounds.right; return <div key={column} className={`cell${selected ? " selected" : ""}`} title={text(row[column])} style={{ transform: `translate(${ROW_NUMBER_WIDTH + columnIndex * COLUMN_WIDTH}px, ${HEADER_HEIGHT + rowIndex * ROW_HEIGHT}px)` }} onMouseDown={(event) => { if (event.button !== 0) return; event.preventDefault(); selecting.current = true; setSelection({ startRow: rowIndex, endRow: rowIndex, startColumn: columnIndex, endColumn: columnIndex }); }} onMouseEnter={() => selecting.current && setSelection((current) => ({ ...current, endRow: rowIndex, endColumn: columnIndex }))}>{text(row[column])}</div>; })}
          </div>; })}
        </div>}
      </section>
      {hasActiveCriteria && <div ref={criteriaRef} className="active-criteria" aria-label="Applied sorting and filters">
        {sorts.map((sort, index) => <span className="criterion sorting" key={`sort-${sort.column}`}><strong>Sort {index + 1}</strong> {sort.column} {sort.direction === "asc" ? "▲ ASC" : "▼ DESC"}<button className="remove-criterion" title={`Remove sorting for ${sort.column}`} aria-label={`Remove sorting for ${sort.column}`} onClick={() => { setSorts((current) => current.filter((item) => item.column !== sort.column)); setPageOffset(0); }}>×</button></span>)}
        {search.trim() && <span className="criterion filtering"><strong>Filter</strong> All columns contains “{search.trim()}”<button className="remove-criterion" title="Remove all-column search" aria-label="Remove all-column search" onClick={() => { setSearch(""); setPageOffset(0); }}>×</button></span>}
        {activeFilters.map(([column, filter]) => <span className="criterion filtering" key={`filter-${column}`}><strong>Filter</strong> {column} {filterOperatorLabels[filter.operator] || filter.operator}{!["empty", "notEmpty"].includes(filter.operator) ? ` “${filter.value}”` : ""}<button className="remove-criterion" title={`Remove filter for ${column}`} aria-label={`Remove filter for ${column}`} onClick={() => { setFilters((current) => { const next = { ...current }; delete next[column]; return next; }); setPageOffset(0); }}>×</button></span>)}
      </div>}
      </div>
    </main>
  </div>;
}
