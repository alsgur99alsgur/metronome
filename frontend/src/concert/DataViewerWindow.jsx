const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function openDataWindow(
  node,
  nodeResult,
  viewerWindow = null,
  options = {},
) {
  const result = nodeResult?.result;
  const dataframe = result?.kind === "dataframe" ? result : null;
  const columns = dataframe?.columns || [];
  const rows = dataframe?.data || dataframe?.preview || [];
  const payload = {
    title: `${node.data.name} Data`,
    subtitle: dataframe
      ? `${dataframe.rows} rows / ${columns.length} columns${dataframe.truncated ? ` - showing first ${dataframe.dataLimit}` : ""}`
      : nodeResult?.error || "No run data yet.",
    columns,
    rows,
    error: nodeResult?.error || null,
    dataUrl: options.dataUrl || "",
    truncated: Boolean(dataframe?.truncated),
    totalRows: dataframe?.rows || rows.length,
  };
  const safeJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  const viewer = viewerWindow || window.open(
    "",
    `data-viewer-${node.id}`,
    "popup=yes,width=1240,height=820,menubar=no,toolbar=no,location=no",
  );

  if (!viewer) {
    alert(
      "Popup was blocked. Allow popups for this app to open the data viewer.",
    );
    return;
  }

  viewer.document.open();
  viewer.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(payload.title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #111827; background: #f8fafc; font: 11px/1.25 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { min-height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 7px; border-bottom: 1px solid #d7dce2; background: #fff; }
    h1 { margin: 0; font-size: 13px; }
    .sub { color: #64748b; font-size: 10px; margin-top: 1px; }
    .tools { display: flex; align-items: center; gap: 4px; }
    .load-error { max-width: 220px; overflow: hidden; color: #b91c1c; font-size: 10px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
    input, select { height: 24px; border: 1px solid #cbd5e1; border-radius: 3px; background: #fff; padding: 0 5px; font: inherit; }
    #global-search { width: 210px; }
    button { height: 24px; border: 1px solid #cbd5e1; border-radius: 3px; background: #fff; color: #111827; cursor: pointer; font: inherit; font-weight: 700; padding: 0 7px; }
    main { height: calc(100vh - 40px); display: grid; grid-template-columns: 180px 1fr; min-height: 0; }
    aside { border-right: 1px solid #d7dce2; background: #fff; padding: 5px; overflow: auto; }
    .column-title { margin-bottom: 4px; color: #475569; font-size: 10px; font-weight: 800; text-transform: uppercase; }
    .column-toggle { display: grid; grid-template-columns: 14px 1fr; align-items: center; gap: 4px; min-height: 20px; font-size: 11px; text-align: left; }
    .column-toggle input { width: 12px; height: 12px; margin: 0; justify-self: start; }
    .grid-wrap { min-width: 0; overflow: auto; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 11px; line-height: 15px; background: #fff; }
    th, td { border-right: 1px solid #eef2f7; border-bottom: 1px solid #eef2f7; padding: 3px 6px; text-align: left; white-space: nowrap; }
    th { position: sticky; top: 0; z-index: 2; background: #f1f5f9; vertical-align: top; font-size: 10px; font-weight: 800; user-select: none; }
    .row-number-header, .row-number-cell { width: 48px; min-width: 48px; max-width: 48px; text-align: right; color: #64748b; }
    .row-number-header { left: 0; z-index: 3; }
    .row-number-cell { position: sticky; left: 0; z-index: 1; background: #fff; font-variant-numeric: tabular-nums; font-weight: 700; }
    tr:nth-child(even) .row-number-cell { background: #fbfdff; }
    .sort-label { cursor: pointer; display: block; margin-bottom: 3px; }
    .filter-row { display: grid; grid-template-columns: minmax(76px, auto) minmax(96px, 1fr); gap: 3px; align-items: center; }
    .filter-row select, .filter-row input { width: 100%; height: 22px; font-size: 10px; }
    tr:nth-child(even) td { background: #fbfdff; }
    td { max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
    td.data-cell { cursor: cell; user-select: none; }
    td.data-cell.cell-selected { background: #dbeafe; box-shadow: inset 0 0 0 1px #60a5fa; }
    tr:nth-child(even) td.data-cell.cell-selected { background: #dbeafe; }
    td.empty-cell { padding: 10px; color: #64748b; text-align: center; background: #fff; }
    .empty { padding: 10px; color: #64748b; }
    .error { margin: 6px; border: 1px solid #fecaca; border-radius: 3px; background: #fff1f2; color: #991b1b; padding: 6px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 id="title"></h1>
      <div class="sub" id="subtitle"></div>
    </div>
    <div class="tools">
      <span class="load-error" id="load-error"></span>
      <button id="view-all" hidden>View All</button>
      <input id="global-search" placeholder="Search all visible data" />
      <button id="clear-filters">Clear Filters</button>
      <button id="csv">Download CSV</button>
    </div>
  </header>
  <main>
    <aside>
      <div class="column-title">Columns</div>
      <div id="columns"></div>
    </aside>
    <section class="grid-wrap" id="grid"></section>
  </main>
  <script id="payload" type="application/json">${safeJson}</script>
  <script>
    const payload = JSON.parse(document.getElementById("payload").textContent);
    let visibleColumns = new Set(payload.columns);
    let sort = { column: null, direction: "asc" };
    let globalSearch = "";
    let filters = {};
    let cellSelection = null;
    let isSelectingCells = false;
    let indexedRows = payload.rows.map((row, index) => ({ row, rowNumber: index + 1 }));

    const stringOperators = [
      ["contains", "contains"],
      ["notContains", "not contain"],
      ["startsWith", "starts with"],
      ["endsWith", "ends with"],
      ["equals", "equals"],
      ["notEquals", "not equals"],
      ["empty", "is empty"],
      ["notEmpty", "not empty"],
    ];
    const numericOperators = [
      ["eq", "=="],
      ["ne", "!="],
      ["gte", ">="],
      ["gt", ">"],
      ["lte", "<="],
      ["lt", "<"],
      ["empty", "is empty"],
      ["notEmpty", "not empty"],
    ];

    document.getElementById("title").textContent = payload.title;
    document.getElementById("subtitle").textContent = payload.subtitle;
    const viewAllButton = document.getElementById("view-all");
    const loadError = document.getElementById("load-error");
    viewAllButton.hidden = !payload.truncated || !payload.dataUrl;

    async function loadAllRows() {
      viewAllButton.disabled = true;
      loadError.textContent = "";
      const allRows = [];
      let offset = 0;
      try {
        while (offset < payload.totalRows) {
          viewAllButton.textContent = "Loading " + offset.toLocaleString() + " / " + payload.totalRows.toLocaleString();
          const url = new URL(payload.dataUrl);
          url.searchParams.set("offset", String(offset));
          url.searchParams.set("limit", "5000");
          const response = await fetch(url.toString());
          if (!response.ok) throw new Error("Request failed (" + response.status + ").");
          const body = await response.json();
          const result = body.result;
          if (result?.kind !== "dataframe" || !Array.isArray(result.data)) {
            throw new Error("Invalid data response.");
          }
          allRows.push(...result.data);
          offset += result.data.length;
          if (!result.hasMore) break;
          if (!result.data.length) throw new Error("The server returned no rows.");
        }
        payload.rows = allRows;
        payload.truncated = false;
        payload.subtitle = payload.totalRows + " rows / " + payload.columns.length + " columns";
        indexedRows = payload.rows.map((row, index) => ({ row, rowNumber: index + 1 }));
        viewAllButton.hidden = true;
        viewAllButton.textContent = "View All";
        renderGrid();
      } catch (error) {
        loadError.textContent = "Load all failed: " + error.message;
        loadError.title = loadError.textContent;
        viewAllButton.disabled = false;
        viewAllButton.textContent = "Retry View All";
      }
    }

    function cellValue(row, column) {
      const value = row[column];
      return value == null ? "" : String(value);
    }

    function isNumericColumn(column) {
      const valuesForTypeCheck = indexedRows.map((item) => item.row[column]).filter((value) => value !== null && value !== undefined && value !== "");
      return valuesForTypeCheck.length > 0 && valuesForTypeCheck.every((value) => !Number.isNaN(Number(value)));
    }

    function passStringFilter(value, operator, expected) {
      const actual = value.toLowerCase();
      const target = expected.toLowerCase();
      if (operator === "contains") return actual.includes(target);
      if (operator === "notContains") return !actual.includes(target);
      if (operator === "startsWith") return actual.startsWith(target);
      if (operator === "endsWith") return actual.endsWith(target);
      if (operator === "equals") return actual === target;
      if (operator === "notEquals") return actual !== target;
      if (operator === "empty") return actual === "";
      if (operator === "notEmpty") return actual !== "";
      return true;
    }

    function passNumericFilter(value, operator, expected) {
      const actualText = String(value ?? "");
      if (operator === "empty") return actualText === "";
      if (operator === "notEmpty") return actualText !== "";
      const actual = Number(value);
      const target = Number(expected);
      if (Number.isNaN(actual) || Number.isNaN(target)) return false;
      if (operator === "eq") return actual === target;
      if (operator === "ne") return actual !== target;
      if (operator === "gte") return actual >= target;
      if (operator === "gt") return actual > target;
      if (operator === "lte") return actual <= target;
      if (operator === "lt") return actual < target;
      return true;
    }

    function passColumnFilter(row, column) {
      const filter = filters[column];
      if (!filter) return true;
      const needsValue = !["empty", "notEmpty"].includes(filter.operator);
      if (needsValue && filter.value === "") return true;
      const value = cellValue(row, column);
      return isNumericColumn(column)
        ? passNumericFilter(value, filter.operator, filter.value)
        : passStringFilter(value, filter.operator, filter.value);
    }

    function filteredRows() {
      const term = globalSearch.trim().toLowerCase();
      let next = indexedRows.filter(({ row }) => {
        const passesGlobal = !term || payload.columns.some((column) => cellValue(row, column).toLowerCase().includes(term));
        const passesColumns = payload.columns.every((column) => passColumnFilter(row, column));
        return passesGlobal && passesColumns;
      });
      if (sort.column) {
        const direction = sort.direction === "asc" ? 1 : -1;
        next = [...next].sort((a, b) => {
          const av = a.row[sort.column];
          const bv = b.row[sort.column];
          const an = Number(av);
          const bn = Number(bv);
          if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * direction;
          return cellValue(a.row, sort.column).localeCompare(cellValue(b.row, sort.column)) * direction;
        });
      }
      return next;
    }

    function escape(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function renderColumns() {
      document.getElementById("columns").innerHTML = payload.columns.map((column) => (
        '<label class="column-toggle"><input type="checkbox" data-column="' + escape(column) + '" checked /><span>' + escape(column) + '</span></label>'
      )).join("");
      document.querySelectorAll("[data-column]").forEach((input) => {
        input.addEventListener("change", () => {
          if (input.checked) visibleColumns.add(input.dataset.column);
          else visibleColumns.delete(input.dataset.column);
          renderGrid();
        });
      });
    }

    function operatorOptions(column) {
      const options = isNumericColumn(column) ? numericOperators : stringOperators;
      const current = filters[column]?.operator || options[0][0];
      return options.map(([value, label]) => '<option value="' + value + '"' + (current === value ? " selected" : "") + '>' + label + '</option>').join("");
    }

    function headerHtml(column) {
      const filter = filters[column] || {};
      return '<th>' +
        '<span class="sort-label" data-sort="' + escape(column) + '">' + escape(column) + (sort.column === column ? (sort.direction === "asc" ? " ▲" : " ▼") : "") + '</span>' +
        '<div class="filter-row">' +
          '<select data-filter-op="' + escape(column) + '">' + operatorOptions(column) + '</select>' +
          '<input data-filter-value="' + escape(column) + '" value="' + escape(filter.value || "") + '" placeholder="Filter" />' +
        '</div>' +
      '</th>';
    }

    function renderGrid() {
      const activeElement = document.activeElement;
      const activeFilterColumn = activeElement?.dataset?.filterValue || null;
      const activeSelectionStart = activeElement?.selectionStart ?? null;
      const activeSelectionEnd = activeElement?.selectionEnd ?? null;
      const columns = payload.columns.filter((column) => visibleColumns.has(column));
      const rows = filteredRows();
      document.getElementById("subtitle").textContent = payload.subtitle + " / " + rows.length + " shown";
      if (payload.error) {
        document.getElementById("grid").innerHTML = '<div class="error">' + escape(payload.error) + '</div>';
        return;
      }
      if (!columns.length) {
        document.getElementById("grid").innerHTML = '<div class="empty">No rows to display.</div>';
      } else {
        document.getElementById("grid").innerHTML =
          '<table><thead><tr>' +
          '<th class="row-number-header">No.</th>' +
          columns.map(headerHtml).join("") +
          '</tr></thead><tbody>' +
          (rows.length
            ? rows.map(({ row, rowNumber }, rowIndex) => '<tr><td class="row-number-cell">' + rowNumber + '</td>' + columns.map((column, columnIndex) => '<td class="data-cell" data-cell-row="' + rowIndex + '" data-cell-column="' + columnIndex + '" title="' + escape(cellValue(row, column)) + '">' + escape(cellValue(row, column)) + '</td>').join("") + '</tr>').join("")
            : '<tr><td class="empty-cell" colspan="' + (columns.length + 1) + '">No rows match the current filters.</td></tr>') +
          '</tbody></table>';
      }
      document.querySelectorAll("[data-sort]").forEach((header) => {
        header.addEventListener("click", () => {
          const column = header.dataset.sort;
          if (sort.column === column) sort.direction = sort.direction === "asc" ? "desc" : "asc";
          else sort = { column, direction: "asc" };
          renderGrid();
        });
      });
      document.querySelectorAll("[data-filter-op]").forEach((select) => {
        select.addEventListener("change", () => {
          const column = select.dataset.filterOp;
          filters[column] = { ...(filters[column] || {}), operator: select.value };
          renderGrid();
        });
      });
      document.querySelectorAll("[data-filter-value]").forEach((input) => {
        input.addEventListener("input", () => {
          const column = input.dataset.filterValue;
          const defaultOperator = isNumericColumn(column) ? "eq" : "contains";
          filters[column] = { operator: filters[column]?.operator || defaultOperator, value: input.value };
          renderGrid();
        });
        input.addEventListener("click", (event) => event.stopPropagation());
      });
      bindCellSelection();
      if (activeFilterColumn) {
        const nextActive = document.querySelector('[data-filter-value="' + CSS.escape(activeFilterColumn) + '"]');
        if (nextActive) {
          nextActive.focus();
          if (activeSelectionStart !== null && activeSelectionEnd !== null) {
            nextActive.setSelectionRange(activeSelectionStart, activeSelectionEnd);
          }
        }
      }
    }

    function selectionBounds() {
      if (!cellSelection) return null;
      return {
        firstRow: Math.min(cellSelection.startRow, cellSelection.endRow),
        lastRow: Math.max(cellSelection.startRow, cellSelection.endRow),
        firstColumn: Math.min(cellSelection.startColumn, cellSelection.endColumn),
        lastColumn: Math.max(cellSelection.startColumn, cellSelection.endColumn),
      };
    }

    function paintCellSelection() {
      const bounds = selectionBounds();
      document.querySelectorAll(".data-cell").forEach((cell) => {
        const row = Number(cell.dataset.cellRow);
        const column = Number(cell.dataset.cellColumn);
        cell.classList.toggle("cell-selected", Boolean(bounds) && row >= bounds.firstRow && row <= bounds.lastRow && column >= bounds.firstColumn && column <= bounds.lastColumn);
      });
    }

    function bindCellSelection() {
      cellSelection = null;
      isSelectingCells = false;
      document.querySelectorAll(".data-cell").forEach((cell) => {
        cell.addEventListener("mousedown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
            document.activeElement.blur();
          }
          isSelectingCells = true;
          const row = Number(cell.dataset.cellRow);
          const column = Number(cell.dataset.cellColumn);
          cellSelection = { startRow: row, endRow: row, startColumn: column, endColumn: column };
          paintCellSelection();
        });
        cell.addEventListener("mouseenter", () => {
          if (!isSelectingCells || !cellSelection) return;
          cellSelection.endRow = Number(cell.dataset.cellRow);
          cellSelection.endColumn = Number(cell.dataset.cellColumn);
          paintCellSelection();
        });
      });
    }

    function selectedCellsText() {
      const bounds = selectionBounds();
      if (!bounds) return "";
      const lines = [];
      for (let row = bounds.firstRow; row <= bounds.lastRow; row += 1) {
        const values = [];
        for (let column = bounds.firstColumn; column <= bounds.lastColumn; column += 1) {
          const cell = document.querySelector('[data-cell-row="' + row + '"][data-cell-column="' + column + '"]');
          values.push(cell?.textContent || "");
        }
        lines.push(values.join("\\t"));
      }
      return lines.join("\\n");
    }

    function downloadCsv() {
      const columns = payload.columns.filter((column) => visibleColumns.has(column));
      const rows = filteredRows();
      const lines = [columns.join(",")].concat(rows.map(({ row }) => columns.map((column) => {
        const value = cellValue(row, column).replace(/"/g, '""');
        return '"' + value + '"';
      }).join(",")));
      const blob = new Blob([lines.join("\\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = payload.title.replace(/\\W+/g, "_") + ".csv";
      link.click();
      URL.revokeObjectURL(url);
    }

    document.getElementById("global-search").addEventListener("input", (event) => {
      globalSearch = event.target.value;
      renderGrid();
    });
    document.getElementById("clear-filters").addEventListener("click", () => {
      filters = {};
      globalSearch = "";
      document.getElementById("global-search").value = "";
      renderGrid();
    });
    document.getElementById("csv").addEventListener("click", downloadCsv);
    viewAllButton.addEventListener("click", loadAllRows);
    document.addEventListener("mouseup", () => { isSelectingCells = false; });
    document.addEventListener("copy", (event) => {
      const text = selectedCellsText();
      if (!text || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
    });
    renderColumns();
    renderGrid();
  </script>
</body>
</html>`);
  viewer.document.close();
  viewer.focus();
}
