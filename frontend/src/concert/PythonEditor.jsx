import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import CallMergeOutlinedIcon from "@mui/icons-material/CallMergeOutlined";
import CallSplitOutlinedIcon from "@mui/icons-material/CallSplitOutlined";
import CompressOutlinedIcon from "@mui/icons-material/CompressOutlined";
import FilterAltOutlinedIcon from "@mui/icons-material/FilterAltOutlined";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import MergeTypeOutlinedIcon from "@mui/icons-material/MergeTypeOutlined";
import PlaylistAddOutlinedIcon from "@mui/icons-material/PlaylistAddOutlined";
import SortOutlinedIcon from "@mui/icons-material/SortOutlined";

const safeName = (value) => {
  const safe = (value || "task").replace(/\W+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) return "task";
  return /^\d/.test(safe) ? `task_${safe}` : safe;
};

export const pythonTemplate = (name) =>
  `def func_${safeName(name)}(inputs):
    """
    inputs:
        list[pandas.DataFrame]

    return:
        pandas.DataFrame
    """

    if inputs:
        df = inputs[0]
    else:
        df = pd.DataFrame({"value": [1, 2, 3]})

    result = df
    return result
`;

const pythonPresets = [
  {
    label: "filter",
    Icon: FilterAltOutlinedIcon,
    variants: [
      {
        label: "simple",
        code: `
# Filter rows using a single condition.
condition = df["col1"] == value1
result = df.loc[condition]
`,
      },
      {
        label: "complex",
        code: `

# Filter rows using multiple conditions.

# if col1 = value1 and col2 >= value2 then
#     $False
# else
# if col3 = value3 and col4 >= value4 then
#     col5 = "x"
# else
#     $False
conditions = [
    (df["col1"] == value1) & (df["col2"] >= value2),
    (df["col3"] == value3) & (df["col4"] >= value4),
]
filter_values = [False, df["col5"] == "x"]
condition = np.select(
    conditions,
    filter_values,
    default=False,
)
result = df.loc[condition]
`,
      },
    ],
  },
  {
    label: "assign",
    Icon: PlaylistAddOutlinedIcon,
    variants: [
      {
        label: "simple",
        code: `
# Assign a value using a single condition.
df["col1"] = value1
result = df
`,
      },
      {
        label: "complex",
        code: `
# Assign values to a new or existing column using multiple conditions.

# if col1 = value1 and col2 >= value2 then
#     "x"
# else
# if col3 = value3 and col4 >= value4 then
#     col5 * 2
# else
#     "z"
conditions = [
    (df["col1"] == value1) & (df["col2"] >= value2),
    (df["col3"] == value3) & (df["col4"] >= value4),
]
assign_values = ["x", df["col5"] * 2]
df["col6"] = np.select(
    conditions,
    assign_values,
    default="z",
)
result = df
`,
      },
    ],
  },
  {
    label: "join",
    Icon: MergeTypeOutlinedIcon,
    variants: ["left", "inner", "outer"]
      .map((how) => ({
        label: how,
        code: `
# ${how[0].toUpperCase()}${how.slice(1)} join two inputs.
left_df = inputs[0]
right_df = inputs[1]
result = pd.merge(
    left_df,
    right_df,
    on=["col1", "col2"],
    how="${how}",
)
`,
      }))
      .concat({
        label: "cross",
        code: `
# Cross join creates every possible row pair.
left_df = inputs[0]
right_df = inputs[1]
result = pd.merge(
    left_df,
    right_df,
    how="cross",
)
`,
      }),
  },
  {
    label: "union",
    Icon: CallMergeOutlinedIcon,
    variants: [
      {
        label: "union",
        code: `
# Union two inputs and remove duplicate rows.
left_df = inputs[0]
right_df = inputs[1]
result = pd.concat([left_df, right_df], ignore_index=True).drop_duplicates(
    ignore_index=True,
)
`,
      },
      {
        label: "union all",
        code: `
# Union two inputs and keep duplicate rows.
left_df = inputs[0]
right_df = inputs[1]
result = pd.concat(
    [left_df, right_df],
    ignore_index=True,
)
`,
      },
      {
        label: "minus",
        code: `
# Keep rows that exist only in the left input.
left_df = inputs[0]
right_df = inputs[1]
all_columns = list(left_df.columns)
if set(all_columns) != set(right_df.columns):
    raise ValueError("Both inputs must have the same columns.")
right_df = right_df[all_columns]
result = (
    left_df.merge(
        right_df.drop_duplicates(),
        on=all_columns,
        how="left",
        indicator=True,
    )
    .loc[lambda data: data["_merge"] == "left_only"]
    .drop(columns="_merge")
    .reset_index(drop=True)
)
`,
      },
      {
        label: "intersect",
        code: `
# Keep distinct rows that exist in both inputs.
left_df = inputs[0]
right_df = inputs[1]
all_columns = list(left_df.columns)
if set(all_columns) != set(right_df.columns):
    raise ValueError("Both inputs must have the same columns.")
right_df = right_df[all_columns]
result = (
    left_df.merge(
        right_df.drop_duplicates(),
        on=all_columns,
        how="inner",
    )
    .drop_duplicates(ignore_index=True)
)
`,
      },
      {
        label: "symmetric difference",
        code: `
# Keep distinct rows that exist in only one input.
left_df = inputs[0]
right_df = inputs[1]
all_columns = list(left_df.columns)
if set(all_columns) != set(right_df.columns):
    raise ValueError("Both inputs must have the same columns.")
left_df = left_df[all_columns].drop_duplicates()
right_df = right_df[all_columns].drop_duplicates()
result = (
    left_df.merge(
        right_df,
        on=all_columns,
        how="outer",
        indicator=True,
    )
    .loc[lambda data: data["_merge"] != "both"]
    .drop(columns="_merge")
    .reset_index(drop=True)
)
`,
      },
    ],
  },
  {
    label: "groupby",
    Icon: CompressOutlinedIcon,
    variants: [
      {
        label: "group",
        code: `
# Group rows by multiple columns and aggregate values.
result = df.groupby(
    ["col1", "col2"],
    as_index=False,
).agg(
    # Common functions: "sum", "mean", "median", "min", "max",
    # "count", "size", "nunique", "first", "last",
    # "std", "var", and "prod"
    # String concat example:
    # col3_concat=("col3", lambda values: ",".join(values.fillna("").astype(str)))
    col3_sum=("col3", "sum"),
)
`,
      },
      {
        label: "transform",
        code: `
# Add a group aggregate while preserving the original rows.
result = df
result["col3_sum"] = (
    result.groupby(["col1", "col2"])["col3"]
    # Common functions: "sum", "mean", "median", "min", "max",
    # "count", "size", "nunique", "first", "last",
    # "std", "var", "prod", "rank", "cumsum", "cummin", and "cummax"
    # String concat example:
    # .transform(lambda values: ",".join(values.fillna("").astype(str)))
    .transform("sum")
)
`,
      },
    ],
  },
  {
    label: "sort",
    Icon: SortOutlinedIcon,
    code: `
# Sort rows by one or more columns.
result = df.sort_values(
    by=["col1"],
    ascending=[True],
).reset_index(drop=True)
`,
  },
  {
    label: "split",
    Icon: CallSplitOutlinedIcon,
    code: `
# Split a column and expand each item into its own row.
result = df
result["col1"] = result["col1"].str.split(",")
result = result.explode("col1", ignore_index=True)
`,
  },
];

