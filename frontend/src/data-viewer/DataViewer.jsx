import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useErrorDialog } from "../errors/ErrorDialog";

const ROW_HEIGHT = 25;
const DEFAULT_COLUMN_WIDTH = 180;
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 520;
const PAGE_ROW_NUMBER_WIDTH = 44;
const SOURCE_ROW_NUMBER_WIDTH = 60;
const ROW_NUMBER_WIDTH = PAGE_ROW_NUMBER_WIDTH + SOURCE_ROW_NUMBER_WIDTH;
const AUTO_FIT_HEADER_HEIGHT = 80;
const ROW_OVERSCAN = 3;
const COLUMN_OVERSCAN_PX = 360;
const API_PAGE_SIZE = 1000;
const AUTO_SCROLL_EDGE = 38;
const filterOperators = [["contains", "contains"], ["notContains", "not contain"], ["startsWith", "starts with"], ["endsWith", "ends with"], ["equals", "equals"], ["notEquals", "not equals"], ["gte", ">="], ["gt", ">"], ["lte", "<="], ["lt", "<"], ["empty", "is empty"], ["notEmpty", "not empty"]];
const filterOperatorLabels = Object.fromEntries(filterOperators);
const text = (value) => value == null ? "" : String(value);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

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

function moveRelative(items, source, target, side = "before") {
  if (!source || source === target || !items.includes(source) || !items.includes(target)) return items;
  const next = items.filter((item) => item !== source);
  const targetIndex = next.indexOf(target);
  next.splice(targetIndex + (side === "after" ? 1 : 0), 0, source);
  return next;
}

function ContextMenu({ menu, pinning, highlightedColumns, highlightedRows, onPin, onHighlightColumns, onHighlightRows, onClose }) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ x: menu?.x || 0, y: menu?.y || 0 });
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const margin = 6;
    const rect = menuRef.current.getBoundingClientRect();
    setPosition({
      x: clamp(menu.x, margin, Math.max(margin, window.innerWidth - rect.width - margin)),
      y: clamp(menu.y, margin, Math.max(margin, window.innerHeight - rect.height - margin)),
    });
  }, [menu]);
  if (!menu) return null;
  const menuColumns = menu.columns || [];
  const menuRows = menu.rowNumbers || [];
  const hasColumn = menuColumns.length > 0;
  const hasRow = menuRows.length > 0;
  const allPinnedLeft = hasColumn && menuColumns.every((column) => pinning[column] === "left");
  const allPinnedRight = hasColumn && menuColumns.every((column) => pinning[column] === "right");
  const anyPinned = hasColumn && menuColumns.some((column) => pinning[column]);
  const allColumnsHighlighted = hasColumn && menuColumns.every((column) => highlightedColumns.has(column));
  const allRowsHighlighted = hasRow && menuRows.every((rowNumber) => highlightedRows.has(rowNumber));
  return <div ref={menuRef} className="viewer-context-menu" style={{ left: position.x, top: position.y }} onMouseDown={(event) => event.stopPropagation()}>
    {hasColumn && <>
      <button disabled={allPinnedLeft} onClick={() => { onPin(menuColumns, "left"); onClose(); }}>Pin Column Left</button>
      <button disabled={allPinnedRight} onClick={() => { onPin(menuColumns, "right"); onClose(); }}>Pin Column Right</button>
      {anyPinned && <button onClick={() => { onPin(menuColumns, null); onClose(); }}>Unpin Column</button>}
      <button className={`checkable${allColumnsHighlighted ? " checked" : ""}`} onClick={() => { onHighlightColumns(menuColumns); onClose(); }}>{allColumnsHighlighted && <span className="menu-check">✓</span>}Column Highlight</button>
    </>}
    {hasRow && <button className={`checkable${allRowsHighlighted ? " checked" : ""}`} onClick={() => { onHighlightRows(menuRows); onClose(); }}>{allRowsHighlighted && <span className="menu-check">✓</span>}Row Highlight</button>}
  </div>;
}

