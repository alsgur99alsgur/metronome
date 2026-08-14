import { useEffect } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";

const TEXT_NODE_THEME = "metronome-text-node";

export default function TextEditor({ editData, setEditData }) {
  const monaco = useMonaco();
  const backgroundColor = editData.backgroundColor || "#fffde7";
  const textColor = editData.textColor || "#1f2937";
  const fontSize = editData.fontSize || 16;

  useEffect(() => {
    if (!monaco) return undefined;
    monaco.editor.defineTheme(TEXT_NODE_THEME, {
      base: "vs",
      inherit: true,
      rules: [{ token: "", foreground: textColor.replace(/^#/, "") }],
      colors: {
        "editor.background": backgroundColor,
        "editor.foreground": textColor,
        "editorCursor.foreground": textColor,
        "editorLineHighlightBackground": backgroundColor,
      },
    });
    monaco.editor.setTheme(TEXT_NODE_THEME);
    return () => monaco.editor.setTheme("vs");
  }, [backgroundColor, monaco, textColor]);

  return (
    <div className="text-node-editor">
      <div className="text-node-editor-controls">
        <label>
          <span>Background</span>
          <input
            type="color"
            value={backgroundColor}
            onChange={(event) =>
              setEditData((current) => ({
                ...current,
                backgroundColor: event.target.value,
              }))
            }
          />
        </label>
        <label>
          <span>Text</span>
          <input
            type="color"
            value={textColor}
            onChange={(event) =>
              setEditData((current) => ({
                ...current,
                textColor: event.target.value,
              }))
            }
          />
        </label>
        <label>
          <span>Font size</span>
          <input
            type="number"
            min="8"
            max="72"
            step="1"
            value={fontSize}
            onChange={(event) =>
              setEditData((current) => ({
                ...current,
                fontSize: Math.min(72, Math.max(8, Number(event.target.value) || 16)),
              }))
            }
          />
        </label>
      </div>
      <div className="text-node-monaco">
        <Editor
          language="plaintext"
          theme={TEXT_NODE_THEME}
          value={editData.text || ""}
          onChange={(value) =>
            setEditData((current) => ({ ...current, text: value || "" }))
          }
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            wordWrap: "on",
            lineNumbers: "off",
            folding: false,
            glyphMargin: false,
            scrollBeyondLastLine: false,
            fontSize,
          }}
        />
      </div>
    </div>
  );
}