function ColumnList({ columns = [], emptyText }) {
  return (
    <div className="column-list">
      {columns.length ? (
        columns.map((column) => (
          <div
            className="column-row"
            key={`${column.name}-${column.type}`}
          >
            <span className="column-name">{column.name}</span>
            <span className="column-type">{column.type}</span>
          </div>
        ))
      ) : (
        <div className="column-empty">{emptyText}</div>
      )}
    </div>
  );
}

function InputColumnsPanel({ inputDataframes = [] }) {
  const [activeInputId, setActiveInputId] = useState(null);
  const activeInput =
    inputDataframes.find((input) => input.id === activeInputId) ||
    inputDataframes[0] ||
    null;

  useEffect(() => {
    if (!inputDataframes.length) {
      setActiveInputId(null);
      return;
    }
    if (!inputDataframes.some((input) => input.id === activeInputId)) {
      setActiveInputId(inputDataframes[0].id);
    }
  }, [activeInputId, inputDataframes]);

  return (
    <aside className="column-side-panel">
      <div className="column-title">Input Columns</div>
      {inputDataframes.length ? (
        <>
          <div className="python-input-selector">
            <label htmlFor="python-input-parent">Parent node</label>
            <select
              id="python-input-parent"
              onChange={(event) => setActiveInputId(event.target.value)}
              title={activeInput?.name}
              value={activeInput?.id || ""}
            >
              {inputDataframes.map((input) => (
                <option key={input.id} value={input.id}>
                  {input.name}
                </option>
              ))}
            </select>
          </div>
          <ColumnList
            columns={activeInput?.columns || []}
            emptyText={
              activeInput?.status === "not_run"
                ? "Run parent node to inspect columns."
                : "No DataFrame columns."
            }
          />
        </>
      ) : (
        <ColumnList columns={[]} emptyText="No connected inputs." />
      )}
    </aside>
  );
}

function OutputColumnsPanel({ columns = [], emptyText }) {
  return (
    <aside className="column-side-panel">
      <div className="column-title">Output Columns</div>
      <ColumnList columns={columns} emptyText={emptyText} />
    </aside>
  );
}