export default function DataViewer({ initialPayload }) {
  const { showError } = useErrorDialog();
  const [payload, setPayload] = useState(initialPayload);
  const [columnOrder, setColumnOrder] = useState(initialPayload.columns);
  const [columnWidths, setColumnWidths] = useState({});
  const [pinning, setPinning] = useState({});
  const [visible, setVisible] = useState(() => new Set(initialPayload.columns));
  const [filters, setFilters] = useState({});
  const [search, setSearch] = useState("");
  const [sorts, setSorts] = useState([]);
  const [viewport, setViewport] = useState({ top: 0, left: 0, width: 900, height: 700 });
  const [selection, setSelection] = useState(null);
  const [additionalSelections, setAdditionalSelections] = useState([]);
  const [highlightedColumns, setHighlightedColumns] = useState(() => new Set());
  const [highlightedRows, setHighlightedRows] = useState(() => new Set());
  const [contextMenu, setContextMenu] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadedRowCount, setLoadedRowCount] = useState(0);
  const [downloadedRowCount, setDownloadedRowCount] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [criteriaClearance, setCriteriaClearance] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [pageOffset, setPageOffset] = useState(initialPayload.resultOffset || 0);
  const selecting = useRef(false);
  const selectionAnchorRef = useRef(null);
  const pointerRef = useRef(null);
  const dragColumnRef = useRef(null);
  const gridRef = useRef(null);
  const criteriaRef = useRef(null);
  const skipInitialApiRequest = useRef(Boolean(initialPayload.apiMode));
  const deferredSearch = useDeferredValue(search);
  const deferredFilters = useDeferredValue(filters);
  const headerHeight = AUTO_FIT_HEADER_HEIGHT;

  useEffect(() => {
    if (loadError) showError(loadError);
  }, [loadError, showError]);

  useEffect(() => {
    if (payload.error) showError(payload.error);
  }, [payload.error, showError]);

  const fittedWidths = useMemo(() => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context) context.font = "11px Inter, ui-sans-serif, system-ui, sans-serif";
    return Object.fromEntries(payload.columns.map((column) => {
      let width = context?.measureText(column).width || column.length * 7;
      for (const row of payload.rows) width = Math.max(width, context?.measureText(text(row[column])).width || text(row[column]).length * 7);
      const filter = filters[column] || {};
      const operatorLabel = filterOperatorLabels[filter.operator || "contains"] || filter.operator || "contains";
      const filterValue = filter.value || "Filter";
      width = Math.max(width, (context?.measureText(operatorLabel).width || operatorLabel.length * 7) + 34);
      width = Math.max(width, (context?.measureText(filterValue).width || filterValue.length * 7) + 18);
      return [column, clamp(Math.ceil(width) + 24, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH)];
    }));
  }, [filters, payload.columns, payload.rows]);
  const effectiveColumnWidths = useMemo(() => ({ ...fittedWidths, ...columnWidths }), [columnWidths, fittedWidths]);

  const orderedVisibleColumns = useMemo(() => columnOrder.filter((column) => visible.has(column)), [columnOrder, visible]);
  const columns = useMemo(() => {
    const left = orderedVisibleColumns.filter((column) => pinning[column] === "left");
    const center = orderedVisibleColumns.filter((column) => !pinning[column]);
    const right = orderedVisibleColumns.filter((column) => pinning[column] === "right");
    return [...left, ...center, ...right];
  }, [orderedVisibleColumns, pinning]);
  const layout = useMemo(() => {
    let offset = ROW_NUMBER_WIDTH;
    const items = columns.map((column, index) => {
      const width = effectiveColumnWidths[column] || DEFAULT_COLUMN_WIDTH;
      const item = { column, index, width, offset, pin: pinning[column] || null };
      offset += width;
      return item;
    });
    const left = items.filter((item) => item.pin === "left");
    const right = items.filter((item) => item.pin === "right");
    let leftOffset = ROW_NUMBER_WIDTH;
    for (const item of left) { item.pinnedOffset = leftOffset; leftOffset += item.width; }
    const rightWidth = right.reduce((sum, item) => sum + item.width, 0);
    let rightOffset = 0;
    for (const item of right) { item.pinnedOffset = rightOffset; rightOffset += item.width; }
    return { items, totalWidth: offset, leftWidth: leftOffset - ROW_NUMBER_WIDTH, rightWidth };
  }, [columns, effectiveColumnWidths, pinning]);
  const activeFilters = useMemo(() => Object.entries(filters).filter(([, filter]) => ["empty", "notEmpty"].includes(filter.operator) || Boolean(filter.value)), [filters]);
  const hasActiveFilters = activeFilters.length > 0;
  const hasActiveCriteria = sorts.length > 0 || hasActiveFilters;
  const numeric = useMemo(() => Object.fromEntries(payload.columns.map((column) => {
    if (payload.apiMode && payload.dtypes?.[column]) return [column, /^(u?(tiny|small|big|huge)?int|integer|float|double|real|decimal)/i.test(payload.dtypes[column])];
    const values = payload.rows.slice(0, 1000).map((row) => row[column]).filter((value) => value != null && value !== "");
    return [column, values.length > 0 && values.every((value) => !Number.isNaN(Number(value)))];
  })), [payload.apiMode, payload.columns, payload.dtypes, payload.rows]);
  const rows = useMemo(() => {
    if (payload.apiMode) return payload.rows.map((row, index) => ({ row, rowNumber: payload.rowNumbers?.[index] ?? pageOffset + index + 1 }));
    let next = payload.rows.map((row, index) => ({ row, rowNumber: index + 1 })).filter(({ row }) => payload.columns.every((column) => passes(row[column], deferredFilters[column], numeric[column])));
    if (sorts.length) next = [...next].sort((a, b) => {
      for (const sort of sorts) {
        const av = a.row[sort.column], bv = b.row[sort.column];
        const comparison = numeric[sort.column] ? Number(av) - Number(bv) : text(av).localeCompare(text(bv));
        if (comparison) return comparison * (sort.direction === "asc" ? 1 : -1);
      }
      return 0;
    });
    return next;
  }, [payload.apiMode, payload.rows, payload.rowNumbers, payload.columns, deferredFilters, numeric, pageOffset, sorts]);

  useEffect(() => {
    if (!payload.apiMode || !payload.queryUrl) return undefined;
    if (skipInitialApiRequest.current) { skipInitialApiRequest.current = false; return undefined; }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true); setLoadError("");
      try {
        const response = await fetch(payload.queryUrl, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ offset: pageOffset, limit: API_PAGE_SIZE, filters: Object.entries(deferredFilters).map(([column, filter]) => ({ column, operator: filter.operator, value: filter.value || "" })), sorts }) });
        if (!response.ok) throw new Error(await response.text());
        const result = (await response.json()).result;
        if (result?.kind !== "dataframe" || !Array.isArray(result.data)) throw new Error("Invalid data response.");
        setPayload((current) => ({ ...current, rows: result.data, totalRows: result.rows, filteredRows: result.filteredRows, dtypes: result.dtypes, rowNumbers: result.rowNumbers || [] }));
        setColumnWidths({});
        setSelection(null);
        setAdditionalSelections([]);
        selectionAnchorRef.current = null;
        if (gridRef.current) gridRef.current.scrollTop = 0;
        setViewport((current) => ({ ...current, top: 0 }));
      } catch (error) { if (error.name !== "AbortError") setLoadError(error.message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 300);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [deferredFilters, pageOffset, payload.apiMode, payload.queryUrl, sorts]);

  useEffect(() => {
    if (!hasActiveCriteria || !criteriaRef.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setCriteriaClearance(Math.ceil(entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height) + 28));
    observer.observe(criteriaRef.current);
    return () => observer.disconnect();
  }, [hasActiveCriteria]);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("blur", close); };
  }, []);

  useEffect(() => {
    const columnAtPointer = (clientX, rect, element) => {
      const viewportX = clientX - rect.left;
      for (const item of layout.items.filter((candidate) => candidate.pin === "left")) {
        if (viewportX >= item.pinnedOffset && viewportX < item.pinnedOffset + item.width) return item.index;
      }
      const rightStart = element.clientWidth - layout.rightWidth;
      for (const item of layout.items.filter((candidate) => candidate.pin === "right")) {
        const start = rightStart + item.pinnedOffset;
        if (viewportX >= start && viewportX < start + item.width) return item.index;
      }
      const contentX = element.scrollLeft + viewportX;
      const item = layout.items.find((candidate) => !candidate.pin && contentX >= candidate.offset && contentX < candidate.offset + candidate.width);
      return item?.index ?? clamp(layout.items.length - 1, 0, layout.items.length - 1);
    };

    let frame = 0;
    const move = (event) => { pointerRef.current = { x: event.clientX, y: event.clientY }; };
    const up = () => { selecting.current = false; pointerRef.current = null; };
    const tick = () => {
      const element = gridRef.current, pointer = pointerRef.current;
      if (selecting.current && element && pointer && rows.length && columns.length) {
        const rect = element.getBoundingClientRect();
        let dx = 0, dy = 0;
        if (pointer.x < rect.left + AUTO_SCROLL_EDGE) dx = -Math.ceil((rect.left + AUTO_SCROLL_EDGE - pointer.x) / 4);
        else if (pointer.x > rect.right - AUTO_SCROLL_EDGE) dx = Math.ceil((pointer.x - (rect.right - AUTO_SCROLL_EDGE)) / 4);
        if (pointer.y < rect.top + headerHeight + AUTO_SCROLL_EDGE) dy = -Math.ceil((rect.top + headerHeight + AUTO_SCROLL_EDGE - pointer.y) / 4);
        else if (pointer.y > rect.bottom - AUTO_SCROLL_EDGE) dy = Math.ceil((pointer.y - (rect.bottom - AUTO_SCROLL_EDGE)) / 4);
        if (dx || dy) element.scrollBy(dx, dy);
        const rowIndex = clamp(Math.floor((element.scrollTop + pointer.y - rect.top - headerHeight) / ROW_HEIGHT), 0, rows.length - 1);
        const columnIndex = columnAtPointer(pointer.x, rect, element);
        setSelection((current) => current ? { ...current, endRow: rowIndex, endColumn: columnIndex } : current);
      }
      frame = window.requestAnimationFrame(tick);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    frame = window.requestAnimationFrame(tick);
    return () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); window.cancelAnimationFrame(frame); };
  }, [columns.length, headerHeight, layout, rows.length]);

  function cycleSort(column) {
    setPageOffset(0);
    setSorts((current) => {
      const index = current.findIndex((sort) => sort.column === column);
      if (index < 0) return [...current, { column, direction: "asc" }];
      if (current[index].direction === "asc") return current.map((sort, sortIndex) => sortIndex === index ? { ...sort, direction: "desc" } : sort);
      return current.filter((_, sortIndex) => sortIndex !== index);
    });
  }

  function beginResize(event, column) {
    event.preventDefault(); event.stopPropagation();
    const startX = event.clientX, startWidth = effectiveColumnWidths[column] || DEFAULT_COLUMN_WIDTH;
    const move = (moveEvent) => setColumnWidths((current) => ({ ...current, [column]: clamp(startWidth + moveEvent.clientX - startX, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH) }));
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  function startColumnDrag(event, column) {
    dragColumnRef.current = column;
    event.dataTransfer.setData("text/plain", column);
    event.dataTransfer.effectAllowed = "move";
  }

  function selectColumnAndSort(column, columnIndex) {
    setAdditionalSelections([]);
    selectionAnchorRef.current = { row: 0, column: columnIndex };
    setSelection({ startRow: 0, endRow: Math.max(0, rows.length - 1), startColumn: columnIndex, endColumn: columnIndex });
    cycleSort(column);
  }

  function clearSelection() {
    setSelection(null);
    setAdditionalSelections([]);
    selectionAnchorRef.current = null;
  }

  function beginCellSelection(event, rowIndex, columnIndex) {
    const anchor = selectionAnchorRef.current;
    if (event.shiftKey && anchor) {
      setSelection({ startRow: anchor.row, endRow: rowIndex, startColumn: anchor.column, endColumn: columnIndex });
    } else {
      if (event.ctrlKey || event.metaKey) {
        if (selection) setAdditionalSelections((current) => [...current, selection]);
      } else {
        setAdditionalSelections([]);
      }
      selectionAnchorRef.current = { row: rowIndex, column: columnIndex };
      setSelection({ startRow: rowIndex, endRow: rowIndex, startColumn: columnIndex, endColumn: columnIndex });
    }
    selecting.current = true;
    pointerRef.current = { x: event.clientX, y: event.clientY };
  }

  function selectRow(rowIndex) {
    setAdditionalSelections([]);
    selectionAnchorRef.current = { row: rowIndex, column: 0 };
    setSelection({ startRow: rowIndex, endRow: rowIndex, startColumn: 0, endColumn: Math.max(0, columns.length - 1) });
  }

  function openRowContext(event, rowIndex, rowNumber) {
    selectRow(rowIndex);
    openContext(event, { columns: [], rowNumbers: [rowNumber] });
  }

  const firstRow = Math.max(0, Math.floor((viewport.top - headerHeight) / ROW_HEIGHT) - ROW_OVERSCAN);
  const lastRow = Math.min(rows.length, Math.ceil((viewport.top + viewport.height - headerHeight) / ROW_HEIGHT) + ROW_OVERSCAN);
  const shownRows = rows.slice(firstRow, lastRow);
  const shownLayout = layout.items.filter((item) => item.pin || (item.offset + item.width >= viewport.left - COLUMN_OVERSCAN_PX && item.offset <= viewport.left + viewport.width + COLUMN_OVERSCAN_PX));
  const selectionBounds = selection ? { top: Math.min(selection.startRow, selection.endRow), bottom: Math.max(selection.startRow, selection.endRow), left: Math.min(selection.startColumn, selection.endColumn), right: Math.max(selection.startColumn, selection.endColumn) } : null;
  const selectionBoundsList = useMemo(() => [selection, ...additionalSelections].filter(Boolean).map((range) => ({ top: Math.min(range.startRow, range.endRow), bottom: Math.max(range.startRow, range.endRow), left: Math.min(range.startColumn, range.endColumn), right: Math.max(range.startColumn, range.endColumn) })), [additionalSelections, selection]);
  const selectedTargets = () => {
    const selectedColumns = new Set();
    const selectedRowNumbers = new Set();
    for (const bounds of selectionBoundsList) {
      for (let index = Math.max(0, bounds.left); index <= Math.min(columns.length - 1, bounds.right); index += 1) selectedColumns.add(columns[index]);
      for (let index = Math.max(0, bounds.top); index <= Math.min(rows.length - 1, bounds.bottom); index += 1) selectedRowNumbers.add(rows[index].rowNumber);
    }
    return { columns: [...selectedColumns], rowNumbers: [...selectedRowNumbers] };
  };
  const itemTransform = (item, y) => {
    if (item.pin === "left") return `translate(${viewport.left + item.pinnedOffset}px, ${y}px)`;
    if (item.pin === "right") return `translate(${viewport.left + Math.max(ROW_NUMBER_WIDTH + layout.leftWidth, viewport.width - layout.rightWidth) + item.pinnedOffset}px, ${y}px)`;
    return `translate(${item.offset}px, ${y}px)`;
  };

  async function loadAll() {
    setLoading(true); setLoadedRowCount(0); setLoadError("");
    try {
      const allRows = []; let offset = 0;
      while (offset < payload.totalRows) {
        const url = new URL(payload.dataUrl); url.searchParams.set("offset", offset); url.searchParams.set("limit", String(API_PAGE_SIZE));
        const response = await fetch(url); if (!response.ok) throw new Error(`Request failed (${response.status}).`);
        const result = (await response.json()).result; if (result?.kind !== "dataframe" || !Array.isArray(result.data)) throw new Error("Invalid data response.");
        allRows.push(...result.data); offset += result.data.length; setLoadedRowCount(offset);
        if (!result.hasMore) break; if (!result.data.length) throw new Error("The server returned no rows.");
      }
      setPayload((current) => ({ ...current, rows: allRows, truncated: false, subtitle: `${current.totalRows} rows / ${current.columns.length} columns` }));
      setColumnWidths({});
    } catch (error) { setLoadError(error.message); } finally { setLoading(false); }
  }

  async function downloadCsv() {
    const quote = (value) => `"${text(value).replaceAll('"', '""')}"`;
    if (!payload.apiMode || !payload.queryUrl) {
      const content = [columns.map(quote).join(","), ...rows.map(({ row }) => columns.map((column) => quote(row[column])).join(","))].join("\n");
      const url = URL.createObjectURL(new Blob(["\ufeff", content], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `${payload.title.replace(/\W+/g, "_")}.csv`; link.click(); URL.revokeObjectURL(url); return;
    }
    setDownloading(true); setDownloadedRowCount(0); setLoadError("");
    try {
      const lines = [columns.map(quote).join(",")]; let offset = 0;
      while (true) {
        const response = await fetch(payload.queryUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offset, limit: API_PAGE_SIZE, filters: Object.entries(deferredFilters).map(([column, filter]) => ({ column, operator: filter.operator, value: filter.value || "" })), sorts }) });
        if (!response.ok) throw new Error(await response.text());
        const result = (await response.json()).result; if (result?.kind !== "dataframe" || !Array.isArray(result.data)) throw new Error("Invalid data response.");
        for (const row of result.data) lines.push(columns.map((column) => quote(row[column])).join(","));
        offset += result.data.length; setDownloadedRowCount(offset);
        if (!result.hasMore) break; if (!result.data.length) throw new Error("The server returned no rows.");
      }
      const url = URL.createObjectURL(new Blob(["\ufeff", lines.join("\n")], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `${payload.title.replace(/\W+/g, "_")}.csv`; link.click(); URL.revokeObjectURL(url);
    } catch (error) { setLoadError(`CSV download failed: ${error.message}`); } finally { setDownloading(false); }
  }

  const selectAll = () => {
    if (!rows.length || !columns.length) return;
    setAdditionalSelections([]);
    selectionAnchorRef.current = { row: 0, column: 0 };
    setSelection({ startRow: 0, endRow: rows.length - 1, startColumn: 0, endColumn: columns.length - 1 });
  };
  const openContext = (event, details) => { event.preventDefault(); event.stopPropagation(); setContextMenu({ x: event.clientX, y: event.clientY, ...details }); };
  const toggleSetValues = (setter, values) => setter((current) => {
    const next = new Set(current);
    const shouldRemove = values.every((value) => next.has(value));
    for (const value of values) shouldRemove ? next.delete(value) : next.add(value);
    return next;
  });

  return <div className="viewer auto-fit" tabIndex={0} onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) { event.preventDefault(); selectAll(); }
  }} onCopy={(event) => {
    if (!selectionBounds || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    const copied = rows.slice(selectionBounds.top, selectionBounds.bottom + 1).map(({ row }) => columns.slice(selectionBounds.left, selectionBounds.right + 1).map((column) => text(row[column])).join("\t")).join("\n");
    event.preventDefault(); event.clipboardData.setData("text/plain", copied);
  }}>
    <header><div><h1>{payload.title}</h1><div className="sub">{payload.apiMode ? `${(payload.filteredRows ?? payload.totalRows).toLocaleString()} matched / rows ${rows.length ? (pageOffset + 1).toLocaleString() : "0"}-${rows.length ? (pageOffset + rows.length).toLocaleString() : "0"}` : `${payload.subtitle} / ${rows.length.toLocaleString()} shown`}</div></div><div className="tools">
      {payload.truncated && payload.dataUrl && <button onClick={loadAll} disabled={loading}>{loading ? `Loading ${loadedRowCount.toLocaleString()} / ${payload.totalRows.toLocaleString()}` : "View All"}</button>}
      {payload.apiMode && <><button disabled={loading || pageOffset === 0} onClick={() => setPageOffset((current) => Math.max(0, current - API_PAGE_SIZE))}>Previous</button><button disabled={loading || pageOffset + rows.length >= (payload.filteredRows ?? payload.totalRows)} onClick={() => setPageOffset((current) => current + API_PAGE_SIZE)}>Next</button></>}
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search current page" />
      <button onClick={() => { setSorts([]); setPageOffset(0); }} disabled={!sorts.length}>Clear Sortings</button>
      <button onClick={() => { setFilters({}); setPageOffset(0); }} disabled={!hasActiveFilters}>Clear Filters</button><button onClick={downloadCsv} disabled={downloading || !columns.length}>{downloading ? `Downloading ${downloadedRowCount.toLocaleString()}` : "Download CSV"}</button>
    </div></header>
    <main><aside><div className="column-title">Columns</div>
      <label className="column-toggle column-toggle-all"><input type="checkbox" checked={payload.columns.length > 0 && visible.size === payload.columns.length} ref={(input) => { if (input) input.indeterminate = visible.size > 0 && visible.size < payload.columns.length; }} onChange={(event) => setVisible(event.target.checked ? new Set(payload.columns) : new Set())}/><span>{visible.size === payload.columns.length ? "Deselect All" : "Select All"}</span></label>
      {columnOrder.map((column) => <label className={`column-toggle draggable${dropTarget?.surface === "list" && dropTarget.column === column ? ` drop-${dropTarget.side}` : ""}`} draggable key={column} onDragStart={(event) => startColumnDrag(event, column)} onDragEnd={() => { dragColumnRef.current = null; setDropTarget(null); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; const rect = event.currentTarget.getBoundingClientRect(); setDropTarget({ surface: "list", column, side: event.clientY < rect.top + rect.height / 2 ? "before" : "after" }); }} onDrop={(event) => { event.preventDefault(); const source = dragColumnRef.current || event.dataTransfer.getData("text/plain"); const side = dropTarget?.column === column ? dropTarget.side : "before"; setColumnOrder((current) => moveRelative(current, source, column, side)); dragColumnRef.current = null; setDropTarget(null); clearSelection(); }}><input type="checkbox" checked={visible.has(column)} onChange={(event) => setVisible((current) => { const next = new Set(current); event.target.checked ? next.add(column) : next.delete(column); return next; })}/><span title={column}>{pinning[column] === "left" ? "◀ " : pinning[column] === "right" ? "▶ " : ""}{column}</span></label>)}</aside>
      <div className="grid-pane"><section ref={gridRef} className="grid" onScroll={(event) => { const element = event.currentTarget; setViewport({ top: element.scrollTop, left: element.scrollLeft, width: element.clientWidth, height: element.clientHeight }); }}>
        {!payload.error && <div className="canvas" style={{ width: Math.max(layout.totalWidth, viewport.width), height: headerHeight + rows.length * ROW_HEIGHT + (hasActiveCriteria ? criteriaClearance : 0) }}>
          <button className="corner page-row-corner" style={{ transform: `translate(${viewport.left}px, ${viewport.top}px)` }} onClick={selectAll}>Page</button>
          <button className="corner source-row-corner" style={{ transform: `translate(${viewport.left + PAGE_ROW_NUMBER_WIDTH}px, ${viewport.top}px)` }} onClick={selectAll}>Original</button>
          {layout.leftWidth > 0 && <div className="pin-boundary pin-boundary-left" style={{ height: viewport.height, transform: `translate(${viewport.left + ROW_NUMBER_WIDTH + layout.leftWidth}px, ${viewport.top}px)` }} />}
          {layout.rightWidth > 0 && <div className="pin-boundary pin-boundary-right" style={{ height: viewport.height, transform: `translate(${viewport.left + Math.max(ROW_NUMBER_WIDTH + layout.leftWidth, viewport.width - layout.rightWidth)}px, ${viewport.top}px)` }} />}
          {shownLayout.map((item) => { const column = item.column, filter = filters[column] || {}, sortIndex = sorts.findIndex((sort) => sort.column === column), columnSort = sorts[sortIndex], dropClass = dropTarget?.surface === "header" && dropTarget.column === column ? ` drop-${dropTarget.side}` : "", pinClass = item.pin === "right" && item.pinnedOffset === 0 ? " pin-right-start" : ""; return <div className={`column-header${item.pin ? " pinned" : ""}${pinClass}${highlightedColumns.has(column) ? " highlighted" : ""}${dropClass}`} draggable key={column} style={{ width: item.width, transform: itemTransform(item, viewport.top), zIndex: item.pin ? 5 : 3 }} onDragStart={(event) => startColumnDrag(event, column)} onDragEnd={() => { dragColumnRef.current = null; setDropTarget(null); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; const rect = event.currentTarget.getBoundingClientRect(); setDropTarget({ surface: "header", column, side: event.clientX < rect.left + rect.width / 2 ? "before" : "after" }); }} onDrop={(event) => { event.preventDefault(); const source = dragColumnRef.current || event.dataTransfer.getData("text/plain"); const side = dropTarget?.column === column ? dropTarget.side : "before"; setColumnOrder((current) => moveRelative(current, source, column, side)); dragColumnRef.current = null; setDropTarget(null); clearSelection(); }} onContextMenu={(event) => { setAdditionalSelections([]); selectionAnchorRef.current = { row: 0, column: item.index }; setSelection({ startRow: 0, endRow: Math.max(0, rows.length - 1), startColumn: item.index, endColumn: item.index }); openContext(event, { columns: [column], rowNumbers: [] }); }}>
            <button className="sort" draggable onDragStart={(event) => startColumnDrag(event, column)} onClick={() => selectColumnAndSort(column, item.index)} title={`${column}: select column and cycle ascending, descending, clear`}>{column}{columnSort ? ` ${columnSort.direction === "asc" ? "▲" : "▼"}${sortIndex + 1}` : ""}</button>
            <div className="filter"><select draggable={false} value={filter.operator || "contains"} onChange={(event) => { setPageOffset(0); setFilters((current) => ({ ...current, [column]: { ...current[column], operator: event.target.value } })); }}>{filterOperators.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><input draggable={false} value={filter.value || ""} placeholder="Filter" onChange={(event) => { setPageOffset(0); setFilters((current) => ({ ...current, [column]: { operator: current[column]?.operator || "contains", value: event.target.value } })); }}/></div>
            <span className="column-resizer" onMouseDown={(event) => beginResize(event, column)} />
          </div>; })}
          {shownRows.map(({ row, rowNumber }, rowOffset) => { const rowIndex = firstRow + rowOffset, rowHighlighted = highlightedRows.has(rowNumber); return <div key={rowNumber}>
            <button className={`row-number page-row-number${rowHighlighted ? " highlighted" : ""}`} style={{ transform: `translate(${viewport.left}px, ${headerHeight + rowIndex * ROW_HEIGHT}px)` }} onClick={() => selectRow(rowIndex)} onContextMenu={(event) => openRowContext(event, rowIndex, rowNumber)}>{rowIndex + 1}</button>
            <button className={`row-number source-row-number${rowHighlighted ? " highlighted" : ""}`} style={{ transform: `translate(${viewport.left + PAGE_ROW_NUMBER_WIDTH}px, ${headerHeight + rowIndex * ROW_HEIGHT}px)` }} onClick={() => selectRow(rowIndex)} onContextMenu={(event) => openRowContext(event, rowIndex, rowNumber)}>{rowNumber}</button>
            {shownLayout.map((item) => { const column = item.column, selected = selectionBoundsList.some((bounds) => rowIndex >= bounds.top && rowIndex <= bounds.bottom && item.index >= bounds.left && item.index <= bounds.right), searchMatch = Boolean(deferredSearch.trim()) && text(row[column]).toLowerCase().includes(deferredSearch.trim().toLowerCase()), columnHighlighted = highlightedColumns.has(column), pinClass = item.pin === "right" && item.pinnedOffset === 0 ? " pin-right-start" : ""; return <div key={column} className={`cell${item.pin ? " pinned" : ""}${pinClass}${columnHighlighted ? " column-highlighted" : ""}${rowHighlighted ? " row-highlighted" : ""}${searchMatch ? " search-match" : ""}${selected ? " selected" : ""}`} title={text(row[column])} style={{ width: item.width, transform: itemTransform(item, headerHeight + rowIndex * ROW_HEIGHT), zIndex: item.pin ? 4 : 1 }} onContextMenu={(event) => { let targets; if (selected) { targets = selectedTargets(); } else { setAdditionalSelections([]); selectionAnchorRef.current = { row: rowIndex, column: item.index }; setSelection({ startRow: rowIndex, endRow: rowIndex, startColumn: item.index, endColumn: item.index }); targets = { columns: [column], rowNumbers: [rowNumber] }; } openContext(event, targets); }} onMouseDown={(event) => { if (event.button !== 0) return; event.preventDefault(); beginCellSelection(event, rowIndex, item.index); }}>{text(row[column])}</div>; })}
          </div>; })}
        </div>}
      </section>
      {hasActiveCriteria && <div ref={criteriaRef} className="active-criteria" aria-label="Applied sorting and filters">
        {sorts.map((sort, index) => <span className="criterion sorting" key={`sort-${sort.column}`}><strong>Sort {index + 1}</strong> {sort.column} {sort.direction === "asc" ? "▲ ASC" : "▼ DESC"}<button className="remove-criterion" onClick={() => { setSorts((current) => current.filter((item) => item.column !== sort.column)); setPageOffset(0); }}>×</button></span>)}
        {activeFilters.map(([column, filter]) => <span className="criterion filtering" key={`filter-${column}`}><strong>Filter</strong> {column} {filterOperatorLabels[filter.operator] || filter.operator}{!["empty", "notEmpty"].includes(filter.operator) ? ` “${filter.value}”` : ""}<button className="remove-criterion" onClick={() => { setFilters((current) => { const next = { ...current }; delete next[column]; return next; }); setPageOffset(0); }}>×</button></span>)}
      </div>}
      </div>
    </main>
    <ContextMenu menu={contextMenu} pinning={pinning} highlightedColumns={highlightedColumns} highlightedRows={highlightedRows} onPin={(targetColumns, side) => { setPinning((current) => { const next = { ...current }; for (const column of targetColumns) { if (side) next[column] = side; else delete next[column]; } return next; }); }} onHighlightColumns={(targetColumns) => toggleSetValues(setHighlightedColumns, targetColumns)} onHighlightRows={(targetRows) => toggleSetValues(setHighlightedRows, targetRows)} onClose={() => setContextMenu(null)} />
  </div>;
}
