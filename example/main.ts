import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { initHelixMode, type HelixBinding } from "../src/index.js";
import "../src/styles.css";

(globalThis as unknown as { MonacoEnvironment: object }).MonacoEnvironment = {
  getWorker: (_moduleId: string, label: string) =>
    label === "typescript" || label === "javascript" ? new TypeScriptWorker() : new EditorWorker(),
};

const editor = monaco.editor.create(document.getElementById("editor")!, {
  value: [
    "// Select first, then act.",
    "function greet(name) {",
    '  return `Hello, ${name}!`;',
    "}",
    "",
    'console.log(greet("Helix"));',
    "",
    "// Unicode stays together: 한글 é 👩‍💻 🌏",
  ].join("\n"),
  language: "javascript",
  theme: "vs-dark",
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 16,
});
const status = document.getElementById("status")!;
let binding: HelixBinding | undefined = initHelixMode(editor, status);
document.getElementById("toggle")!.addEventListener("click", event => {
  const button = event.currentTarget as HTMLButtonElement;
  if (binding) { binding.dispose(); binding = undefined; }
  else binding = initHelixMode(editor, status);
  button.textContent = binding ? "Disable Helix" : "Enable Helix";
  editor.focus();
});
editor.focus();