export default function PythonEditor({
  editData,
  setEditData,
  searchHighlight,
  inputDataframes = [],
  outputColumns = [],
  outputMessage = "Run this node to inspect output columns.",
}) {
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const decorationIdsRef = useRef([]);
  const presetToolbarRef = useRef(null);
  const [editorReady, setEditorReady] = useState(0);
  const [activePresetMenu, setActivePresetMenu] = useState(null);

  const insertPreset = (preset) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !monaco || !model || !position) return;

    const currentLine = model.getLineContent(position.lineNumber);
    const currentIndentation = currentLine.match(/^\s*/)?.[0] || "";
    const indentation = currentLine.trimEnd().endsWith(":")
      ? `${currentIndentation}    `
      : currentIndentation || "    ";
    const indentedCode = preset.code
      .split("\n")
      .map((line) => (line ? `${indentation}${line}` : line))
      .join("\n");
    const insertColumn = model.getLineMaxColumn(position.lineNumber);
    const insertText = `\n${indentedCode}`;
    const range = new monaco.Range(
      position.lineNumber,
      insertColumn,
      position.lineNumber,
      insertColumn,
    );

    editor.pushUndoStop();
    editor.executeEdits("python-preset", [
      {
        range,
        text: insertText,
        forceMoveMarkers: true,
      },
    ]);
    editor.pushUndoStop();

    const insertedLines = insertText.split("\n");
    const endLineNumber = position.lineNumber + insertedLines.length - 1;
    const endColumn = insertedLines.at(-1).length + 1;
    editor.setPosition({ lineNumber: endLineNumber, column: endColumn });
    editor.revealPositionInCenter({
      lineNumber: endLineNumber,
      column: endColumn,
    });
    editor.focus();
  };

  useEffect(() => {
    if (!activePresetMenu) return undefined;

    const closeOnOutsideClick = (event) => {
      if (!presetToolbarRef.current?.contains(event.target)) {
        setActivePresetMenu(null);
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setActivePresetMenu(null);
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [activePresetMenu]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    decorationIdsRef.current = editor.deltaDecorations(
      decorationIdsRef.current,
      [],
    );
    if (!searchHighlight || searchHighlight.field !== "code") return;

    const range = new monaco.Range(
      searchHighlight.lineNumber,
      searchHighlight.startColumn,
      searchHighlight.lineNumber,
      searchHighlight.endColumn,
    );
    decorationIdsRef.current = editor.deltaDecorations(
      [],
      [
        {
          range,
          options: {
            className: "search-editor-highlight",
            inlineClassName: "search-editor-inline-highlight",
          },
        },
      ],
    );
    editor.revealLineInCenter(searchHighlight.lineNumber);
    editor.setSelection(range);
    editor.focus();
  }, [editorReady, searchHighlight]);

  return (
    <div className="python-editor">
      <div className="node-editor-grid">
        <InputColumnsPanel inputDataframes={inputDataframes} />
        <div className="python-code-panel">
          <div className="python-preset-toolbar" ref={presetToolbarRef}>
            <span className="python-preset-label">Preset:</span>
            {pythonPresets.map((preset) => {
              const PresetIcon = preset.Icon;
              const hasVariants = Boolean(preset.variants?.length);
              const isOpen = activePresetMenu === preset.label;
              return (
                <div className="python-preset-menu" key={preset.label}>
                  <button
                    aria-expanded={hasVariants ? isOpen : undefined}
                    aria-haspopup={hasVariants ? "menu" : undefined}
                    className={`python-preset-button ${isOpen ? "active" : ""}`}
                    onClick={() => {
                      if (!hasVariants) {
                        setActivePresetMenu(null);
                        insertPreset(preset);
                        return;
                      }
                      setActivePresetMenu((current) =>
                        current === preset.label ? null : preset.label,
                      );
                    }}
                    type="button"
                  >
                    <PresetIcon aria-hidden="true" fontSize="inherit" />
                    <span>{preset.label}</span>
                    {hasVariants && (
                      <KeyboardArrowDownIcon
                        aria-hidden="true"
                        className="python-preset-arrow"
                        fontSize="inherit"
                      />
                    )}
                  </button>
                  {hasVariants && isOpen && (
                    <div className="python-preset-dropdown" role="menu">
                      {preset.variants.map((variant) => (
                        <button
                          className="python-preset-option"
                          key={variant.label}
                          onClick={() => {
                            setActivePresetMenu(null);
                            insertPreset(variant);
                          }}
                          role="menuitem"
                          type="button"
                        >
                          {variant.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="monaco-box">
            <Editor
              height="100%"
              defaultLanguage="python"
              theme="vs-light"
              onMount={(editor, monaco) => {
                editorRef.current = editor;
                monacoRef.current = monaco;
                setEditorReady((current) => current + 1);
              }}
              options={{
                fontSize: 14,
                minimap: { enabled: false },
                automaticLayout: true,
                tabSize: 4,
                insertSpaces: true,
              }}
              value={editData.code ?? pythonTemplate(editData.name)}
              onChange={(value) => {
                setEditData((current) => ({
                  ...current,
                  code: value,
                }));
              }}
            />
          </div>
        </div>
        <OutputColumnsPanel columns={outputColumns} emptyText={outputMessage} />
      </div>
    </div>
  );
}
