import loader from "@monaco-editor/loader";
import * as monaco from "monaco-editor";
import EditorWorker from "../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

loader.config({ monaco });
